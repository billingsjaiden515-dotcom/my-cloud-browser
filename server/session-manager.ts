import { randomUUID } from 'crypto';
import { BrowserSession } from './browser-session.js';
import { WebRTCStreamer } from './webrtc-streamer.js';

interface ActiveSession {
  id: string;
  browser: BrowserSession;
  streamer: WebRTCStreamer | null;
  createdAt: number;
  browserType: string;
}

export class SessionManager {
  private sessions = new Map<string, ActiveSession>();

  async startSession(browserType = 'chromium'): Promise<string> {
    const id = randomUUID();
    const browser = new BrowserSession(id, browserType);

    await browser.launch();

    const session: ActiveSession = {
      id,
      browser,
      streamer: null,
      createdAt: Date.now(),
      browserType,
    };
    this.sessions.set(id, session);
    console.log(`[SessionManager] Session ${id} launched (${browserType})`);
    return id;
  }

  createStreamer(sessionId: string): WebRTCStreamer {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const streamer = new WebRTCStreamer(session.browser);
    session.streamer = streamer;
    return streamer;
  }

  async startScreencast(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    await session.browser.startScreencast();
    session.streamer?.startStreaming();
    console.log(`[SessionManager] Streaming started for session ${sessionId}`);
  }

  getStreamer(sessionId: string): WebRTCStreamer | null {
    return this.sessions.get(sessionId)?.streamer ?? null;
  }

  getBrowser(sessionId: string): BrowserSession | null {
    return this.sessions.get(sessionId)?.browser ?? null;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.streamer) await session.streamer.stop();
    await session.browser.stop();
    this.sessions.delete(sessionId);
    console.log(`[SessionManager] Session ${sessionId} stopped`);
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map(id => this.stopSession(id)));
  }

  getActiveSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }
}
