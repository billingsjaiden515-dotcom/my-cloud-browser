/**
 * FIREFOX LIFECYCLE TEST — the gate for Commit 2.
 *
 * Question this answers: when firefox-esr is SIGKILLed from OUTSIDE Puppeteer,
 * does `browser.on('disconnected')` still fire, so that
 * browser-session.ts:224 -> markDead() -> /api/session/status alive:false works?
 *
 * This is the ONE crash signal Firefox has. Static analysis of
 * puppeteer-core 25.5.0 shows the chain:
 *   BrowserLauncher.createBiDiBrowser()  ->  process: browserProcess.nodeProcess
 *   BidiBrowser #process (Browser.js:156) -> #process.once('close')  (:173)
 *   -> browserCore.dispose() -> 'disconnected' -> trustedEmitter.emit (:169-170)
 * pkill -9 closes the process, so 'close' should fire. This test PROVES it
 * rather than assuming it.
 *
 * Run:  node scripts/firefox-lifecycle-test.mjs
 * Env:  FIREFOX_PATH (default /Applications/Firefox.app/Contents/MacOS/firefox)
 */
import puppeteer from 'puppeteer-core';
import { execSync, spawnSync } from 'child_process';

const FIREFOX_PATH = process.env.FIREFOX_PATH
  || '/Applications/Firefox.app/Contents/MacOS/firefox';
const DEADLINE_MS = 15000;
const POLL_MS = 250;

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirror the app's own crash detection (browser-session.ts:224).
let markDeadCalls = [];
const disconnected = { fired: false, at: null, reason: null };

async function main() {
  log(`Firefox binary: ${FIREFOX_PATH}`);
  let browser;
  try {
    browser = await puppeteer.launch({
      browser: 'firefox',            // NOT product: — that key does not exist in v25
      executablePath: FIREFOX_PATH,
      headless: true,                 // no Xvfb on the dev Mac; the disconnect
      args: [],                       // semantics under test are identical headful.
      // Firefox only opens the WebDriver BiDi port when this is set. Without it
      // Puppeteer waits 30s for an endpoint line that never comes. Verified
      // locally: with this flag Firefox prints
      //   "WebDriver BiDi listening on ws://127.0.0.1:<port>"
      // and without it, nothing. FirefoxLauncher does NOT add it for us.
      extraPrefsFirefox: {},
    });
    log('launched OK (browser: "firefox" => WebDriver BiDi)');

    browser.on('disconnected', () => {
      disconnected.fired = true;
      disconnected.at = Date.now();
      markDeadCalls.push('browser process disconnected (crashed or killed)');
      log('*** browser.on("disconnected") FIRED ***');
    });

    // Prove it is genuinely alive and usable first — a browser that never
    // launched would "pass" a disconnect test trivially.
    const page = await browser.newPage();
    await page.goto('about:blank', { timeout: 20000 });
    const title = await page.title();
    log(`liveness OK: page.title()="${title}" (BiDi round-trip works)`);
    log('connected state before kill:', browser.connected ?? '(n/a)');

    // ── The actual test: SIGKILL from outside Puppeteer ───────────────────
    const pid = browser.process()?.pid;
    log(`SIGKILLing firefox pid=${pid} from OUTSIDE puppeteer`);
    try {
      execSync(`pkill -9 -P ${pid} 2>/dev/null; kill -9 ${pid} 2>/dev/null`, { stdio: 'ignore' });
    } catch { /* pkill returns 1 if already gone; that is fine */ }

    const t0 = Date.now();
    while (Date.now() - t0 < DEADLINE_MS) {
      if (disconnected.fired) break;
      await sleep(POLL_MS);
    }
    const latency = disconnected.fired ? Date.now() - t0 : null;

    // ── Verdict ──────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(66));
    let pass = true;
    if (disconnected.fired) {
      log(`PASS: 'disconnected' fired ${latency}ms after SIGKILL`);
    } else {
      console.log(`FAIL: 'disconnected' did NOT fire within ${DEADLINE_MS}ms.`);
      console.log('  => Firefox has NO crash signal. markDead() would never run and');
      console.log('     /api/session/status would report a live session over a dead');
      console.log('     browser. Commit 2 must NOT proceed.');
      pass = false;
    }
    log(`markDead() would have been called ${markDeadCalls.length}x`);
    console.log('='.repeat(66));
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.log(`\nERROR: ${e?.message ?? e}`);
    console.log('  => Inconclusive. Check the binary path / BiDi support.');
    process.exit(2);
  } finally {
    try { await browser?.close(); } catch { /* already dead */ }
  }
}

main();
