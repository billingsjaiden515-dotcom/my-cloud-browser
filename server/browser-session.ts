import puppeteer, { Browser, Page } from 'puppeteer-core';
import { spawn, ChildProcess } from 'child_process';
import { getChromiumPath, isChromiumFamily } from './browser-finder.js';
import { spawnTracked, killChild, registerExternalChild } from './process-reaper.js';

export const VIEWPORT_WIDTH = 1280;
export const VIEWPORT_HEIGHT = 800;

export interface FrameCallback {
  (jpegData: Buffer, width: number, height: number): void;
}

/** Detect Puppeteer target-death errors (crash, closed page/browser). */
export function isTargetClosedError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return /targetcloseerror|session closed|target closed|page has been closed|browser has been closed/i.test(msg);
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  index: number;
}

/**
 * Target browser window size, in Xvfb screen pixels.
 *
 * x11grab captures the FULL 1920x1080 display (see startX11Capture), so a
 * window smaller than that leaves a black desktop border in the stream. Every
 * browser is opened at this size so they all look identical: Chromium and
 * Brave via --window-size, Firefox via -width/-height. Keep all three in step.
 *
 * Slightly under the display so the window's own border/shadow is not clipped
 * at the right/bottom edge.
 */
const WANTED_WIN_W = 1900;
const WANTED_WIN_H = 1053;

/**
 * `xdotool search --class` window classes per browser.
 *
 * Firefox: Gecko's main window sets WM_CLASS to "Navigator" ("firefox" is a
 * fallback for builds/WMs that differ). Brave: "brave-browser", the binary
 * name. Chromium: the usual set of names and the crx_ prefix used by
 * Chromium's helper processes.
 *
 * Shared by measureChromeGeometry() and enforceWindowSize() so both resolve
 * the SAME window -- if they used different class lists, the resize could act
 * on one window and the measurement read another.
 */
const WINDOW_CLASSES: Record<string, string[]> = {
  chromium: ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'Chromium', 'crx_'],
  firefox: ['Navigator', 'firefox'],
  brave: ['brave-browser', 'brave'],
};

export class BrowserSession {
  sessionId: string;
  private browser: Browser | null = null;
  private pages: Map<string, Page> = new Map();
  private activePageId: string | null = null;
  private screencastActive = false;
  private frameCallback: FrameCallback | null = null;
  // NOTE: a former `cdpSession: CDPSession | null` field was removed. It was
  // never assigned or read anywhere -- no createCDPSession, no .send(), no CDP
  // command in this file or any other. Capture is ffmpeg x11grab and input is
  // page.mouse/page.keyboard, so nothing ever needed a raw CDP channel.
  private browserType: string;
  private viewportWidth = VIEWPORT_WIDTH;
  private viewportHeight = VIEWPORT_HEIGHT;
  private viewportDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly VIEWPORT_DEBOUNCE_MS = 500;
  private captureInterval: ReturnType<typeof setInterval> | null = null;
  private capturePending = false;
  // Temporary YouTube segment-fetch diagnosis (see startMediaProbe).
  // The reported failure was a FROZEN buffered-range bar (the grey bar): the
  // player played its initial buffer and then never pulled another segment.
  // These fields own the sampler timer so it is always torn down with the
  // session (an earlier polling leak came from an unowned interval).
  // Set MEDIA_PROBE=0 to disable.
  private mediaProbeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly MEDIA_PROBE_MS = Number(process.env.MEDIA_PROBE_MS) || 5000;
  // Last MSE event tail printed, so the sourceopen/sourceended/abort/append-throw
  // history is logged whenever it CHANGES rather than every tick (a healthy run
  // stays readable, a SourceBuffer failure is still impossible to miss).
  private lastMseSig = '';
  private frameCounter = 0;
  // Capture rate is the single biggest CPU lever. Every captured frame costs an
  // MJPEG encode (x11grab), then a JPEG decode + VP8 encode (encoder), plus a
  // full byte copy in Node — all of which compete with Chromium's own software
  // video decode on a 2-vCore host. Capturing FASTER than the pipeline can
  // encode does not improve the stream: those frames are dropped by the
  // encoder's bounded queue, but their CPU cost is still paid, which is what
  // made load climb continuously during video playback until YouTube's player
  // gave up. Override without editing code: CAPTURE_FPS=20 with spare cores.
  private readonly TARGET_FPS = Number(process.env.CAPTURE_FPS) || 12;
  // JPEG quality drives both MJPEG encode and decode cost. 60 was needlessly
  // high for a stream that is re-encoded to VP8 at ~1200k anyway.
  private readonly JPEG_QUALITY = Number(process.env.JPEG_QUALITY) || 50;
  private x11ffmpeg: ChildProcess | null = null;
  // Height of the browser chrome (tab strip / address bar) rendered at the top of
  // the x11grab capture. Headful Chromium draws its own UI, so page viewport
  // coordinates are offset from capture coordinates by this amount.
  private browserChromeTop = 0;
  private readonly DEFAULT_CHROME_TOP = 80; // fallback if measurement fails
  // Window size every browser is forced to (see WANTED_WIN_W/H). Kept as
  // instance fields so enforceWindowSize() reads the same values the launch
  // args are built from.
  private readonly WANTED_WIN_W = WANTED_WIN_W;
  private readonly WANTED_WIN_H = WANTED_WIN_H;

  // Measured window geometry (Xvfb screen coords + size). The x11grab capture
  // region is sized to the window so the video shows chrome + full page with
  // no cut-off, and capture coords map 1:1 onto window coords.
  private winX = 0;
  private winY = 0;
  private winW = VIEWPORT_WIDTH;
  private winH = VIEWPORT_HEIGHT + 80;
  // True once measureChromeGeometry() has actually found and applied a real
  // window geometry. Until then winW/winH are the initialisers above, and
  // startX11Capture() warns rather than silently capturing a cropped region.
  private geometryMeasured = false;
  // Track where the current mouse press was dispatched (x11 chrome vs CDP page).
  // A drag can START in one region and END in the other; the release must be
  // routed to the SAME backend the press went to, or Puppeteer's virtual mouse
  // state desyncs ("'left' is already pressed" / "'left' is not pressed").
  private mousePress: { button: 'left' | 'right' | 'middle'; backend: 'x11' | 'page' } | null = null;
  // Chrome offset: how far the page viewport origin is from the capture origin
  // inside the capture region itself (direct, no rescaling needed).
  // NOTE: a WRONG chrome value shifts ALL page Y coords by the error amount.
  // When in doubt, set CHROME_BROWSER_TOP=0 so clicks pass through unshifted.
  private browserChromeLeft = 0;
  // Window position on the Xvfb root (used for capture-relative click routing).
  //
  // Pointer parking: previously this parked the X11 pointer at (1850,1000),
  // chosen to sit OUTSIDE the captured window so the cursor never appeared in
  // the stream. Now that the capture region is the whole 1920x1080 display,
  // every point on screen is inside the capture, so there is nowhere to park it
  // that stays invisible. Hiding the cursor outright is the only way to keep it
  // out of the video: x11grab has no cursor-suppression option.
  private readonly PARK_X = 1850;
  private readonly PARK_Y = 1000;
  // Set when the page/browser target dies unexpectedly (crash, OOM kill,
  // closed window). Input fast-fails, /api/session/status reports alive:false,
  // and the frontend shows "session ended" instead of spamming
  // TargetCloseError 500s forever.
  private dead = false;
  // True while an intentional stop()/closeTab() is in progress, so the page
  // 'close' events those cause are NOT misread as crashes.
  private stopping = false;
  private closingPages = new WeakSet<Page>();

  constructor(sessionId: string, browserType = 'chromium') {
    this.sessionId = sessionId;
    this.browserType = browserType;
  }

  async launch(): Promise<void> {
    // Import browser-finder dynamically to support multiple browsers
    const { getChromiumPath, getBrowserInfo } = await import('./browser-finder.js');

    // Find the correct executable based on browser type
    let executablePath: string;
    if (this.browserType === 'chromium') {
      // Chromium specifically goes through getChromiumPath(), which caches,
      // honours CHROMIUM_PATH and searches the nix store. Other browsers are
      // resolved by name from getBrowserInfo() below.
      executablePath = getChromiumPath();
    } else {
      const browsers = getBrowserInfo();
      const browser = browsers.find(b => b.name === this.browserType);
      if (!browser?.available) {
        throw new Error(`Browser '${this.browserType}' not found. Available: ${browsers.filter(b => b.available).map(b => b.name).join(', ')}`);
      }
      executablePath = browser.executablePath;
    }

    console.log(`[BrowserSession] Launching ${this.browserType} at: ${executablePath}`);

    // Use headful mode with Xvfb for tab strip visibility
    // Auto-detect Xvfb if DISPLAY not set
    const fs = await import('fs');
    if (!process.env.DISPLAY) {
      // Check for Xvfb lock files
      if (fs.existsSync('/tmp/.X99-lock')) {
        process.env.DISPLAY = ':99';
      } else if (fs.existsSync('/tmp/.X11-unix/X99')) {
        process.env.DISPLAY = ':99';
      }
    }
    const isHeadful = !!process.env.DISPLAY;
    const display = process.env.DISPLAY || ':99';
    
    // Chromium reads --disable-features ONCE: when the switch appears twice on
    // the command line only the first value is parsed and the second is
    // silently discarded. Build a single combined value so both settings take
    // effect instead of one silently canceling the other.
    const disableFeatures = [
      // Under Xvfb there is no window manager, so Chromium can conclude that
      // the only window on the screen is occluded and throttle the renderer
      // behind it -- which starves a media pipeline such as YouTube's.
      'CalculateNativeWinOcclusion',
      ...(isHeadful ? ['SuppressUnsupportedFlagWarning'] : []),
    ].join(',');

    // ── Launch options: per-browser ───────────────────────────────────────
    // Two families only. Chromium-family browsers (Chromium, Brave, and any
    // future Vivaldi/Opera GX) get ONE identical option object below and
    // differ only by executablePath, which is resolved earlier from
    // getBrowserInfo(). Non-Chromium browsers (Firefox) get their own.
    //
    // Firefox runs over WebDriver BiDi, not CDP, and FirefoxLauncher appends
    // `args` VERBATIM to the command line -- it does not filter or translate
    // them -- so handing Firefox Chromium's --disable-* / --no-sandbox flags
    // would feed Gecko flags it cannot parse. Brave is Chromium-based, so it
    // takes the Chromium path verbatim and understands every flag in it.
    //
    // `browser: 'firefox'` (NOT `product: 'firefox'`): in puppeteer-core 25.5.0
    // `product` does not exist in LaunchOptions at all -- zero occurrences in
    // the public type definitions. The supported key is `browser`, typed
    // SupportedBrowser = 'chrome' | 'firefox'. Passing `product` would be
    // silently ignored and Chromium launched instead, which is both wrong and
    // indistinguishable from a Firefox bug at runtime.
    if (!isChromiumFamily(this.browserType)) {
      this.browser = await puppeteer.launch({
        browser: 'firefox',
        executablePath,
        headless: isHeadful ? false : true,
        // Same rationale as Chromium: without null, Puppeteer applies its own
        // viewport override and window.innerWidth/innerHeight stop reporting
        // the real window content area, which is what measureChromeGeometry()
        // depends on.
        defaultViewport: null,
        // Firefox rejects Chromium's command-line flags: FirefoxLauncher appends
        // `args` verbatim to the command line with no filtering or translation
        // (see the note above), so Chromium's --disable-* / --no-sandbox flags
        // would be handed to Gecko unparsed. Only Gecko-native flags appear here.
        //
        // Window size: forces the Firefox window to nearly fill the Xvfb
        // display so it looks the same as Chromium, which is pinned to
        // VIEWPORT_WIDTH x (VIEWPORT_HEIGHT + 80) = 1280x880. Firefox has no
        // equivalent of Chromium's --window-size, so -width/-height are the
        // correct Gecko flags. Verified live: a real Firefox launched with
        // these reports outerWidth/outerHeight = 1900x1060.
        //
        // '=' form rather than space-separated '-width 1900 -height 1060'.
        // Both work and both open about:blank (verified by launching Firefox
        // both ways) -- Puppeteer's about:blank append in
        // FirefoxLauncher.defaultArgs() is only skipped for the space form,
        // but Firefox opens its default page regardless, so the outcome is the
        // same. '=' is kept because it is the unambiguous form for Gecko: a
        // bare '1900' on the command line is a positional argument, and the
        // pairing between flag and value is never ambiguous this way.
        //
        // This does NOT affect chromeTop: that is measured from the real
        // rendered window via xdotool in measureChromeGeometry(), never
        // assumed from these numbers.
        args: ['-width=1900', '-height=1060'],
        extraPrefsFirefox: {
          'browser.shell.checkDefaultBrowser': false,
          'browser.startup.homepage_override.mstone': 'ignore',
          'datareporting.policy.dataSubmissionEnabled': false,
          'toolkit.telemetry.enabled': false,
        },
      });
    } else {
        this.browser = await puppeteer.launch({
          executablePath,
          headless: isHeadful ? false : true,
          // Critical: without this, Puppeteer applies its default 800x600 CDP
          // device-metrics override, and window.innerWidth/innerHeight report the
          // EMULATED size instead of the real window's content area — which broke
          // measureChromeGeometry()'s chrome-offset math (chromeTop=280).
        defaultViewport: null,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          // NOTE: --disable-dev-shm-usage is deliberately ABSENT. It is a Docker
          // workaround for the 64MB /dev/shm of small containers -- it tells
          // Chromium to ignore fast RAM-backed shared memory and route it through
          // disk instead. This host has a 2GB /dev/shm (df -h /dev/shm), so the
          // flag buys nothing while the disk-backed path adds backpressure into
          // the media pipeline, observed as a buffered range that plateaus at
          // buf=60 and stops growing while segments keep downloading.
          // Do not re-add it without first re-checking `df -h /dev/shm`.
          // NOTE: --js-flags=--max-old-space-size=256 is deliberately ABSENT. It
          // caps the V8 old-generation heap at 256MB, which bounds memory use but
          // also bounds YouTube's player: its buffer queue and per-segment metadata
          // live in JS memory on the renderer main thread, and a tight cap adds GC
          // pressure exactly where the media pipeline is already CPU-starved.
          // Let V8 size the heap itself; it is not a fixed constant and the box
          // has 4GB. Do not re-add a heap cap without measuring real usage.
          // --- YouTube ~45s buffer-drain fix -----------------------------------
          // Under Xvfb with no real window manager Chromium mis-detects occlusion
          // and throttles the renderer; that throttling starves YouTube's player
          // and the buffered range drains even though segments are downloading.
          // These pin the renderer to "active" so the media pipeline keeps its
          // share of CPU and timers are not clamped.
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          `--disable-features=${disableFeatures}`,
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-sync',
          '--disable-translate',
          '--metrics-recording-only',
          '--disable-infobars',
          '--disable-notifications',
          '--disable-popup-blocking',
          `--window-position=0,0`,
          // Window size is now matched to the capture region. Since 0694888
          // x11grab captures the FULL 1920x1080 display, so a 1280x880 window
          // leaves a large black desktop border in the stream. Firefox is
          // already launched at 1900x1060 for the same reason; this makes every
          // browser look the same. Keep this in step with the capture region
          // (1920x1080) and with Firefox's -width/-height above.
          //
          // 1900x1053 (not 1060) leaves a few pixels of margin inside the
          // display, matching what Firefox actually reports after its window
          // manager settles the frame.
          '--window-size=1900,1053',
          // Show tab strip in headful mode. SuppressUnsupportedFlagWarning now
          // rides along in `disableFeatures` above -- it must NOT be repeated
          // here as a second --disable-features, or only one of the two survives.
          ...(isHeadful ? [
            '--enable-features=TouchpadOverscrollHistoryNavigation',
          ] : []),
        ],
      });
    }

    // Track the browser process itself so teardown can force-kill it. A
    // graceful close can fail or hang, and a hung browser keeps its content
    // processes alive. Labelled by browserType rather than a hardcoded
    // 'chromium' so the reaper matches the right process family.
    const browserProc = this.browser.process();
    if (browserProc) registerExternalChild(browserProc, this.browserType);

    const pages = await this.browser.pages();
    const page = pages[0] || (await this.browser.newPage());
    await this.setupPage(page);

    // Browser-process death (crash / OOM kill) marks the session dead.
    this.browser.on('disconnected', () => {
      if (!this.stopping) this.markDead('browser process disconnected (crashed or killed)');
    });

    const tabId = this.getPageId(page);
    this.pages.set(tabId, page);
    this.watchPage(page);
    this.activePageId = tabId;

    // ── Session start page ────────────────────────────────────────────────
    // Goal: show the browser's OWN new tab / homepage instead of Google.
    //
    // Blink (Chromium, Brave): `chrome://newtab` IS navigable and verified to
    // land on the real new tab page (Chromium redirects to
    // chrome://new-tab-page/, Brave stays on chrome://newtab/).
    //
    // Gecko (Firefox): the new tab page is NOT reachable through automation.
    // Probed against real Firefox 152 over WebDriver BiDi:
    //   goto('about:newtab')  -> Protocol error (browsingContext.navigate):
    //                            unsupported operation
    //   goto('about:home')    -> same refusal
    //   browser.newPage()     -> about:blank, 39 bytes, NOT the new tab
    //   in-page location.href -> blocked, stays about:blank
    // BiDi refuses every `about:` URL, and Puppeteer's tab creation does not
    // give Gecko its new tab. So there is no route to Firefox's homepage from
    // here.
    //
    // Chrome/Chromium's own behaviour is the tie-breaker: about:blank is also
    // what it opens at startup, so leaving it is consistent with "show the
    // browser's default page" rather than a special case for Firefox.
    if (this.browserType !== 'firefox') {
      const newTabUrl = 'chrome://newtab';
      console.log(`[BrowserSession] Opening new tab for ${this.browserType}: ${newTabUrl}`);
      await page.goto(newTabUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      }).catch(() => {
        return page.goto('about:blank').catch(() => {});
      });
    } else {
      // Left at about:blank. Google is intentionally NOT used as a fallback:
      // this commit exists to stop loading Google, and reintroducing it for
      // Firefox would defeat the change for exactly the browser where the
      // native page is unreachable. Revisit if a future Puppeteer/BiDi exposes
      // Gecko's new tab.
      console.log(
        '[BrowserSession] Firefox: keeping about:blank — its new tab page is not ' +
        'reachable via WebDriver BiDi (all about: URLs are refused)',
      );
    }

    // ── Enforce the window size, then measure ────────────────────────────
    // --window-size is honoured at startup, but a running window manager
    // (openbox is started by scripts/vps-restart.sh) can re-apply its own
    // placement afterwards and silently override it. So the size is VERIFIED
    // and, if it did not stick, forced with `xdotool windowsize` before
    // measureChromeGeometry() runs -- otherwise chromeTop and the click
    // coordinates would be measured against the wrong window.
    if (isHeadful) {
      await this.enforceWindowSize();
    }

    // In headful mode, measure the real window geometry AFTER the initial
    // navigation completes. Measuring before goto() captured about:blank's
    // default 800x600 geometry instead of the real loaded page's content area
    // (the inner raw log's url field proved this: url was "about:blank").
    if (isHeadful) {
      await this.measureChromeGeometry(page);
    }

    // Start sampling the media element's buffered range so a frozen grey bar
    // (the reported symptom) is recorded in server.log with timestamps.
    this.startMediaProbe();

    console.log(`[BrowserSession] Browser launched, session: ${this.sessionId}`);
  }

  private pageIdMap = new WeakMap<Page, string>();
  private pageIdCounter = 0;

  private getPageId(page: Page): string {
    if (!this.pageIdMap.has(page)) {
      this.pageIdMap.set(page, `tab-${++this.pageIdCounter}-${Date.now()}`);
    }
    return this.pageIdMap.get(page)!;
  }

  /**
   * Make the page report AV1 as unsupported, so YouTube negotiates VP9/H.264.
   *
   * Why: this VPS has 2 vCores and no hardware decode, so AV1 is software
   * decoded and cannot keep up in real time. Diagnosis on this box: old H.264
   * videos (e.g. dQw4w9WgXcQ, 2009) play past 100s with no cap, while modern
   * AV1 videos (codec string av01.0.00M.08, seen in the MSE probe log) stop at
   * ~45s. YouTube sees the slow decode, caps the MSE buffer at 60s, then tears
   * the player down. Reporting av01 as unsupported makes it pick a codec this
   * box can actually decode.
   *
   * Installed with evaluateOnNewDocument so it is in place for the very first
   * document, before any site script runs -- YouTube reads codec support while
   * its player boots, so a post-navigation injection would come too late.
   *
   * Scope: only strings containing "av01" are affected. "avc1" (H.264) and
   * "vp09" (VP9) do not contain that substring, so they pass through untouched.
   *
   * Trade-off worth stating plainly: a site whose ONLY renditions are AV1 will
   * not play here. Given AV1 is already undecodable in real time on this box,
   * such a video would stall and fail anyway -- it just fails differently now.
   * Set AV1_SHIM=0 to disable if that ever needs testing.
   */
  private async installAv1Shim(page: Page): Promise<void> {
    if (process.env.AV1_SHIM === '0') return;
    try {
      await page.evaluateOnNewDocument(() => {
        // MediaSource.isTypeSupported: YouTube's primary capability probe.
        const origIsTypeSupported = MediaSource.isTypeSupported.bind(MediaSource);
        MediaSource.isTypeSupported = (mime: string) => {
          if (/av01/i.test(mime)) return false;
          return origIsTypeSupported(mime);
        };

        // canPlayType: the same probe for plain <video> playback. Returning ''
        // (empty string) is the spec's answer for "cannot play this type".
        const origCanPlay = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function (mime: string) {
          if (/av01/i.test(mime)) return '';
          return origCanPlay.call(this, mime);
        };

        // Last-resort guard: if something reaches addSourceBuffer with av01
        // anyway, fail loudly and immediately rather than attaching a
        // SourceBuffer that can never keep up with real time.
        const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
        MediaSource.prototype.addSourceBuffer = function (mime: string) {
          if (/av01/i.test(mime)) {
            throw new DOMException('AV1 unsupported on this device', 'NotSupportedError');
          }
          return origAddSourceBuffer.call(this, mime);
        };
      });
    } catch { /* shim is best-effort; never block session startup */ }
  }

  private async setupPage(page: Page): Promise<void> {
    // Install MediaSource/SourceBuffer instrumentation BEFORE any navigation:
    // evaluateOnNewDocument only applies to documents created after it is
    // called, and YouTube creates its SourceBuffers on the first page load.
    await this.installMseProbe(page);
    // Then the AV1 shim, also before any navigation, so YouTube negotiates a
    // codec this box can decode. installMseProbe patches addSourceBuffer too;
    // the two compose, since each wraps the previous rather than replacing it.
    await this.installAv1Shim(page);
    // In headful/X11 mode, do NOT set an emulated viewport: CDP emulation makes
    // window.innerWidth/innerHeight report the emulated size (1280x800) instead
    // of the real page content area (~1280x720 after the ~80px chrome), which
    // breaks measureChromeGeometry()'s chrome-offset calculation. Only emulate
    // in headless mode, where there is no real window to fight with.
    if (process.env.DISPLAY) return;
    await page.setViewport({
      width: this.viewportWidth,
      height: this.viewportHeight,
      deviceScaleFactor: 1,
    });
  }

  getActivePage(): Page | null {
    // Dead session: never hand out stale page objects — every input dispatch
    // would throw TargetCloseError. Routes translate null into 410
    // session_dead so the frontend can show the reconnect state.
    if (this.dead) return null;
    if (!this.activePageId) return null;
    return this.pages.get(this.activePageId) || null;
  }

  /**
   * Mark the session dead after the page/browser target closed unexpectedly.
   * Called proactively from page 'close'/'error' and browser 'disconnected'
   * events, and reactively from HTTP input routes when a TargetCloseError
   * slips through. Idempotent: the first call wins and triggers teardown so
   * the session disappears from the manager and status flips to not-found.
   */
  markDead(reason: string): void {
    if (this.dead || this.stopping) return;
    this.dead = true;
    console.error(`[BrowserSession] Session ${this.sessionId} marked DEAD: ${reason} (at ${new Date().toISOString()})`);
    // Best-effort teardown (async): stops screencast/encoder and removes the
    // session, which also self-heals the frontend's polling loop.
    void this.stop().catch(() => {});
  }

  isDead(): boolean {
    return this.dead;
  }

  /** Attach crash/close detection to a page. Call for every created page. */
  private watchPage(page: Page): void {
    page.on('close', () => {
      if (this.stopping || this.closingPages.has(page)) return; // intentional
      console.error(`[BrowserSession] Page 'close' event (at ${new Date().toISOString()})`);
      this.markDead('page closed unexpectedly');
    });
    page.on('error', (err: Error) => {
      if (this.stopping) return;
      console.error(`[BrowserSession] Page 'error' (crash) event: ${err.message}`);
      this.markDead(`page crashed: ${err.message}`);
    });

    // --- Diagnostic instrumentation (evidence capture, not a fix) ----------
    // Without these listeners the server is structurally blind to what the
    // remote page reports: a YouTube player fatal error, a MediaSource failure,
    // or an aborted media segment fetch produces NO server.log output at all,
    // so playback failures look "silent". Errors, failed requests and non-2xx
    // media responses are always logged; routine page noise is gated behind
    // PAGE_DEBUG=0 for quieter runs.
    // --- Chromium only: CDP-network events with NO BiDi equivalent ---------
    // The instrumentation above needs page 'request', 'response',
    // 'requestfailed', 'requestfinished', 'framenavigated', 'console' and
    // 'pageerror'. Firefox runs over WebDriver BiDi, which ships no Network
    // module at all: in puppeteer-core 25.5.0 the ONLY PageEvent BiDi ever
    // emits is 'close' (bidi/Page.js:165). The rest are never emitted.
    // Registering them is not an error -- it is SILENT: no throw, the listener
    // simply never fires, and the log goes quiet for the exact failures these
    // listeners were written to catch. So they are gated on browserType rather
    // than left silently registered, which makes the absence explicit in the
    // source instead of looking like a Firefox bug.
    //
    // Known accepted loss for Firefox v1: no segment/media/nav/console
    // tracing. A page.evaluate() based replacement was considered and
    // deliberately rejected as out of scope for this commit.
    //
    // Crash detection is UNAFFECTED: it comes from browser.on('disconnected')
    // and page.on('close'), both emitted by BiDi. Verified live --
    // scripts/firefox-lifecycle-test.mjs SIGKILLs firefox and 'disconnected'
    // fires ~250ms later, so markDead() runs and /api/session/status correctly
    // reports alive:false.
    // Chromium-family check, NOT `=== 'chromium'`: Brave is Chromium-based and
    // speaks CDP, so it gets the identical instrumentation. A BiDi browser
    // would register listeners that never fire.
    if (isChromiumFamily(this.browserType)) {
      const verbose = process.env.PAGE_DEBUG !== '0';
      const ts = () => new Date().toISOString().slice(11, 23);

      page.on('console', (msg) => {
        const type = msg.type();
        const text = msg.text();
        if (type === 'error' || type === 'warn' || type === 'assert') {
          console.error(`[Page:console:${type}] ${ts()} ${text}`);
        } else if (verbose) {
          console.log(`[Page:console:${type}] ${ts()} ${text}`);
        }
      });

      page.on('pageerror', (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Page:pageerror] ${ts()} ${message}`);
      });

      // Segment-fetch lifecycle tracing. The observed signature was a frozen
      // buffered-range bar — the player stopped pulling video data — and the
      // 'response' listener below fires on HEADERS, so on its own it cannot
      // distinguish "the next segment was never requested" from "it was requested
      // and never completed". These listeners pair every googlevideo segment
      // request with its terminal event, so the log shows the last request issued
      // before the stall, its byte count, and whether it finished, failed or
      // simply never appeared again.
      const segState = new WeakMap<object, { id: number; at: number }>();
      let segSeq = 0;
      const isSegment = (url: string) => url.includes('googlevideo.com/videoplayback');

      page.on('request', (req) => {
        if (!isSegment(req.url())) return;
        const id = ++segSeq;
        segState.set(req, { id, at: Date.now() });
        console.log(`[Page:seg] ${ts()} #${id} REQ range=${req.headers()['range'] ?? '-'}`);
      });

      page.on('requestfinished', (req) => {
        if (!isSegment(req.url())) return;
        const st = segState.get(req);
        const ms = st ? Date.now() - st.at : -1;
        const res = req.response();
        const range = res?.headers()['content-range'] ?? '-';
        console.log(`[Page:seg] ${ts()} #${st?.id ?? '?'} DONE ${ms}ms range=${range}`);
      });

      page.on('requestfailed', (req) => {
        const failure = req.failure();
        const st = segState.get(req);
        if (st) {
          // A segment that was issued and died is the strongest possible evidence
          // for "fetch started but never completed".
          console.error(
            `[Page:seg] ${ts()} #${st.id} FAILED ${Date.now() - st.at}ms — ${failure?.errorText ?? 'unknown'}`,
          );
          return;
        }
        console.error(
          `[Page:reqfailed] ${ts()} ${req.resourceType()} ${req.url().slice(0, 140)} — ${failure?.errorText ?? 'unknown'}`,
        );
      });

      // Media traffic is the key signal for duration-correlated playback failure:
      // YouTube streams DASH segments continuously, so a gap or a burst of
      // non-2xx responses in these lines pinpoints the exact second playback
      // breaks, and distinguishes "network fetch stopped" from "player aborted".
      page.on('response', (res) => {
        const url = res.url();
        const status = res.status();
        const type = res.request().resourceType();
        const isMedia = type === 'media' || url.includes('googlevideo.com');
        if (!isMedia) return;
        if (status >= 400) {
          console.error(`[Page:media] ${ts()} HTTP ${status} ${url.slice(0, 140)}`);
        } else if (verbose) {
          console.log(`[Page:media] ${ts()} HTTP ${status} ${type} ${url.slice(0, 120)}`);
        }
      });

      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
          console.log(`[Page:nav] ${ts()} ${frame.url().slice(0, 140)}`);
        }
      });
    } // end browserType === "chromium" diagnostic gate
  }

  /**
   * Install MediaSource / SourceBuffer instrumentation before any navigation.
   *
   * Why this is required: SourceBuffer objects are NOT reachable from the
   * <video> element, so a listener-based probe cannot see them at all. The only
   * way to observe append failures is to patch the MSE interfaces themselves
   * before the site's player builds its SourceBuffers.
   *
   * The reported symptom — buffered range frozen at 60s while videoplayback
   * segments keep completing normally, then a hard reset of the element
   * (t=0, buf=0, paused) — is an APPEND-side failure, so each patch targets a
   * specific way that can happen:
   *
   *   - MediaSource.addSourceBuffer   -> register every SourceBuffer created
   *   - MediaSource.addEventListener  -> capture sourceopen/sourceended/
   *                                      sourceclose (an EARLY sourceended
   *                                      stops the buffered range growing for
   *                                      good, with downloads still succeeding)
   *   - MediaSource.endOfStream       -> log duration+reason at the call itself
   *   - SourceBuffer.appendBuffer     -> count appends and capture THROWN
   *                                      errors (e.g. QuotaExceededError) that a
   *                                      player is free to swallow silently
   *   - SourceBuffer.remove           -> removals can carve gaps into the range
   *   - error/abort/updateend         -> every terminal append event, recorded
   *
   * Deliberately NOT intercepted: the `onsourceopen`/`onsourceended`/
   * `onsourceclose` PROPERTY handlers. Shadowing those would stop the browser
   * from ever installing the player's own handler, breaking playback outright.
   * Only addEventListener is wrapped, and it always forwards.
   *
   * Purely observational: every original method is still invoked with its
   * original arguments and its return value is passed through unchanged.
   * Live objects are published on window.__cbMse for startMediaProbe() to read.
   * Disable with MEDIA_PROBE=0.
   */
  private async installMseProbe(page: Page): Promise<void> {
    if (process.env.MEDIA_PROBE === '0') return;
    try {
      await page.evaluateOnNewDocument(() => {
        const w = window as any;
        const MS = w.MediaSource;
        const SB = w.SourceBuffer;
        if (!MS || !SB || !MS.prototype || !SB.prototype) return;

        const t0 = Date.now();
        const reg: any = { msObjs: [], sbObjs: [], events: [], endOfStream: [] };
        w.__cbMse = reg;

        const rec = (type: string, detail: string) => {
          reg.events.push({ at: Date.now() - t0, type, detail });
          if (reg.events.length > 300) reg.events.shift();
        };
        const fold = (tr: any) => {
          const out: any[] = [];
          try {
            for (let i = 0; i < tr.length; i++) {
              out.push([Math.round(tr.start(i) * 100) / 100, Math.round(tr.end(i) * 100) / 100]);
            }
          } catch (e) { out.push(['ERR', String(e)]); }
          return out;
        };

        const track = (sb: any, mime: string) => {
          if (reg.sbObjs.some((o: any) => o.sb === sb)) return;
          const entry: any = { i: reg.sbObjs.length, mime, sb, appends: 0, errs: [] };
          reg.sbObjs.push(entry);
          rec('sb.create', `#${entry.i} ${mime}`);
          const note = (kind: string) => {
            entry.errs.push({ at: Date.now() - t0, kind });
            rec('sb.' + kind, `#${entry.i} ${mime}`);
          };
          sb.addEventListener('error', () => note('error'));
          sb.addEventListener('abort', () => note('abort'));
          sb.addEventListener('updateend', () => {
            rec('sb.updateend', `#${entry.i} ranges=${JSON.stringify(fold(sb.buffered))} updating=${sb.updating}`);
          });
        };

        const addSB = MS.prototype.addSourceBuffer;
        MS.prototype.addSourceBuffer = function (mime: string) {
          const sb = addSB.call(this, mime);
          if (reg.msObjs.indexOf(this) === -1) reg.msObjs.push(this);
          rec('ms.addSourceBuffer', mime);
          track(sb, mime);
          return sb;
        };

        const aEL = MS.prototype.addEventListener;
        MS.prototype.addEventListener = function (type: string, fn: any, opts: any) {
          if (!this.__cbHooked) {
            this.__cbHooked = true;
            if (reg.msObjs.indexOf(this) === -1) reg.msObjs.push(this);
            const self = this;
            for (const t of ['sourceopen', 'sourceended', 'sourceclose']) {
              aEL.call(self, t, () => {
                rec('ms.' + t, `readyState=${self.readyState} duration=${self.duration}`);
              });
            }
          }
          return aEL.call(this, type, fn, opts);
        };

        const eos = MS.prototype.endOfStream;
        MS.prototype.endOfStream = function (reason?: any) {
          const d = Number(this.duration);
          reg.endOfStream.push({ at: Date.now() - t0, duration: d, reason: String(reason ?? '') });
          rec('ms.endOfStream', `duration=${d} reason=${reason ?? ''}`);
          return eos.call(this, reason);
        };

        const append = SB.prototype.appendBuffer;
        SB.prototype.appendBuffer = function (data: any) {
          const entry = reg.sbObjs.find((o: any) => o.sb === this);
          if (entry) entry.appends++;
          try {
            return append.call(this, data);
          } catch (err: any) {
            const kind = (err && err.name) || String(err);
            if (entry) entry.errs.push({ at: Date.now() - t0, kind: 'append:' + kind });
            rec('sb.appendThrew', `${entry ? '#' + entry.i : '?'} ${kind} bytes=${data && data.byteLength}`);
            throw err;
          }
        };

        const remove = SB.prototype.remove;
        SB.prototype.remove = function (start: number, end: number) {
          const entry = reg.sbObjs.find((o: any) => o.sb === this);
          rec('sb.remove', `${entry ? '#' + entry.i : '?'} ${start}-${end}`);
          return remove.call(this, start, end);
        };

        rec('installed', 'MSE probe active');
      });
    } catch { /* instrumentation is best-effort; never block launch */ }
  }

  /**
   * Sample the active page's media element AND every MediaSource/SourceBuffer
   * every MEDIA_PROBE_MS.
   * Observed failure this must explain: the buffered range freezes at ~60s
   * while videoplayback segments keep completing successfully, then the element
   * hard-resets (t=0, buf=0, paused). Download health is therefore NOT the
   * problem, so the probe must separate three possibilities:
   *   (a) data is appended into a DISCONTINUOUS 2nd range that never merges
   *       with the 1st -> EVERY range is logged, per SourceBuffer and on the
   *       element, because a single end() value hides this completely;
   *   (b) data is appended but rejected -> per-SourceBuffer append counts,
   *       error/abort history and endOfStream() calls from installMseProbe();
   *   (c) the player gave up -> video.error (code+message), readyState /
   *       networkState, and the hard-reset transition itself.
   *
   * Evidence capture only — it never changes playback. Best-effort and
   * self-cleaning: failures are swallowed and the timer is stopped in stop().
   */
  private startMediaProbe(): void {
    if (process.env.MEDIA_PROBE === '0') return;
    if (this.mediaProbeTimer) return;
    this.lastMseSig = '';
    this.mediaProbeTimer = setInterval(() => {
      const page = this.getActivePage();
      if (!page || page.isClosed()) return;
      void page.evaluate(() => {
        const w = window as any;
        // EVERY range, not just the last end: a 2nd discontinuous range is the
        // whole point of this probe, and end() alone cannot reveal it.
        const fold = (tr: any) => {
          const out: any[] = [];
          try {
            for (let i = 0; i < tr.length; i++) {
              out.push([Math.round(tr.start(i) * 100) / 100, Math.round(tr.end(i) * 100) / 100]);
            }
          } catch (e) { out.push(['ERR', String(e)]); }
          return out;
        };
        const mse = w.__cbMse;
        const sbs = ((mse && mse.sbObjs) || []).map((o: any) => ({
          id: o.i,
          mime: String(o.mime).replace(/^video\/mp4.*/, 'v').replace(/^audio\/mp4.*/, 'a'),
          ranges: fold(o.sb.buffered),
          updating: !!o.sb.updating,
          appends: o.appends,
          errs: (o.errs || []).slice(-6),
        }));
        const mss = ((mse && mse.msObjs) || []).map((s: any) => {
          const d = Number(s.duration);
          return { ready: s.readyState, dur: isFinite(d) ? Math.round(d * 10) / 10 : String(s.duration) };
        });
        const v = document.querySelector('video');
        if (!v) return null;
        const dur = Number(v.duration);
        return {
          t: Math.round(v.currentTime * 100) / 100,
          ranges: fold(v.buffered),
          dur: isFinite(dur) ? Math.round(dur * 10) / 10 : String(v.duration),
          rdy: v.readyState,
          net: v.networkState,
          paused: v.paused,
          vis: document.visibilityState,
          focus: document.hasFocus(),
          err: v.error ? `code=${v.error.code} msg=${v.error.message}` : '',
          sbs,
          mss,
          eos: ((mse && mse.endOfStream) || []).slice(-3),
          evts: ((mse && mse.events) || []).slice(-8),
        };
      }).then((s: any) => {
        if (!s) return;
        const now = new Date().toISOString().slice(11, 23);
        const ends = s.ranges
          .filter((r: any) => typeof r[1] === 'number')
          .map((r: any) => r[1]);
        const bufEnd = ends.length ? Math.max(...ends) : 0;
        const ahead = (bufEnd - s.t).toFixed(1);
        console.log(
          `[Page:probe] ${now} t=${s.t} dur=${s.dur} buf=${bufEnd} nranges=${s.ranges.length} ahead=${ahead} ` +
          `rdy=${s.rdy} net=${s.net} vis=${s.vis} focus=${s.focus}${s.paused ? ' PAUSED' : ''}` +
          (s.err ? ` ERR(${s.err})` : ''),
        );
        // Element aggregate AND each SourceBuffer's own ranges: the aggregate
        // can mask a per-track gap, so both are logged every tick.
        console.log(
          `[Page:mse] ${now} elem=${JSON.stringify(s.ranges)} ` +
          `sb=${JSON.stringify(s.sbs)} ms=${JSON.stringify(s.mss)}`,
        );
        // The MSE event/endOfStream history prints only when it CHANGES, so a
        // healthy run stays readable while a sourceended / abort / append-throw
        // is impossible to miss.
        const sig = JSON.stringify(s.evts) + '|' + JSON.stringify(s.eos);
        if (sig !== this.lastMseSig) {
          this.lastMseSig = sig;
          console.error(
            `[Page:mse:evt] ${now} eos=${JSON.stringify(s.eos)} evts=${JSON.stringify(s.evts)}`,
          );
        }
      }).catch(() => { /* page navigating/closed */ });
    }, this.MEDIA_PROBE_MS);
  }

  private stopMediaProbe(): void {
    if (this.mediaProbeTimer) {
      clearInterval(this.mediaProbeTimer);
      this.mediaProbeTimer = null;
    }
  }

  onFrame(callback: FrameCallback): void {
    this.frameCallback = callback;
  }

  /**
   * Start continuous frame capture.
   * In headful mode (DISPLAY set), uses x11grab to capture full browser UI including tabs.
   * In headless mode, uses page.screenshot() at the target FPS.
   */
  async startScreencast(): Promise<void> {
    if (this.screencastActive) await this.stopScreencast();
    this.screencastActive = true;

    // Use x11grab when DISPLAY is set (headful mode) to capture full browser chrome + tabs
    if (process.env.DISPLAY) {
      console.log('[BrowserSession] Using x11grab capture (headful mode)');
      this.startX11Capture();
    } else {
      console.log('[BrowserSession] Using page screenshot capture (headless mode)');
      const intervalMs = 1000 / this.TARGET_FPS;
      this.scheduleNextCapture();
      this.captureInterval = setInterval(() => {
        this.scheduleNextCapture();
      }, intervalMs);
    }
  }

  private x11recvBuf: Buffer = Buffer.alloc(0);

  /**
   * Start a persistent FFmpeg process for continuous x11grab capture.
   * This captures the FULL Chromium browser UI including tabs, address bar.
   * Uses a single persistent process — much faster than spawning per-frame.
   */
  private startX11Capture(): void {
    const display = process.env.DISPLAY || ':99';
    // ── Capture the FULL Xvfb display, not the measured window ──────────────
    // The Xvfb root contains only the browser during a session, so there is
    // nothing else in frame to crop out. Capturing the whole display at (0,0)
    // is what makes Firefox's tab bar visible: when
    // browser.tabs.inTitlebar is enabled Firefox draws the tab strip ABOVE its
    // client area but the xdotool window bounds do not always include that
    // strip, so a window-sized region could start below the tabs and silently
    // cut them off. The display cannot cut off anything above the window.
    //
    // Chromium is unaffected: its window is 1280x880 inside a 1920x1080 root,
    // so the stream simply gains the surrounding desktop. That is the
    // trade-off of this approach and it is deliberate.
    //
    // CPU COST: this feeds the encoder 1920x1080 instead of 1280x880 -- 2.07M
    // pixels/frame vs 1.13M, ~1.8x the MJPEG encode, JPEG decode and VP8
    // encode on a 2-vCore box that is already the bottleneck. The encoder
    // restarts itself once on the first frame to pick up the new size
    // (webrtc-streamer.ts:304-318), so it is handled, but this is a real
    // increase in per-frame cost and is the main thing to watch after deploy.
    const DISPLAY_W = 1920;
    const DISPLAY_H = 1080;
    // Measured window geometry is still logged for diagnosis, and still
    // required for click routing (x11Click) and chrome offsets, but it no
    // longer determines the capture rectangle.
    const width = DISPLAY_W;
    const height = DISPLAY_H;
    const capX = 0;
    const capY = 0;
    const fps = this.TARGET_FPS;

    // MJPEG's -q:v is only meaningful in the 1-31 range (lower = better quality).
    // FFmpeg silently clamps anything outside it, so log the exact value being
    // passed rather than assuming JPEG_QUALITY maps where we think it does.
    const qscale = Math.round((100 - this.JPEG_QUALITY) / 10);
    // Log the exact region handed to ffmpeg. This is the line to check when
    // diagnosing cropping: it must show the browser's real window size, not
    // 1280x880. Verify live with:
    //   ps aux | grep x11grab
    console.log(
      `[BrowserSession] x11grab region: ${width}x${height}+${capX},${capY} ` +
      `on ${display} (full display; browser=${this.browserType}, ` +
      `measured window=${this.winW}x${this.winH}+${this.winX},${this.winY}, measured=${this.geometryMeasured})`,
    );
    console.log(
      `[BrowserSession] x11grab: -q:v ${qscale} (JPEG_QUALITY=${this.JPEG_QUALITY}, valid mjpeg range 1-31)`
    );

    // Persistent FFmpeg process: x11grab -> raw BGR frames -> JPEG pipe
    // Using rawvideo + mjpeg in one process avoids per-frame startup overhead
    // Mid-session resize: NOT handled. The x11grab region is fixed at
    // startX11Capture() and ffmpeg keeps grabbing the original rectangle, so if
    // the window is resized, maximised or restored afterwards the stream shows
    // a stale region (cropped, or padded with desktop). In practice nothing
    // resizes the window mid-session -- the size comes from the launch args and
    // the user drives the page, not the window -- so re-measuring would add a
    // restart/teardown path for a case that does not occur. A session restart
    // (or a new session) re-measures. If that ever changes, the fix is to
    // re-run measureChromeGeometry() and restart capture with the new region,
    // guarded so it cannot thrash on every spurious geometry read.
    this.x11ffmpeg = spawnTracked('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'x11grab',
      '-video_size', `${width}x${height}`,
      '-framerate', String(fps),
      '-i', `${display}+${capX},${capY}`,
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', String(qscale),
      'pipe:1',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // spawnTracked forces detached: true -> own process group.
    }, 'ffmpeg-x11grab');

    this.x11recvBuf = Buffer.alloc(0);

    // Park the X11 pointer outside the captured region so it never appears in the
    // stream (page hover/click state is driven by Puppeteer's virtual mouse).
    this.parkX11Cursor();

    this.x11ffmpeg!.stdout!.on('data', (chunk: Buffer) => {
      this.x11recvBuf = Buffer.concat([this.x11recvBuf, chunk]);
      this.extractJpegFrames();
    });

    this.x11ffmpeg!.stderr!.on('data', (chunk: Buffer) => {
      // Only log errors, not every frame
    });

    this.x11ffmpeg!.on('close', (code: number) => {
      if (this.screencastActive) {
        console.error(`[BrowserSession] x11grab process exited unexpectedly (code ${code})`);
      }
      this.x11ffmpeg = null;
    });

    this.x11ffmpeg!.on('error', (err: Error) => {
      console.error(`[BrowserSession] x11grab process error: ${err.message}`);
      this.x11ffmpeg = null;
    });
  }

  /**
   * Extract complete JPEG frames from the receive buffer.
   * JPEG files start with FF D8 FF and end with FF D9.
   * We look for the JPEG end marker to extract complete frames.
   */
  private extractJpegFrames(): void {
    // JPEG markers: FF D8 = start, FF D9 = end
    const JPEG_START = Buffer.from([0xFF, 0xD8, 0xFF]);
    const JPEG_END = Buffer.from([0xFF, 0xD9]);

    let startIdx: number;
    while ((startIdx = this.x11recvBuf.indexOf(JPEG_START)) !== -1) {
      // Find the end marker after this start
      const endIdx = this.x11recvBuf.indexOf(JPEG_END, startIdx + 3);
      if (endIdx === -1) break; // Incomplete frame, wait for more data

      // Extract the complete JPEG (including end marker)
      const jpegEnd = endIdx + 2;
      const frame = Buffer.from(this.x11recvBuf.subarray(startIdx, jpegEnd));

      // Remove processed data from buffer
      this.x11recvBuf = this.x11recvBuf.subarray(jpegEnd);

      // Deliver frame (frame dims = window size so encoder/frontend size match)
      this.frameCounter++;
      if (this.frameCallback) {
        this.frameCallback(frame, this.winW, this.winH);
      }
      if (this.frameCounter % 30 === 0) {
        console.log(`[BrowserSession] Captured ${this.frameCounter} frames (session ${this.sessionId})`);
      }
    }

    // Prevent buffer from growing unbounded if frames are malformed
    if (this.x11recvBuf.length > 10 * 1024 * 1024) {
      console.warn(`[BrowserSession] Frame buffer too large, clearing`);
      this.x11recvBuf = Buffer.alloc(0);
    }
  }

  /**
   * Capture a single frame using page.screenshot() for headless mode.
   */
  private async scheduleNextCapture(): Promise<void> {
    if (!this.screencastActive || this.capturePending) return;
    this.capturePending = true;
    try {
      const page = this.getActivePage();
      if (!page) return;
      const jpeg = await page.screenshot({
        type: 'jpeg',
        quality: this.JPEG_QUALITY,
        encoding: 'binary',
      }) as Buffer;
      this.frameCounter++;
      if (this.frameCallback) {
        this.frameCallback(jpeg, this.viewportWidth, this.viewportHeight);
      }
    } catch (e) {
      // Ignore errors during capture
    } finally {
      this.capturePending = false;
    }
  }

  async stopScreencast(): Promise<void> {
    if (!this.screencastActive) return;
    this.screencastActive = false;
    if (this.captureInterval) {
      clearInterval(this.captureInterval);
      this.captureInterval = null;
    }
    await this.stopX11Capture();
    if (this.frameCounter > 0) {
      console.log(`[BrowserSession] Capture stopped after ${this.frameCounter} frames`);
    }
    this.frameCounter = 0;
  }

  /**
   * Kill the x11grab ffmpeg and WAIT for it to exit.
   *
   * This is the worst offender for lingering: it blocks waiting for X events,
   * so once Xvfb is gone it never writes again and therefore never notices that
   * its stdout reader (this process) has died -- no broken pipe, no EOF, no
   * exit. A lone SIGTERM left it running forever.
   */
  private async stopX11Capture(): Promise<void> {
    const proc = this.x11ffmpeg;
    this.x11ffmpeg = null;
    this.x11recvBuf = Buffer.alloc(0);
    if (proc) {
      await killChild(proc, 'ffmpeg-x11grab');
    }
  }

  getViewport(): { width: number; height: number } {
    return { width: this.viewportWidth, height: this.viewportHeight };
  }

  /**
   * Update the browser viewport and restart screencast if active.
   * Used for responsive resolution.
   * 
   * IMPORTANT: Small changes (< 20px) are ignored to prevent resize loops
   * caused by video element CSS changes triggering ResizeObserver.
   */
  setViewport(width: number, height: number): void {
    // In headful mode (Xvfb), NEVER change the viewport — the Chromium window size is
    // fixed by --window-size at launch and the Xvfb display has the same dimensions.
    // Calling page.setViewport() physically resizes the window, which triggers
    // CDP layout changes that cause violent resize loops and screencast restarts.
    if (process.env.DISPLAY) {
      return;
    }

    // Headless mode: clamp to reasonable bounds
    width = Math.max(320, Math.min(1920, Math.round(width)));
    height = Math.max(240, Math.min(1080, Math.round(height)));
    if (width % 2 !== 0) width++;
    if (height % 2 !== 0) height++;

    // Skip tiny changes to prevent resize loops
    if (Math.abs(width - this.viewportWidth) < 20 && Math.abs(height - this.viewportHeight) < 20) return;
    if (width === this.viewportWidth && height === this.viewportHeight) return;

    if (this.viewportDebounceTimer) clearTimeout(this.viewportDebounceTimer);
    this.viewportDebounceTimer = setTimeout(async () => {
      this.viewportDebounceTimer = null;
      const wasScreencasting = this.screencastActive;
      if (wasScreencasting) await this.stopScreencast();
      this.viewportWidth = width;
      this.viewportHeight = height;
      const page = this.getActivePage();
      if (page) await page.setViewport({ width, height, deviceScaleFactor: 1 }).catch(() => {});
      if (wasScreencasting) await this.startScreencast();
    }, this.VIEWPORT_DEBOUNCE_MS);
  }

  // ─── Window geometry ────────────────────────────────────────────────────────

  /**
   * Measure the real Chromium window geometry (position + size) and compute how
   * far the page viewport origin sits from the capture origin (chrome offset).
   * Uses xdotool window geometry; falls back to sensible defaults if unavailable.
   */
  private async measureChromeGeometry(page: Page): Promise<void> {
    // Env override for chrome top always wins (manual fine-tuning).
    const envTop = process.env.CHROME_BROWSER_TOP;
    if (envTop) this.browserChromeTop = Math.max(0, parseInt(envTop, 10) || 0);

    // Window classes live at module scope (WINDOW_CLASSES) so
    // enforceWindowSize() and this function always resolve the same window.
    // An unknown browser falls back to the Chromium list.
    const classes = WINDOW_CLASSES[this.browserType]
      ?? WINDOW_CLASSES.chromium;

    for (const cls of classes) {
      const geo = await this.xdotoolWindowGeometry(cls);
      if (!geo) continue;
      this.winX = geo.X;
      this.winY = geo.Y;
      this.winW = geo.WIDTH;
      this.winH = geo.HEIGHT;
      this.geometryMeasured = true;

      // Measure the REAL physical page area inside the window. Raw measurement
      // is logged first (value + emulation state + timing): the previous
      // deploy measured 800x600, suspiciously Puppeteer's DEFAULT emulated
      // viewport, so we must see WHAT is measured, on WHICH page, and WHEN
      // relative to page load before trusting it.
      const inner = await page.evaluate(() => ({
        w: window.innerWidth,
        h: window.innerHeight,
        outerW: window.outerWidth,
        outerH: window.outerHeight,
        dpr: window.devicePixelRatio,
        readyState: document.readyState,
        sinceNavMs: Math.round(performance.now()),
        url: location.href,
      })).catch(() => null);
      const emulated = page.viewport();
      console.log(
        `[Geometry] inner raw: ${inner ? JSON.stringify(inner) : 'EVALUATE_FAILED'} | ` +
        `emulatedViewport=${emulated ? `${emulated.width}x${emulated.height}` : 'none'} | ` +
        `capturedAt=${new Date().toISOString()}`,
      );
      if (inner && inner.w > 0 && inner.h > 0) {
        // Page area is bottom-right aligned inside the window (no bottom chrome).
        // chrome offset = window size - page area.
        this.browserChromeTop = Math.max(0, geo.HEIGHT - inner.h);
        this.browserChromeLeft = Math.max(0, geo.WIDTH - inner.w);
        this.viewportWidth = inner.w;
        this.viewportHeight = inner.h;
        console.log(
          `[BrowserSession] REAL geometry: window=${geo.WIDTH}x${geo.HEIGHT} ` +
          `innerPage=${inner.w}x${inner.h} chromeTop=${this.browserChromeTop} chromeLeft=${this.browserChromeLeft}`,
        );
        // Cross-check the chrome height against Chromium's OWN accounting:
        // outerHeight - innerHeight. outerHeight includes the tab strip +
        // omnibox AND the "Chrome is being controlled" infobar (~40px), so a
        // value near 143 is plausibly EXACT — not a measurement error. If the
        // two sources agree, geometry is correct and any residual in-page
        // click misses live in the dispatch path, not in this number.
        const chromeByChromium = inner.outerH - inner.h;
        const chromeByXdotool = geo.HEIGHT - inner.h;
        console.log(
          `[Geometry] chrome cross-check: byXdotool=${chromeByXdotool}px vs ` +
          `byChromiumOuterInner=${chromeByChromium}px (outer=${inner.outerH}) — ` +
          `${chromeByXdotool === chromeByChromium ? 'MATCH, chromeTop is exact' : 'MISMATCH, investigate window bounds'}`,
        );
      }
      break;
    }

    // Clamp the capture region to the Xvfb display (1920x1080).
    //
    // Size: a window larger than the display (or a stale 1900x1053 Firefox on a
    // smaller screen) must be cropped to the display, or ffmpeg fails to grab
    // pixels that do not exist and the pipe dies with no frames.
    //
    // Position: xdotool can report a NEGATIVE or off-screen origin -- openbox
    // happily places a window partly off the root, and a maximised/restored
    // window can report an origin beyond the display. x11grab rejects a
    // negative offset outright ("Invalid absolute x coordinate"), so the
    // origin is clamped into the display and the region is then reduced so
    // x+w and y+h still fit INSIDE it. Clamping the origin without shrinking
    // the size would just move the crop.
    const DISPLAY_W = 1920;
    const DISPLAY_H = 1080;
    const rawW = this.winW;
    const rawH = this.winH;
    const rawX = this.winX;
    const rawY = this.winY;
    this.winX = Math.max(0, Math.min(this.winX, DISPLAY_W - 1));
    this.winY = Math.max(0, Math.min(this.winY, DISPLAY_H - 1));
    this.winW = Math.max(1, Math.min(this.winW, DISPLAY_W - this.winX));
    this.winH = Math.max(1, Math.min(this.winH, DISPLAY_H - this.winY));
    if (this.winX !== rawX || this.winY !== rawY || this.winW !== rawW || this.winH !== rawH) {
      console.log(
        `[Geometry] capture region clamped: ${rawW}x${rawH}+${rawX},${rawY} -> ` +
        `${this.winW}x${this.winH}+${this.winX},${this.winY} (display ${DISPLAY_W}x${DISPLAY_H})`,
      );
    }

    console.log(
      `[BrowserSession] Geometry: window ${this.winW}x${this.winH} at (${this.winX},${this.winY}) ` +
      `chromeTop=${this.browserChromeTop}px chromeLeft=${this.browserChromeLeft}px ` +
      `page=${this.viewportWidth}x${this.viewportHeight} (set CHROME_BROWSER_TOP to tune)`,
    );
  }

  /** Query window geometry for a WM_CLASS via xdotool (best-effort). */
  /**
   * Verify the browser window actually opened at the intended size, and force
   * it with `xdotool windowsize` if it did not.
   *
   * Why this exists: `--window-size` is applied at startup, but a running
   * window manager (openbox) can re-place the window afterwards, and Chromium
   * sometimes falls back to its default size under Xvfb. The capture region is
   * the full 1920x1080 display, so a window that silently stayed 1280x880 shows
   * up as a black desktop border in the stream. Verifying beats assuming.
   *
   * Runs BEFORE measureChromeGeometry() so chromeTop and the click-coordinate
   * maths are computed against the final window size.
   *
   * Best-effort: needs xdotool and DISPLAY. Failures are logged, never thrown,
   * because a window we could not resize is a cosmetic/geometry-accuracy issue
   * and must not prevent the session from starting.
   */
  private async enforceWindowSize(): Promise<void> {
    if (!process.env.DISPLAY) return;
    const classes = WINDOW_CLASSES[this.browserType] ?? WINDOW_CLASSES.chromium;
    for (const cls of classes) {
      const geo = await this.xdotoolWindowGeometry(cls);
      if (!geo) continue;
      const id = geo.id;
      if (geo.WIDTH === this.WANTED_WIN_W && geo.HEIGHT === this.WANTED_WIN_H) {
        console.log(`[Window] ${this.browserType} already ${geo.WIDTH}x${geo.HEIGHT} — --window-size honoured`);
      } else {
        console.log(
          `[Window] ${this.browserType} opened ${geo.WIDTH}x${geo.HEIGHT}, forcing ` +
          `${this.WANTED_WIN_W}x${this.WANTED_WIN_H} with xdotool windowsize`,
        );
        await new Promise<void>((resolve) => {
          try {
            const p = spawn(
              'xdotool',
              ['windowsize', String(id), String(this.WANTED_WIN_W), String(this.WANTED_WIN_H)],
              { stdio: 'ignore' },
            );
            p.on('error', () => resolve());
            p.on('close', () => resolve());
            setTimeout(resolve, 3000);
          } catch { resolve(); }
        });
      }
      // Moving to 0,0 as well: a window offset from the origin would leave a
      // gap on two sides of the capture instead of one.
      await new Promise<void>((resolve) => {
        try {
          const p = spawn('xdotool', ['windowmove', String(id), '0', '0'], { stdio: 'ignore' });
          p.on('error', () => resolve());
          p.on('close', () => resolve());
          setTimeout(resolve, 3000);
        } catch { resolve(); }
      });
      return;
    }
    console.warn(
      `[Window] could not find a ${this.browserType} window to resize — ` +
      `leaving geometry to measureChromeGeometry()`,
    );
  }

  private async xdotoolWindowGeometry(cls: string): Promise<{ id: string; X: number; Y: number; WIDTH: number; HEIGHT: number } | null> {
    return new Promise((resolve) => {
      try {
        // xdotool search --class matches MULTIPLE windows: the real browser
        // window AND tiny helper/internal windows (e.g. 10x10). --onlyone
        // blindly took the first match (a helper), so geometry was always
        // 10x10 and chromeTop computed 0. Instead: list ALL matches, measure
        // each, and pick the largest above a minimum size — the visible
        // browser window is ~1280x880, helpers are tiny.
        const MIN_W = 200;
        const MIN_H = 200;
        const proc = spawn(
          'xdotool',
          ['search', '--class', cls],
          { stdio: ['ignore', 'pipe', 'ignore'] },
        );
        let ids = '';
        proc.stdout?.on('data', (d: Buffer) => { ids += d.toString(); });
        proc.on('error', () => resolve(null));
        proc.on('close', () => {
          const windowIds = ids.split('\n').map(s => s.trim()).filter(s => /^\d+$/.test(s));
          console.log(`[Geometry] class="${cls}" window IDs: [${windowIds.join(', ')}]`);
          if (windowIds.length === 0) { resolve(null); return; }

          // Measure each window; keep results for ALL of them (eligible or not)
          // so the debug log shows exactly what the selection logic saw.
          const results: { id: string; X: number; Y: number; WIDTH: number; HEIGHT: number }[] = [];
          let remaining = windowIds.length;
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            const eligible = results.filter(r => r.WIDTH >= MIN_W && r.HEIGHT >= MIN_H);
            eligible.sort((a, b) => b.WIDTH * b.HEIGHT - a.WIDTH * a.HEIGHT);
            const selected = eligible[0] ?? null;
            console.log(
              '[Geometry] Candidates:',
              results.length
                ? results.map(r => `${r.id}: ${r.WIDTH}x${r.HEIGHT} @(${r.X},${r.Y})${eligible.includes(r) ? '' : ' [below min]'}`).join('  |  ')
                : 'none measured',
            );
            console.log(
              `[Geometry] Selected: ${selected ? `${selected.id} ${selected.WIDTH}x${selected.HEIGHT} @(${selected.X},${selected.Y})` : 'NONE met minimum size'}`,
            );
            // `id` is passed through: enforceWindowSize() needs it to run
            // `xdotool windowsize <id> ...` on the same window that was
            // selected here, so the two can never act on different windows.
            resolve(selected ? { id: selected.id, X: selected.X, Y: selected.Y, WIDTH: selected.WIDTH, HEIGHT: selected.HEIGHT } : null);
          };
          for (const id of windowIds) {
            const g = spawn(
              'xdotool',
              ['getwindowgeometry', '--shell', id],
              { stdio: ['ignore', 'pipe', 'ignore'] },
            );
            let out = '';
            g.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
            const onDone = () => {
              // Parse xdotool's --shell output (KEY=value lines). The previous
              // `new RegExp(`${k}=(\d+)`)` NEVER matched: `\d` inside a template
              // literal collapses to `d`, producing patterns like `X=(d+)` that
              // can't match `X=10` — every field parsed as -1 and geometry
              // always fell back to defaults (chromeTop=0). Plain line parsing
              // avoids the escaping trap entirely.
              const parse = (k: string) => {
                const line = out.split('\n').map(s => s.trim()).find(s => s.startsWith(`${k}=`));
                return line ? parseInt(line.slice(k.length + 1).trim(), 10) : -1;
              };
              const X = parse('X'), Y = parse('Y'), W = parse('WIDTH'), H = parse('HEIGHT');
              results.push({ id, X, Y, WIDTH: W, HEIGHT: H });
              remaining -= 1;
              if (remaining === 0) finish();
            };
            g.on('error', () => { remaining -= 1; if (remaining === 0) finish(); });
            g.on('close', onDone);
          }
          setTimeout(finish, 3000);
        });
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* done */ } resolve(null); }, 2000);
      } catch {
        resolve(null);
      }
    });
  }

  getGeometry(): { width: number; height: number; chromeTop: number; chromeLeft: number } {
    return {
      width: this.winW,
      height: this.winH,
      chromeTop: this.browserChromeTop,
      chromeLeft: this.browserChromeLeft,
    };
  }

  // ─── Input methods ───────────────────────────────────────────────────────────

  /**
   * Convert capture/video coordinates into page viewport coordinates.
   *
   * The capture region is the FULL Xvfb display at (0,0) (see
   * startX11Capture), so a capture coordinate is a DISPLAY coordinate, not a
   * window coordinate. The page origin therefore sits at
   * (winX + chromeLeft, winY + chromeTop) within the capture, not at
   * (chromeLeft, chromeTop) as it did when the region tracked the window.
   * Subtracting only the chrome offsets would leave every click shifted by the
   * window origin -- harmless only while the window happens to sit at 0,0,
   * which is exactly the assumption that made Chromium 'look correct'.
   */
  private toPageCoords(x: number, y: number): { x: number; y: number } {
    return {
      x: Math.max(0, Math.min(this.viewportWidth - 1,
        Math.round(x - this.winX - this.browserChromeLeft))),
      y: Math.max(0, Math.min(this.viewportHeight - 1,
        Math.round(y - this.winY - this.browserChromeTop))),
    };
  }

  /**
   * Keep the X11 pointer out of the captured video.
   *
   * The page's hover state is driven by Puppeteer's virtual mouse, so the real
   * pointer position is irrelevant to interaction -- but it is NOT irrelevant to
   * the stream. Since capture now covers the whole 1920x1080 display there is
   * no off-screen parking spot left, so the cursor image is blanked instead.
   * x11grab has no cursor-suppression option, so blanking is the only lever.
   *
   * Best-effort by design: both calls swallow errors. If xsetroot or XFixes is
   * unavailable the cursor simply stays visible in the video, which is a
   * cosmetic regression, not a functional one -- so it must never be able to
   * throw and break capture startup.
   */
  private parkX11Cursor(): void {
    if (!process.env.DISPLAY) return;
    const run = (cmd: string, args: string[]) => {
      try {
        const p = spawn(cmd, args, { stdio: 'ignore' });
        p.on('error', () => { /* not installed -- pointer may stay visible */ });
        setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* done */ } }, 1500);
      } catch { /* spawn unavailable */ }
    };
    // Park it in the far corner anyway: if blanking fails, that is the pixel
    // least likely to matter (bottom-right, usually empty desktop).
    run('xdotool', ['mousemove', String(this.PARK_X), String(this.PARK_Y)]);
    // Blank the cursor image. xsetroot ships in x11-xserver-utils, which is NOT
    // in the deploy package list, so this is a no-op unless it happens to be
    // present -- hence the errors being swallowed. If it is missing the cursor
    // stays visible in the video (cosmetic only).
    run('xsetroot', ['-cursor_name', 'none']);
  }

  /**
   * Send an X11-level click through xdotool. Used for clicks in the browser chrome
   * region (tab strip / address bar), which Puppeteer can never reach because it
   * can only dispatch events inside the page viewport.
   */
  private async x11Click(x: number, y: number, button: 'left' | 'right' | 'middle', opts?: { press?: boolean; release?: boolean; repeat?: number }): Promise<void> {
    if (!process.env.DISPLAY) return;
    const btn = button === 'left' ? '1' : button === 'middle' ? '2' : '3';
    // xdotool works in DISPLAY coords. Since the capture region is now the full
    // display at (0,0), a capture coordinate is ALREADY a display coordinate,
    // so it must be used as-is. The previous `this.winX + x` translation was
    // correct only when the capture region tracked the window; with a
    // full-display capture it would double-offset every chrome click by the
    // window origin.
    const sx = Math.floor(x);
    const sy = Math.floor(y);
    const args: string[] = ['mousemove', String(sx), String(sy)];
    if (opts?.press) {
      args.push('mousedown', btn);
    } else if (opts?.release) {
      args.push('mouseup', btn);
    } else if (opts?.repeat && opts.repeat > 1) {
      args.push('click', '--repeat', String(opts.repeat), '--delay', '100', btn);
    } else {
      args.push('click', btn);
    }
    try {
      const proc = spawn('xdotool', args, { stdio: 'ignore' });
      proc.on('error', () => { /* xdotool not installed */ });
      await new Promise<void>(res => {
        proc.on('close', () => res());
        setTimeout(res, 1500);
      });
    } catch { /* xdotool unavailable */ }
    // Re-park the pointer so it doesn't linger in the visible chrome region.
    this.parkX11Cursor();
  }

  /**
   * True when a capture coordinate is inside the browser chrome (not the page).
   * Capture coords are DISPLAY coords (full-display capture), so the page area
   * starts after the window origin as well as the chrome offsets. Without the
   * winX/winY terms, everything left of/above the window -- plain desktop --
   * would be misread as chrome and routed to xdotool instead of the page.
   */
  private isInChrome(x: number, y: number): boolean {
    if (!process.env.DISPLAY) return false;
    const lx = x - this.winX;
    const ly = y - this.winY;
    return lx >= 0 && ly >= 0 && (ly < this.browserChromeTop || lx < this.browserChromeLeft);
  }

  /**
   * Swallow ONLY Puppeteer's button-state desync errors so a stray duplicate
   * event can't 500 the whole click. Any other error is rethrown.
   */
  private warnIfButtonStateError(e: unknown, action: string): void {
    const msg = e instanceof Error ? e.message : String(e);
    if (/already pressed|not pressed/i.test(msg)) {
      console.warn(`[Input] ${action} ignored (button-state desync): ${msg}`);
      return;
    }
    throw e;
  }

  async sendMouseClick(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    const page = this.getActivePage();
    if (!page) { console.warn(`[Input] click(${x},${y}) ignored: no active page`); return; }
    // Clicks in the browser chrome (tab strip / address bar) must go through
    // xdotool — Puppeteer cannot reach UI outside the page viewport.
    if (this.isInChrome(x, y)) {
      console.log(`[Input] click(${x},${y}) ${button} -> CHROME (xdotool, chromeTop=${this.browserChromeTop})`);
      // Focus moves into the chrome, so subsequent keystrokes belong there too.
      this.keyboardTarget = 'chrome';
      await this.x11Click(x, y, button);
      return;
    }
    const p = this.toPageCoords(x, y);
    console.log(`[Input] click(${x},${y}) ${button} -> page(${p.x},${p.y})`);
    // Focus moves into the page, so subsequent keystrokes go through Puppeteer.
    this.keyboardTarget = 'page';
    // Ensure page has focus before clicking
    await page.bringToFront().catch(() => {});
    try {
      await page.mouse.click(p.x, p.y, { button });
    } catch (e) {
      this.warnIfButtonStateError(e, 'mouse.click');
    }
  }

  async sendMouseDown(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    const chrome = this.isInChrome(x, y);
    // Remember which backend the press went to so the matching release is
    // routed to the same one even if the drag crosses the chrome/page boundary.
    this.mousePress = { button, backend: chrome ? 'x11' : 'page' };
    // Focus follows the press, so keystrokes route to the same region.
    this.keyboardTarget = chrome ? 'chrome' : 'page';
    if (chrome) {
      await this.x11Click(x, y, button, { press: true });
      return;
    }
    const p = this.toPageCoords(x, y);
    await page.bringToFront().catch(() => {});
    await page.mouse.move(p.x, p.y);
    try {
      await page.mouse.down({ button });
    } catch (e) {
      this.warnIfButtonStateError(e, 'mouse.down');
    }
  }

  async sendMouseUp(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    const page = this.getActivePage();
    // Route the release to the backend the press actually went to (fall back to
    // coordinate-based routing when no press is tracked).
    const backend = this.mousePress?.backend ?? (this.isInChrome(x, y) ? 'x11' : 'page');
    this.mousePress = null;
    if (!page) return;
    if (backend === 'x11') {
      await this.x11Click(x, y, button, { release: true });
      return;
    }
    const p = this.toPageCoords(x, y);
    await page.mouse.move(p.x, p.y);
    try {
      await page.mouse.up({ button });
    } catch (e) {
      this.warnIfButtonStateError(e, 'mouse.up');
    }
  }

  async sendMouseDoubleClick(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    if (this.isInChrome(x, y)) {
      await this.x11Click(x, y, button, { repeat: 2 });
      return;
    }
    const p = this.toPageCoords(x, y);
    await page.bringToFront().catch(() => {});
    // Puppeteer's MouseClickOptions doesn't support clickCount in this version.
    // Simulate a double-click with two rapid clicks.
    for (let i = 0; i < 2; i++) {
      try {
        await page.mouse.click(p.x, p.y, { button });
      } catch (e) {
        this.warnIfButtonStateError(e, 'mouse.dblclick');
      }
    }
  }

  async sendMouseMove(x: number, y: number): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    // Don't move/park the X11 pointer on every move (spams xdotool at 20Hz).
    // page.mouse.move drives the page hover state; the X11 pointer stays parked
    // off-capture so it never shows in the stream.
    const p = this.toPageCoords(x, y);
    // Fire-and-forget for mouse moves to reduce latency
    page.mouse.move(p.x, p.y).catch(() => {});
  }
  
  async sendMouseWheel(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    const p = this.toPageCoords(x, y);
    await page.mouse.move(p.x, p.y);
    await page.mouse.wheel({ deltaX, deltaY });
  }

  async sendMouseScroll(deltaX: number, deltaY: number, x: number, y: number): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    const p = this.toPageCoords(x, y);
    await page.mouse.move(p.x, p.y);
    await page.mouse.wheel({ deltaX, deltaY });
  }

  /**
   * Which backend owns keyboard input right now.
   *
   * Clicks already pick a backend with isInChrome(): the browser chrome (tab
   * strip, address bar) must go through xdotool because Puppeteer can only
   * dispatch inside the page viewport. Keyboard had no equivalent, so every
   * keystroke went to Puppeteer and chrome keystrokes had no way to work at all.
   * This records the backend the last click used and routes accordingly.
   */
  private keyboardTarget: 'page' | 'chrome' = 'page';

  /**
   * Send a key at the X11 level via xdotool. Used only for the browser chrome.
   * Requires a window manager for focus: without one the X server assigns focus
   * to nothing and the keystroke is discarded (see the openbox block in
   * scripts/vps-restart.sh).
   */
  private async x11Key(args: string[]): Promise<void> {
    if (!process.env.DISPLAY) return;
    try {
      const proc = spawn('xdotool', args, { stdio: 'ignore' });
      proc.on('error', () => { /* xdotool not installed */ });
      await new Promise<void>((res) => {
        proc.on('close', () => res());
        setTimeout(res, 1500);
      });
    } catch { /* xdotool unavailable */ }
  }

  /**
   * Decide the keyboard backend for this keystroke and log it.
   *
   * Prefers the page when the focused element is editable (input/textarea/
   * contenteditable) or the document itself has focus -- those only respond to
   * CDP-dispatched input. Everything else (address bar, tab strip, no page
   * element) goes to xdotool. The last click's backend is the tie-breaker
   * because the chrome owns focus after a chrome click.
   */
  private async resolveKeyboardTarget(): Promise<'page' | 'chrome'> {
    const page = this.getActivePage();
    if (!page) return 'chrome';
    try {
      const info = await page.evaluate(() => {
        const el = document.activeElement as (HTMLElement & { isContentEditable?: boolean }) | null;
        if (!el) return { hasFocus: false, editable: false, tag: 'NONE' };
        return {
          hasFocus: document.hasFocus(),
          editable: !!el.isContentEditable
            || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT',
          tag: el.tagName,
        };
      });
      // A focused editable element in a focused document always wins.
      if (info.editable && info.hasFocus) return 'page';
      // Otherwise trust where the last click went.
      return this.keyboardTarget;
    } catch {
      // evaluate failed (navigating/closed): fall back to the last click.
      return this.keyboardTarget;
    }
  }

  async sendKeyDown(key: string): Promise<void> {
    const target = await this.resolveKeyboardTarget();
    console.log(`[Input] keydown '${key}' -> ${target === 'page' ? 'PAGE (puppeteer)' : 'CHROME (xdotool)'}`);
    if (target === 'chrome') {
      await this.x11Key(['keydown', key]);
      return;
    }
    const page = this.getActivePage();
    if (!page) return;
    await page.bringToFront().catch(() => {});
    await page.keyboard.down(key as import('puppeteer-core').KeyInput);
  }

  async sendKeyUp(key: string): Promise<void> {
    const target = await this.resolveKeyboardTarget();
    console.log(`[Input] keyup '${key}' -> ${target === 'page' ? 'PAGE (puppeteer)' : 'CHROME (xdotool)'}`);
    if (target === 'chrome') {
      await this.x11Key(['keyup', key]);
      return;
    }
    const page = this.getActivePage();
    if (!page) return;
    await page.bringToFront().catch(() => {});
    await page.keyboard.up(key as import('puppeteer-core').KeyInput);
  }

  async sendKeyPress(key: string): Promise<void> {
    const target = await this.resolveKeyboardTarget();
    console.log(`[Input] keypress '${key}' -> ${target === 'page' ? 'PAGE (puppeteer)' : 'CHROME (xdotool)'}`);
    if (target === 'chrome') {
      await this.x11Key(['key', key]);
      return;
    }
    const page = this.getActivePage();
    if (!page) return;
    await page.bringToFront().catch(() => {});
    await page.keyboard.press(key as import('puppeteer-core').KeyInput);
  }

  async typeText(text: string): Promise<void> {
    const target = await this.resolveKeyboardTarget();
    console.log(
      `[Input] type(${text.length} chars) -> ${target === 'page' ? 'PAGE (puppeteer)' : 'CHROME (xdotool)'}`,
    );
    if (target === 'chrome') {
      // xdotool type takes the text as one argument; spaces are preserved.
      await this.x11Key(['type', '--delay', '20', text]);
      return;
    }
    const page = this.getActivePage();
    if (!page) return;
    await page.keyboard.type(text, { delay: 20 });
  }

  /**
   * Release any held mouse buttons and keyboard modifiers.
   * Called on client disconnect to prevent stuck input state.
   */
  async releaseInputState(): Promise<void> {
    this.mousePress = null;
    // X11-side keys may still be held down (xdotool keydown), and unlike the
    // Puppeteer ones these are invisible to page.keyboard.up(). Clear them so a
    // dropped connection cannot leave a modifier latched in the chrome.
    for (const k of ['Shift', 'Control', 'Alt', 'Meta']) {
      await this.x11Key(['keyup', k]).catch(() => {});
    }
    this.keyboardTarget = 'page';
    const page = this.getActivePage();
    if (!page) return;
    try {
      await page.mouse.up({ button: 'left' }).catch(() => {});
      await page.mouse.up({ button: 'right' }).catch(() => {});
      await page.mouse.up({ button: 'middle' }).catch(() => {});
      await page.keyboard.up('Shift').catch(() => {});
      await page.keyboard.up('Control').catch(() => {});
      await page.keyboard.up('Alt').catch(() => {});
      await page.keyboard.up('Meta').catch(() => {});
    } catch { /* ignore */ }
  }

  // ─── Navigation ──────────────────────────────────────────────────────────────

  async navigate(url: string): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    // Add protocol if missing
    if (!/^https?:\/\//i.test(url) && !url.startsWith('about:') && !url.startsWith('chrome:')) {
      if (url.includes('.') && !url.includes(' ')) {
        url = `https://${url}`;
      } else {
        url = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
      }
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  }

  async goBack(): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  }

  async goForward(): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    await page.goForward({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  }

  async reload(): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  }

  async getCurrentUrl(): Promise<string> {
    const page = this.getActivePage();
    if (!page) return '';
    return page.url();
  }

  async getTitle(): Promise<string> {
    const page = this.getActivePage();
    if (!page) return '';
    return page.title().catch(() => '');
  }

  // ─── Tab management ──────────────────────────────────────────────────────────

  async newTab(url = 'about:blank'): Promise<string> {
    if (!this.browser) throw new Error('Browser not launched');
    const page = await this.browser.newPage();
    await this.setupPage(page);
    const tabId = this.getPageId(page);
    this.pages.set(tabId, page);
    this.watchPage(page);

    if (url !== 'about:blank') {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    }

    return tabId;
  }

  async switchTab(tabId: string): Promise<void> {
    if (!this.pages.has(tabId)) throw new Error(`Tab ${tabId} not found`);
    const wasScreencasting = this.screencastActive;
    if (wasScreencasting) await this.stopScreencast();
    this.activePageId = tabId;
    if (wasScreencasting) await this.startScreencast();
  }

  async closeTab(tabId: string): Promise<void> {
    const page = this.pages.get(tabId);
    if (!page) return;
    if (tabId === this.activePageId) {
      // Switch to another tab first
      const remaining = Array.from(this.pages.keys()).filter(id => id !== tabId);
      if (remaining.length === 0) {
        // Open a new tab before closing
        const newId = await this.newTab('about:blank');
        await this.switchTab(newId);
      } else {
        await this.switchTab(remaining[remaining.length - 1]);
      }
    }
    this.closingPages.add(page); // intentional close — not a crash
    try { await page.close(); } catch { /* ignore */ }
    this.pages.delete(tabId);
  }

  async getTabs(): Promise<TabInfo[]> {
    const tabs: TabInfo[] = [];
    let index = 0;
    for (const [id, page] of this.pages) {
      const url = page.url();
      const title = await page.title().catch(() => url);
      tabs.push({
        id,
        url,
        title: title || url || 'New Tab',
        loading: false,
        index: index++,
      });
    }
    return tabs;
  }

  getActiveTabId(): string | null {
    return this.activePageId;
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    this.stopping = true; // intentional: subsequent page close events are not crashes
    this.stopMediaProbe();
    await this.stopScreencast();
    this.frameCallback = null;
    if (this.browser) {
      const browserProc = this.browser.process();
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
      // The CDP close above is graceful. Force-kill whatever survived it, so a
      // hung or wedged Chromium (and its renderers) cannot outlive the session.
      await killChild(browserProc, 'chromium');
    }
    this.pages.clear();
    this.activePageId = null;
    console.log(`[BrowserSession] Session ${this.sessionId} stopped`);
  }
}
