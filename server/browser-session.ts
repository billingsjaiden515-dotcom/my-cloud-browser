import puppeteer, { Browser, Page, CDPSession } from 'puppeteer-core';
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

  constructor(sessionId: string, browserType = 'chromium') {
    this.sessionId = sessionId;
    this.browserType = browserType;
  }

  async launch(): Promise<void> {
    const executablePath = getChromiumPath();
    console.log(`[BrowserSession] Launching ${this.browserType} at: ${executablePath}`);

    this.browser = await puppeteer.launch({
      executablePath,
      headless: true,
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
        '--mute-audio',
        '--disable-infobars',
        '--disable-notifications',
        '--disable-popup-blocking',
        `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
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

  async startScreencast(): Promise<void> {
    const page = this.getActivePage();
    if (!page) throw new Error('No active page');
    if (this.screencastActive) await this.stopScreencast();

    this.cdpSession = await page.createCDPSession();

    this.cdpSession.on('Page.screencastFrame', (payload: {
      data: string;
      sessionId: number;
      metadata: { deviceWidth: number; deviceHeight: number };
    }) => {
      if (this.frameCallback) {
        const buf = Buffer.from(payload.data, 'base64');
        this.frameCallback(
          buf,
          payload.metadata?.deviceWidth || this.viewportWidth,
          payload.metadata?.deviceHeight || this.viewportHeight,
        );
      }
      this.cdpSession?.send('Page.screencastFrameAck', {
        sessionId: payload.sessionId,
      }).catch(() => {});
    });

    await this.cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      everyNthFrame: 1,
      maxWidth: this.viewportWidth,
      maxHeight: this.viewportHeight,
    });

    this.screencastActive = true;
    console.log('[BrowserSession] Screencast started');
  }

  async stopScreencast(): Promise<void> {
    if (!this.screencastActive || !this.cdpSession) return;
    try {
      await this.cdpSession.send('Page.stopScreencast');
    } catch { /* ignore */ }
    try {
      await this.cdpSession.detach();
    } catch { /* ignore */ }
    this.cdpSession = null;
    this.screencastActive = false;
  }

  getViewport(): { width: number; height: number } {
    return { width: this.viewportWidth, height: this.viewportHeight };
  }

  /**
   * Update the browser viewport and restart screencast if active.
   * Used for responsive resolution.
   */
  async setViewport(width: number, height: number): Promise<void> {
    // Clamp to reasonable bounds
    width = Math.max(320, Math.min(1920, Math.round(width)));
    height = Math.max(240, Math.min(1080, Math.round(height)));
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
    await page.mouse.click(x, y, { button });
  }

  async sendMouseDown(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
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
    await page.mouse.move(x, y);
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
    await page.keyboard.down(key as import('puppeteer-core').KeyInput);
  }

  async sendKeyUp(key: string): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
    await page.keyboard.up(key as import('puppeteer-core').KeyInput);
  }

  async sendKeyPress(key: string): Promise<void> {
    const page = this.getActivePage();
    if (!page) return;
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
