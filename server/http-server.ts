import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { SessionManager } from './session-manager.js';
import { SignalingServer } from './signaling-server.js';
import { getBrowserInfo } from './browser-finder.js';
import { getConfiguredIceServers } from './webrtc-streamer.js';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In dev (tsx), __dirname is <root>/server/ → ../dist = <root>/dist ✓
// In compiled output, __dirname is <root>/dist-server/server/ → ../../dist = <root>/dist ✓
const DIST_DIR = path.basename(path.dirname(__dirname)) === 'dist-server'
  ? path.resolve(__dirname, '../../dist')
  : path.resolve(__dirname, '../dist');

export function createServer(): http.Server {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const sessionManager = new SessionManager();

  // Serve the built frontend (Vite output) if present.
  // This lets a single Render web service serve both the UI and the API.
  if (existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
    // SPA fallback: any non-API GET returns index.html
    app.get(/^\/(?!api\/|signal).*/, (_req, res) => {
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
    console.log(`[HTTP] Serving frontend from ${DIST_DIR}`);
  } else {
    console.log('[HTTP] dist/ not found - API only (run `npm run build` to serve the UI)');
  }

  // ─── Session ──────────────────────────────────────────────────────────────────

  app.post('/api/session/start', async (req, res) => {
    try {
      const { browserType = 'chromium' } = req.body as { browserType?: string };
      
      // Stop any existing sessions before starting a new one
      const existingIds = sessionManager.getActiveSessionIds();
      for (const id of existingIds) {
        console.log(`[HTTP] Stopping orphaned session ${id} before starting new one`);
        await sessionManager.stopSession(id).catch(() => {});
      }
      
      // Wait for cleanup to complete
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const sessionId = await sessionManager.startSession(browserType);
      sessionManager.createStreamer(sessionId);
      console.log(`[HTTP] Session ${sessionId} started successfully`);
      res.json({ sessionId, status: 'streaming', message: 'Browser session started' });
    } catch (e) {
      console.error('[HTTP] Failed to start session:', e);
      res.status(500).json({
        error: 'start_failed',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  });

  app.post('/api/session/stop', async (req, res) => {
    try {
      const { sessionId } = req.body as { sessionId?: string };
      if (!sessionId) {
        res.status(400).json({ error: 'missing_session', message: 'sessionId required' });
        return;
      }
      await sessionManager.stopSession(sessionId);
      res.json({ status: 'stopped', message: 'Session stopped' });
    } catch (e) {
      console.error('[HTTP] Failed to stop session:', e);
      res.status(500).json({ error: 'stop_failed', message: e instanceof Error ? e.message : 'Unknown error' });
    }
  });

  app.get('/api/session/status', async (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;
    if (sessionId) {
      const exists = sessionManager.hasSession(sessionId);
      const browser = sessionManager.getBrowser(sessionId);
      const url = browser ? await browser.getCurrentUrl().catch(() => '') : '';
      const title = browser ? await browser.getTitle().catch(() => '') : '';
      const tabs = browser ? await browser.getTabs().catch(() => []) : [];
      const geo = browser ? browser.getGeometry() : null;
      res.json({ sessionId, active: exists, url, title, tabs, width: geo?.width, height: geo?.height });
    } else {
      const ids = sessionManager.getActiveSessionIds();
      res.json({ activeSessions: ids, count: ids.length });
    }
  });

  // ─── Browsers ─────────────────────────────────────────────────────────────────

  app.get('/api/browsers', (_req, res) => {
    const browsers = getBrowserInfo();
    res.json({ browsers });
  });

  // ─── Config (frontend runtime settings) ───────────────────────────────────────

  app.get('/api/config', (_req, res) => {
    res.json({ iceServers: getConfiguredIceServers() });
  });

  // ─── Navigation ───────────────────────────────────────────────────────────────

  app.post('/api/navigate', async (req, res) => {
    try {
      const { sessionId, url } = req.body as { sessionId: string; url: string };
      const browser = sessionManager.getBrowser(sessionId);
      if (!browser) { res.status(404).json({ error: 'session_not_found' }); return; }
      await browser.navigate(url);
      const currentUrl = await browser.getCurrentUrl();
      res.json({ ok: true, url: currentUrl });
    } catch (e) {
      res.status(500).json({ error: 'navigate_failed', message: e instanceof Error ? e.message : 'Unknown' });
    }
  });

  app.post('/api/navigate/back', async (req, res) => {
    try {
      const { sessionId } = req.body as { sessionId: string };
      const browser = sessionManager.getBrowser(sessionId);
      if (!browser) { res.status(404).json({ error: 'session_not_found' }); return; }
      await browser.goBack();
      const url = await browser.getCurrentUrl();
      res.json({ ok: true, url });
    } catch (e) {
      res.status(500).json({ error: 'back_failed', message: e instanceof Error ? e.message : 'Unknown' });
    }
  });

  app.post('/api/navigate/forward', async (req, res) => {
    try {
      const { sessionId } = req.body as { sessionId: string };
      const browser = sessionManager.getBrowser(sessionId);
      if (!browser) { res.status(404).json({ error: 'session_not_found' }); return; }
      await browser.goForward();
      const url = await browser.getCurrentUrl();
      res.json({ ok: true, url });
    } catch (e) {
      res.status(500).json({ error: 'forward_failed', message: e instanceof Error ? e.message : 'Unknown' });
    }
  });

  app.post('/api/navigate/reload', async (req, res) => {
    try {
      const { sessionId } = req.body as { sessionId: string };
      const browser = sessionManager.getBrowser(sessionId);
      if (!browser) { res.status(404).json({ error: 'session_not_found' }); return; }
      await browser.reload();
      const url = await browser.getCurrentUrl();
      res.json({ ok: true, url });
    } catch (e) {
      res.status(500).json({ error: 'reload_failed', message: e instanceof Error ? e.message : 'Unknown' });
    }
  });

  // ─── Tabs ─────────────────────────────────────────────────────────────────────

  app.post('/api/tab/new', async (req, res) => {
    try {
      const { sessionId, url } = req.body as { sessionId: string; url?: string };
      const browser = sessionManager.getBrowser(sessionId);
      if (!browser) { res.status(404).json({ error: 'session_not_found' }); return; }
      const tabId = await browser.newTab(url);
      await browser.switchTab(tabId);
      // Restart screencast on new tab
      const streamer = sessionManager.getStreamer(sessionId);
      if (streamer?.isStreaming()) {
        await browser.stopScreencast();
        await browser.startScreencast();
      }
      res.json({ ok: true, tabId });
    } catch (e) {
      res.status(500).json({ error: 'tab_new_failed', message: e instanceof Error ? e.message : 'Unknown' });
    }
  });

  app.post('/api/tab/switch', async (req, res) => {
    try {
      const { sessionId, tabId } = req.body as { sessionId: string; tabId: string };
      const browser = sessionManager.getBrowser(sessionId);
      if (!browser) { res.status(404).json({ error: 'session_not_found' }); return; }
      await browser.switchTab(tabId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'tab_switch_failed', message: e instanceof Error ? e.message : 'Unknown' });
    }
  });

  app.post('/api/tab/close', async (req, res) => {
    try {
      const { sessionId, tabId } = req.body as { sessionId: string; tabId: string };
      const browser = sessionManager.getBrowser(sessionId);
      if (!browser) { res.status(404).json({ error: 'session_not_found' }); return; }
      await browser.closeTab(tabId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'tab_close_failed', message: e instanceof Error ? e.message : 'Unknown' });
    }
  });

  app.get('/api/tab/list', async (req, res) => {
    try {
      const sessionId = req.query.sessionId as string;
      const browser = sessionManager.getBrowser(sessionId);
      if (!browser) { res.status(404).json({ error: 'session_not_found' }); return; }
      const tabs = await browser.getTabs();
      const activeTabId = browser.getActiveTabId();
      res.json({ tabs, activeTabId });
    } catch (e) {
      res.status(500).json({ error: 'tab_list_failed', message: e instanceof Error ? e.message : 'Unknown' });
    }
  });

  // ─── Viewport ─────────────────────────────────────────────────────────────────

  app.post('/api/viewport', async (req, res) => {
    try {
      const { sessionId, width, height } = req.body as { sessionId: string; width: number; height: number };
      const browser = sessionManager.getBrowser(sessionId);
      if (!browser) { res.status(404).json({ error: 'session_not_found' }); return; }
      await browser.setViewport(width, height);
      res.json({ ok: true, width, height });
    } catch (e) {
      res.status(500).json({ error: 'viewport_failed', message: e instanceof Error ? e.message : 'Unknown' });
    }
  });

  // ─── Input ────────────────────────────────────────────────────────────────────

  app.post('/api/input/mouse', async (req, res) => {
    try {
      const { sessionId, action, x, y, button, deltaX, deltaY } = req.body as {
        sessionId: string;
        action: 'click' | 'move' | 'scroll' | 'down' | 'up' | 'doubleclick';
        x: number; y: number;
        button?: 'left' | 'right' | 'middle';
        deltaX?: number; deltaY?: number;
      };
      const browser = sessionManager.getBrowser(sessionId);
      if (!browser) { res.status(404).json({ error: 'session_not_found' }); return; }
      switch (action) {
        case 'click': await browser.sendMouseClick(x, y, button || 'left'); break;
        case 'move': await browser.sendMouseMove(x, y); break;
        case 'scroll': await browser.sendMouseScroll(deltaX || 0, deltaY || 0, x, y); break;
        case 'down': await browser.sendMouseDown(x, y, button || 'left'); break;
        case 'up': await browser.sendMouseUp(x, y, button || 'left'); break;
        case 'doubleclick': await browser.sendMouseDoubleClick(x, y, button || 'left'); break;
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'input_failed', message: e instanceof Error ? e.message : 'Unknown' });
    }
  });

  app.post('/api/input/keyboard', async (req, res) => {
    try {
      const { sessionId, action, key, text } = req.body as {
        sessionId: string;
        action: 'keydown' | 'keyup' | 'keypress' | 'type';
        key?: string; text?: string;
      };
      const browser = sessionManager.getBrowser(sessionId);
      if (!browser) { res.status(404).json({ error: 'session_not_found' }); return; }
      switch (action) {
        case 'keydown': if (key) await browser.sendKeyDown(key); break;
        case 'keyup': if (key) await browser.sendKeyUp(key); break;
        case 'keypress': if (key) await browser.sendKeyPress(key); break;
        case 'type': if (text) await browser.typeText(text); break;
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'input_failed', message: e instanceof Error ? e.message : 'Unknown' });
    }
  });

  const server = http.createServer(app);
  const signaling = new SignalingServer(server, sessionManager);

  server.on('close', async () => {
    await sessionManager.stopAll();
    signaling.close();
  });

  return server;
}
