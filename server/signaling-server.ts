import { WebSocketServer, WebSocket } from 'ws';
import { SessionManager } from './session-manager.js';
import type { SignalMessage, OfferPayload } from '../src/shared/types.js';

// How long a session survives after its last client disconnects. A transient
// network drop or an accidental reload should not destroy the remote browser,
// so teardown waits for this window and is cancelled if a client comes back.
//
// This is the safety net for client-side reconnection: a client whose ICE
// dropped is still polling this session, and if we tore the session down the
// instant its socket blipped, every recoverable blip would become a permanent
// loss. It must comfortably exceed the client's own ICE grace period (5s) plus
// its reconnection attempts, so the server never gives up before the client has
// finished trying. 60s gives ~10x that margin.
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 60_000;

export class SignalingServer {
  private wss: WebSocketServer;
  private sessionManager: SessionManager;
  // Live clients per session. A session is only torn down once this set is
  // empty AND the grace period passes with nobody reclaiming it.
  private clientsBySession = new Map<string, Set<WebSocket>>();
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(server: import('http').Server, sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
    this.wss = new WebSocketServer({ server, path: '/signal' });

    this.wss.on('connection', (ws: WebSocket) => {
      let clientSessionId: string | null = null;

      ws.on('message', async (data: Buffer) => {
        try {
          const msg: SignalMessage = JSON.parse(data.toString());
          console.log(`[Signaling] Received ${msg.type} for session ${msg.sessionId}`);

          if (msg.type === 'offer') {
            clientSessionId = msg.sessionId;
            this.claimSession(ws, msg.sessionId);
            await this.handleOffer(ws, msg);
          } else if (msg.type === 'ice') {
            await this.handleIce(msg);
          }
        } catch (e) {
          console.error('[Signaling] Error processing message:', e);
          ws.send(JSON.stringify({
            type: 'error',
            sessionId: clientSessionId || '',
            payload: { message: 'Failed to process message' },
          }));
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        if (clientSessionId) {
          console.log(`[Signaling] WebSocket closed for session ${clientSessionId} (code: ${code}, reason: ${reason.toString() || 'none'})`);
          // Release stuck mouse buttons / held modifiers before anything else.
          const session = this.sessionManager.getSession(clientSessionId);
          if (session?.browser) {
            session.browser.releaseInputState();
            console.log(`[Signaling] Released input state for session ${clientSessionId}`);
          }
          // Do not kill the session immediately (a transient drop or a reload
          // should not destroy the remote browser), but DO arm teardown: once
          // WebRTC has connected the session timeout is cancelled, so without
          // this nothing would ever stop the session and its ffmpeg children.
          this.releaseSession(ws, clientSessionId);
        }
      });

      ws.on('error', (e) => {
        console.error('[Signaling] WebSocket error:', e);
      });
    });
  }

  /**
   * Register a client for a session and cancel any pending disconnect teardown.
   * Called when a client (re)claims a session with an offer.
   */
  private claimSession(ws: WebSocket, sessionId: string): void {
    const pending = this.disconnectTimers.get(sessionId);
    if (pending) {
      clearTimeout(pending);
      this.disconnectTimers.delete(sessionId);
      console.log(`[Signaling] Client reconnected to session ${sessionId} — disconnect teardown cancelled`);
    }
    let clients = this.clientsBySession.get(sessionId);
    if (!clients) {
      clients = new Set<WebSocket>();
      this.clientsBySession.set(sessionId, clients);
    }
    clients.add(ws);
  }

  /**
   * Drop a client. When the LAST client for a session goes away, arm a grace
   * timer that stops the session unless someone reconnects first. This is the
   * only teardown path that exists once WebRTC has connected.
   */
  private releaseSession(ws: WebSocket, sessionId: string): void {
    const clients = this.clientsBySession.get(sessionId);
    if (clients) {
      clients.delete(ws);
      if (clients.size > 0) return; // another viewer is still attached
      this.clientsBySession.delete(sessionId);
    }
    if (this.disconnectTimers.has(sessionId)) return; // already scheduled

    console.log(
      `[Signaling] Last client left session ${sessionId} — stopping it in ${DISCONNECT_GRACE_MS}ms unless a client reconnects`,
    );

    const timer = setTimeout(() => {
      this.disconnectTimers.delete(sessionId);
      // Someone reattached during the grace period.
      if (this.clientsBySession.has(sessionId)) return;
      if (!this.sessionManager.hasSession(sessionId)) return;

      console.log(`[Signaling] Session ${sessionId} was not reclaimed within ${DISCONNECT_GRACE_MS}ms — stopping it`);
      this.sessionManager.stopSession(sessionId).catch((e) => {
        console.error(`[Signaling] Failed to stop disconnected session ${sessionId}:`, e);
      });
    }, DISCONNECT_GRACE_MS);

    this.disconnectTimers.set(sessionId, timer);
  }

  private async handleOffer(ws: WebSocket, msg: SignalMessage): Promise<void> {
    const sessionId = msg.sessionId;
    const streamer = this.sessionManager.getStreamer(sessionId);

    if (!streamer) {
      ws.send(JSON.stringify({
        type: 'error',
        sessionId,
        payload: { message: `No active streamer for session ${sessionId}` },
      }));
      return;
    }

    const offer = msg.payload as OfferPayload;

    streamer.onIceCandidate((candidate) => {
      const iceMsg: SignalMessage = {
        type: 'ice',
        sessionId,
        payload: { candidate },
      };
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(iceMsg));
      }
    });

    // When WebRTC connects, cancel the session timeout
    streamer.onConnectionStateChange((state) => {
      if (state === 'connected') {
        this.sessionManager.cancelSessionTimeout(sessionId);
      }
    });

    try {
      const answerSdp = await streamer.processOffer(offer.sdp);

      const answerMsg: SignalMessage = {
        type: 'answer',
        sessionId,
        payload: { type: 'answer', sdp: answerSdp },
      };
      ws.send(JSON.stringify(answerMsg));

      await this.sessionManager.startScreencast(sessionId);
    } catch (e) {
      console.error('[Signaling] Offer negotiation failed:', e);
      ws.send(JSON.stringify({
        type: 'error',
        sessionId,
        payload: { message: `WebRTC negotiation failed: ${e instanceof Error ? e.message : 'Unknown'}` },
      }));
    }
  }

  private async handleIce(msg: SignalMessage): Promise<void> {
    const streamer = this.sessionManager.getStreamer(msg.sessionId);
    if (!streamer) return;
    const payload = msg.payload as { candidate: RTCIceCandidateInit };
    await streamer.addIceCandidate(payload.candidate);
  }

  close(): void {
    // Pending disconnect timers must be cleared: they would otherwise keep the
    // event loop alive during shutdown and fire stopSession() on a manager we
    // are already tearing down.
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    this.disconnectTimers.clear();
    this.clientsBySession.clear();
    this.wss.close();
  }
}
