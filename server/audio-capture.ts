import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import dgram from 'dgram';

const OPUS_PAYLOAD_TYPE = 111;
const CLOCK_RATE = 48000;

/**
 * Captures audio from the remote Chromium session and produces RTP packets
 * suitable for sending through the existing WebRTC connection.
 *
 * Pipeline: Chromium → PulseAudio → FFmpeg (Opus encode) → RTP → UDP socket → werift sender
 *
 * FFmpeg sends RTP datagrams to a local UDP socket; each datagram is one
 * complete RTP packet. We rewrite the SSRC/sequence/timestamp to match the
 * werift sender's RTP state, then forward the packet via sender.sendRtp().
 *
 * If PulseAudio is unavailable (e.g. local macOS without a virtual sink),
 * FFmpeg fails to start and an 'error' event is emitted. The streamer treats
 * this as non-fatal: video continues, audio is simply absent.
 */
export class AudioCapture extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private udp: dgram.Socket | null = null;
  private running = false;
  private port = 0;

  // RTP state for rewriting
  private ssrc = Math.floor(Math.random() * 0xffffffff);
  private sequenceNumber = Math.floor(Math.random() * 0xffff);
  private timestamp = Math.floor(Math.random() * 0xffffffff);
  private lastPacketTime = 0;

  start(): void {
    if (this.running) return;
    this.running = true;

    this.udp = dgram.createSocket('udp4');
    this.udp.on('message', (msg: Buffer) => {
      this.handleRtpPacket(msg);
    });
    this.udp.on('error', (err) => {
      console.error('[AudioCapture] UDP error:', err.message);
    });

    this.udp.bind(0, '127.0.0.1', () => {
      const addr = this.udp!.address();
      this.port = addr.port;
      this.startFfmpeg();
    });
  }

  private startFfmpeg(): void {
    // Capture from PulseAudio default sink, encode Opus, send RTP to our UDP socket.
    // -f pulse requires a running PulseAudio server (see Dockerfile / system deps).
    this.ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'pulse',
      '-i', 'default',
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'rtp',
      '-payload_type', String(OPUS_PAYLOAD_TYPE),
      `rtp://127.0.0.1:${this.port}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    // Log ALL stderr so we can see the real failure reason (e.g. "pulseaudio: ...",
    // "Unknown encoder 'libopus'", "Connection refused"). Filtering only lines
    // containing "error" hid critical diagnostics on Render.
    this.ffmpeg.stderr!.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.error('[AudioCapture] FFmpeg stderr:', msg);
    });

    this.ffmpeg.on('error', (err) => {
      console.error('[AudioCapture] FFmpeg process error:', err.message);
      this.emit('error', new Error(`Audio FFmpeg failed: ${err.message}`));
    });

    this.ffmpeg.on('close', (code, signal) => {
      if (this.running) {
        console.log(`[AudioCapture] FFmpeg exited code=${code} signal=${signal}`);
        this.running = false;
        this.emit('error', new Error(`Audio FFmpeg exited code=${code} signal=${signal}`));
      }
    });

    console.log(`[AudioCapture] Started audio capture (PulseAudio → Opus → RTP :${this.port})`);
  }

  private handleRtpPacket(pkt: Buffer): void {
    if (pkt.length < 12) return;

    const now = Date.now();
    const elapsed = this.lastPacketTime > 0 ? now - this.lastPacketTime : 20;
    this.lastPacketTime = now;

    // Advance RTP timestamp proportional to real elapsed time
    const tsDelta = Math.round((elapsed * CLOCK_RATE) / 1000);
    this.timestamp = (this.timestamp + tsDelta) >>> 0;

    // Copy and rewrite header to match our RTP state
    const out = Buffer.from(pkt);
    out.writeUInt16BE(this.sequenceNumber & 0xffff, 2);
    out.writeUInt32BE(this.timestamp >>> 0, 4);
    out.writeUInt32BE(this.ssrc >>> 0, 8);
    // Ensure payload type is correct (keep marker bit)
    out[1] = (out[1] & 0x80) | (OPUS_PAYLOAD_TYPE & 0x7f);

    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;

    this.emit('packet', out);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.ffmpeg) {
      try { this.ffmpeg.kill('SIGTERM'); } catch { /* ignore */ }
      this.ffmpeg = null;
    }
    if (this.udp) {
      try { this.udp.close(); } catch { /* ignore */ }
      this.udp = null;
    }
    console.log('[AudioCapture] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }
}