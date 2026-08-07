import { WebSocketServer, WebSocket } from 'ws';
import { SessionManager } from './session-manager.js';
import type { SignalMessage, OfferPayload } from '../src/shared/types.js';

export class SignalingServer {
  private wss: WebSocketServer;
  private sessionManager: SessionManager;

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

      ws.on('close', () => {
        if (clientSessionId) {
          console.log(`[Signaling] Client disconnected for session ${clientSessionId}`);
          // Release held input state and stop streaming work for this session.
          // This clears stuck mouse buttons/keyboard modifiers and frees
          // encoder/browser resources.
          this.sessionManager.stopSession(clientSessionId).catch((e) => {
            console.error(`[Signaling] Failed to clean up session ${clientSessionId}:`, e);
          });
        }
      });

      ws.on('error', (e) => {
        console.error('[Signaling] WebSocket error:', e);
      });
    });
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
    this.wss.close();
  }
}
