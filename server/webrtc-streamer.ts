import { RTCPeerConnection, RTCSessionDescription } from 'werift';
import type { BrowserSession } from './browser-session.js';
import { Vp8Encoder, type Vp8Frame } from './vp8-encoder.js';
import { AudioCapture } from './audio-capture.js';

const CLOCK_RATE = 90000; // Standard 90 kHz video RTP clock
const VP8_PAYLOAD_TYPE = 96; // Dynamic PT for VP8

/**
 * ICE servers used by the werift RTCPeerConnection.
 *
 * Default: [] (host candidates only). On a VPS with a public IP or 1:1 NAT,
 * host candidates are sufficient.
 *
 * For NAT'd / port-forwarded environments where UDP inbound is unavailable
 * (e.g. GitHub Codespaces, which only forwards TCP), set WEBRTC_ICE_SERVERS to a
 * JSON array with a TURN server reachable over TCP, e.g.:
 *   WEBRTC_ICE_SERVERS='[{"urls":"turn:openrelay.metered.ca:443","username":"openrelayproject","credential":"openrelayproject"}]'
 */
export function getConfiguredIceServers(): { urls: string; username?: string; credential?: string }[] {
  const raw = process.env.WEBRTC_ICE_SERVERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as { urls: string; username?: string; credential?: string }[];
      console.error('[WebRTC] WEBRTC_ICE_SERVERS is not an array, ignoring');
    } catch (e) {
      console.error('[WebRTC] Invalid WEBRTC_ICE_SERVERS JSON:', e);
    }
  }
  return [];
}

/**
 * Packetize a VP8 frame into RTP packet buffers (RFC 7741).
 * Each returned buffer is a complete RTP packet (header + VP8 payload descriptor + data).
 */
function packetizeVp8Frame(
  vp8Data: Buffer,
  ssrc: number,
  sequenceNumber: number,
  timestamp: number,
): Buffer[] {
  const MAX_PAYLOAD = 1100; // leave room for RTP header + DTLS overhead
  const packets: Buffer[] = [];
  let offset = 0;
  let seq = sequenceNumber;

  while (offset < vp8Data.length) {
    const isFirst = offset === 0;
    const chunk = vp8Data.slice(offset, offset + MAX_PAYLOAD);
    offset += chunk.length;
    const isLast = offset >= vp8Data.length;

    // VP8 payload descriptor (RFC 7741 §4.2):
    //  0 1 2 3 4 5 6 7
    // +-+-+-+-+-+-+-+-+
    // |X|R|N|S|R|PID |  S=1 on first packet, PID=0 for partition 0
    const descriptor = isFirst ? 0x10 : 0x00;

    // Build 12-byte RTP fixed header
    const rtp = Buffer.allocUnsafe(12 + 1 + chunk.length);
    // V=2, P=0, X=0, CC=0
    rtp[0] = 0x80;
    // M bit + payload type
    rtp[1] = (isLast ? 0x80 : 0x00) | (VP8_PAYLOAD_TYPE & 0x7f);
    // Sequence number
    rtp.writeUInt16BE(seq & 0xffff, 2);
    // Timestamp
    rtp.writeUInt32BE(timestamp >>> 0, 4);
    // SSRC
    rtp.writeUInt32BE(ssrc >>> 0, 8);
    // VP8 payload descriptor
    rtp[12] = descriptor;
    // VP8 data
    chunk.copy(rtp, 13);

    packets.push(rtp);
    seq = (seq + 1) & 0xffff;
  }

  return packets;
}

export class WebRTCStreamer {
  private pc: RTCPeerConnection | null = null;
  private session: BrowserSession;
  private encoder: Vp8Encoder;
  private streaming = false;
  private iceCandidateCallback: ((candidate: unknown) => void) | null = null;

  // RTP state
  private sequenceNumber = Math.floor(Math.random() * 0xffff);
  private timestamp = Math.floor(Math.random() * 0xffffffff);
  private ssrc = Math.floor(Math.random() * 0xffffffff);
  private lastFrameTimeMs = 0;

  // werift RTCRtpSender
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sender: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private audioSender: any = null;

  private audioCapture: AudioCapture | null = null;

  // Metrics
  private frameCount = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private currentWidth = 0;
  private currentHeight = 0;
  private encoderRestarting = false;

  constructor(session: BrowserSession) {
    this.session = session;
    this.encoder = new Vp8Encoder();

    // If FFmpeg dies, stop streaming and surface the error
    this.encoder.on('error', (err: Error) => {
      console.error('[WebRTC] Encoder error:', err.message);
      this.streaming = false;
    });
  }

  onIceCandidate(callback: (candidate: unknown) => void): void {
    this.iceCandidateCallback = callback;
  }

  async processOffer(offerSdp: string): Promise<string> {
    this.pc = new RTCPeerConnection({
      iceServers: getConfiguredIceServers(),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.pc as any).onicecandidate = (event: { candidate: unknown }) => {
      if (event.candidate && this.iceCandidateCallback) {
        this.iceCandidateCallback(event.candidate);
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      console.log(`[WebRTC] Connection state: ${state}`);
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.streaming = false;
      }
    };

    // Add send-only video transceiver
    const transceiver = this.pc.addTransceiver('video', { direction: 'sendonly' });
    this.sender = transceiver.sender;

    // Add send-only audio transceiver for the Opus audio track
    const audioTransceiver = this.pc.addTransceiver('audio', { direction: 'sendonly' });
    this.audioSender = audioTransceiver.sender;

    const offer = new RTCSessionDescription(offerSdp, 'offer');
    await this.pc.setRemoteDescription(offer);

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    console.log('[WebRTC] Offer processed, answer created');
    console.log('[WebRTC] Answer SDP snippet:', (answer.sdp || '').slice(0, 300));
    return answer.sdp || '';
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc) return;
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (e) {
      console.error('[WebRTC] Failed to add ICE candidate:', e);
    }
  }

  startStreaming(): void {
    if (this.streaming) return;
    if (!this.pc || !this.sender) {
      console.error('[WebRTC] Cannot start streaming - no peer connection or sender');
      return;
    }

    const { width, height } = this.session.getViewport();
    this.encoder.start(width, height);
    this.streaming = true;

    // Feed JPEG frames from browser into the VP8 encoder.
    // If the frame dimensions change (responsive resolution), restart the
    // encoder so FFmpeg is configured for the new resolution.
    this.session.onFrame((jpegData: Buffer, frameWidth: number, frameHeight: number) => {
      if (!this.streaming) return;

      if (frameWidth > 0 && frameHeight > 0 &&
          (frameWidth !== this.currentWidth || frameHeight !== this.currentHeight)) {
        this.currentWidth = frameWidth;
        this.currentHeight = frameHeight;
        if (!this.encoderRestarting) {
          this.encoderRestarting = true;
          // Restart encoder with new dimensions (drop any queued frames)
          this.encoder.stop();
          this.encoder.start(frameWidth, frameHeight);
          this.encoderRestarting = false;
        }
      }

      this.encoder.writeJpeg(jpegData, frameWidth, frameHeight);
    });

    // When VP8 frames come out, send them as RTP
    this.encoder.on('frame', (vp8Frame: Vp8Frame) => {
      if (!this.streaming) return;
      this.sendVp8Frame(vp8Frame.data);
    });

    // Start audio capture and forward RTP packets through the audio transceiver.
    // Audio is best-effort: if PulseAudio is unavailable, video continues.
    this.audioCapture = new AudioCapture();
    this.audioCapture.on('packet', (pkt: Buffer) => {
      if (!this.streaming || !this.audioSender) return;
      try {
        this.audioSender.sendRtp(pkt);
      } catch { /* peer not ready; swallow */ }
    });
    this.audioCapture.on('error', (err: Error) => {
      console.error('[WebRTC] Audio capture error (non-fatal, continuing video):', err.message);
    });
    this.audioCapture.start();

    // Log encoder stats periodically
    this.statsTimer = setInterval(() => {
      if (!this.streaming) {
        if (this.statsTimer) clearInterval(this.statsTimer);
        this.statsTimer = null;
        return;
      }
      const stats = this.encoder.getStats();
      console.log(`[WebRTC] Encoder stats: ${stats.encodeFps}fps in, ${stats.droppedFrames} dropped, queue=${stats.queueSize}`);
    }, 10000);

    console.log('[WebRTC] Streaming started');
  }

  private sendVp8Frame(vp8Data: Buffer): void {
    if (!this.sender) return;

    const now = Date.now();
    const elapsed = this.lastFrameTimeMs > 0 ? now - this.lastFrameTimeMs : 33;
    this.lastFrameTimeMs = now;

    // Advance RTP timestamp proportional to real elapsed time
    const tsDelta = Math.round((elapsed * CLOCK_RATE) / 1000);
    this.timestamp = (this.timestamp + tsDelta) >>> 0;

    const rtpPackets = packetizeVp8Frame(vp8Data, this.ssrc, this.sequenceNumber, this.timestamp);

    for (const pkt of rtpPackets) {
      try {
        // sendRtp accepts Buffer directly (werift 0.24.x)
        this.sender.sendRtp(pkt);
      } catch {
        // Peer may not be connected yet; swallow silently
      }
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
    }

    this.frameCount++;
    if (this.frameCount % 60 === 0) {
      console.log(`[WebRTC] ${this.frameCount} frames sent, last ${vp8Data.length}B`);
    }
  }

  async stop(): Promise<void> {
    this.streaming = false;
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.currentWidth = 0;
    this.currentHeight = 0;
    this.encoderRestarting = false;
    this.encoder.stop();
    if (this.audioCapture) {
      this.audioCapture.stop();
      this.audioCapture = null;
    }
    this.audioSender = null;
    if (this.pc) {
      try { this.pc.close(); } catch { /* ignore */ }
      this.pc = null;
    }
    this.sender = null;
    this.frameCount = 0;
    console.log('[WebRTC] Streaming stopped');
  }

  isStreaming(): boolean {
    return this.streaming;
  }
}
