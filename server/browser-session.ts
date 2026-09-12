import puppeteer, { Browser, Page, CDPSession } from 'puppeteer-core';
import { spawn, ChildProcess } from 'child_process';
import { getChromiumPath } from './browser-finder.js';

export const VIEWPORT_WIDTH = 1280;
export const VIEWPORT_HEIGHT = 800;

export interface FrameCallback {
  (jpegData: Buffer, width: number, height: number): void;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  index: number;
}

export class BrowserSession {
  sessionId: string;
  private browser: Browser | null = null;
  private pages: Map<string, Page> = new Map();
  private activePageId: string | null = null;
  private screencastActive = false;
  private frameCallback: FrameCallback | null = null;
  private cdpSession: CDPSession | null = null;
  private browserType: string;
  private viewportWidth = VIEWPORT_WIDTH;
  private viewportHeight = VIEWPORT_HEIGHT;
  private captureInterval: ReturnType<typeof setInterval> | null = null;
  private capturePending = false;
  private frameCounter = 0;
  private readonly TARGET_FPS = 20; // Reduced for better performance on VPS
  private readonly JPEG_QUALITY = 60; // Lower quality = faster encoding
  private x11ffmpeg: ChildProcess | null = null;

  constructor(sessionId: string, browserType = 'chromium') {
    this.sessionId = sessionId;
    this.browserType = browserType;
  }

  async launch(): Promise<void> {
    const executablePath = getChromiumPath();
    console.log(`[BrowserSession] Launching ${this.browserType} at: ${executablePath}`);

    // Use headful mode with Xvfb for tab strip visibility
    // Xvfb must be running with DISPLAY=:99
    const isHeadful = process.env.DISPLAY !== undefined;
    
    this.browser = await puppeteer.launch({
      executablePath,
      headless: isHeadful ? false : true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
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
        `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
        // Show tab strip in headful mode
        ...(isHeadful ? [
          '--enable-features=TouchpadOverscrollHistoryNavigation',
          '--disable-features=SuppressUnsupportedFlagWarning',
        ] : []),
      ],
    });

    const pages = await this.browser.pages();
    const page = pages[0] || (await this.browser.newPage());
    await this.setupPage(page);

    const tabId = this.getPageId(page);
    this.pages.set(tabId, page);
    this.activePageId = tabId;

    await page.goto('https://www.google.com', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    }).catch(() => {
      return page.goto('about:blank').catch(() => {});
    });

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

  private async setupPage(page: Page): Promise<void> {
    await page.setViewport({
      width: this.viewportWidth,
      height: this.viewportHeight,
      deviceScaleFactor: 1,
    });
  }

  getActivePage(): Page | null {
    if (!this.activePageId) return null;
    return this.pages.get(this.activePageId) || null;
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
    const width = this.viewportWidth;
    const height = this.viewportHeight;
    const fps = this.TARGET_FPS;

    // Persistent FFmpeg process: x11grab -> raw BGR frames -> JPEG pipe
    // Using rawvideo + mjpeg in one process avoids per-frame startup overhead
    this.x11ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'x11grab',
      '-video_size', `${width}x${height}`,
      '-framerate', String(fps),
      '-i', display,
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', String(Math.round((100 - this.JPEG_QUALITY) / 10)),
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    this.x11recvBuf = Buffer.alloc(0);

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

      // Deliver frame
      this.frameCounter++;
      if (this.frameCallback) {
        this.frameCallback(frame, this.viewportWidth, this.viewportHeight);
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
    this.stopX11Capture();
    if (this.frameCounter > 0) {
      console.log(`[BrowserSession] Capture stopped after ${this.frameCounter} frames`);
    }
    this.frameCounter = 0;
  }

  private stopX11Capture(): void {
    if (this.x11ffmpeg) {
      try { this.x11ffmpeg.kill('SIGTERM'); } catch { /* ignore */ }
      this.x11ffmpeg = null;
    }
    this.x11recvBuf = Buffer.alloc(0);
  }

  getViewport(): { width: number; height: number } {
    return { width: this.viewportWidth, height: this.viewportHeight };
  }

  /**
   * Update the browser viewport and restart screencast if active.
   * Used for responsive resolution.
   */
  async setViewport(width: number, height: number): Promise<void> {
    // Clamp to Xvfb display size in headful mode to prevent coordinate mismatch
    const maxW = process.env.DISPLAY ? VIEWPORT_WIDTH : 1920;
    const maxH = process.env.DISPLAY ? VIEWPORT_HEIGHT : 1080;
    width = Math.max(320, Math.min(maxW, Math.round(width)));
    height = Math.max(240, Math.min(maxH, Math.round(height)));
    // Round to even numbers (codec-friendly)
    if (width % 2 !== 0) width++;
    if (height % 2 !== 0) height++;

    if (width === this.viewportWidth && height === this.viewportHeight) return;

    const wasScreencasting = this.screencastActive;
    if (wasScreencasting) await this.stopScreencast();

    this.viewportWidth = width;
    this.viewportHeight = height;

    const page = this.getActivePage();
    if (page) {
      await page.setViewport({ width, height, deviceScaleFactor: 1 }).catch(() => {});
    }

    if (wasScreencasting) await this.startScreencast();

    console.log(`[BrowserSession] Viewport updated to ${width}x${height}`);
  }

  // ─── Input methods ───────────────────────────────────────────────────────────

  async sendMouseClick(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    // Ensure page has focus before clicking
    await page.bringToFront().catch(() => {});
    await page.mouse.click(x, y, { button });
  }

  async sendMouseDown(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    await page.bringToFront().catch(() => {});
    await page.mouse.move(x, y);
    await page.mouse.down({ button });
  }

  async sendMouseUp(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    await page.mouse.move(x, y);
    await page.mouse.up({ button });
  }

  async sendMouseDoubleClick(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    // Puppeteer's MouseClickOptions doesn't support clickCount in this version.
    // Simulate a double-click with two rapid clicks.
    await page.mouse.click(x, y, { button });
    await page.mouse.click(x, y, { button });
  }

  async sendMouseMove(x: number, y: number): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    // Fire-and-forget for mouse moves to reduce latency
    page.mouse.move(x, y).catch(() => {});
  }
  
  async sendMouseWheel(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    await page.mouse.move(x, y);
    await page.mouse.wheel({ deltaX, deltaY });
  }

  async sendMouseScroll(deltaX: number, deltaY: number, x: number, y: number): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    await page.mouse.move(x, y);
    await page.mouse.wheel({ deltaX, deltaY });
  }

  async sendKeyDown(key: string): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    await page.bringToFront().catch(() => {});
    await page.keyboard.down(key as import('puppeteer-core').KeyInput);
  }

  async sendKeyUp(key: string): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    await page.bringToFront().catch(() => {});
    await page.keyboard.up(key as import('puppeteer-core').KeyInput);
  }

  async sendKeyPress(key: string): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    await page.bringToFront().catch(() => {});
    await page.keyboard.press(key as import('puppeteer-core').KeyInput);
  }

  async typeText(text: string): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    await page.keyboard.type(text, { delay: 20 });
  }

  /**
   * Release any held mouse buttons and keyboard modifiers.
   * Called on client disconnect to prevent stuck input state.
   */
  async releaseInputState(): Promise<void> {
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
    await this.stopScreencast();
    this.frameCallback = null;
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
    }
    this.pages.clear();
    this.activePageId = null;
    console.log(`[BrowserSession] Session ${this.sessionId} stopped`);
  }
}
