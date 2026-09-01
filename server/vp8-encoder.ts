import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface Vp8Frame {
  data: Buffer;
  isKeyframe: boolean;
  timestamp: number; // ms
}

export interface EncoderStats {
  frameCount: number;
  droppedFrames: number;
  queueSize: number;
  encodeFps: number;
  inputFps: number;
  bitrate: string;
}

interface QueuedJpeg {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Encodes incoming JPEG frames to VP8 using FFmpeg.
 * Reads JPEG from stdin (image2pipe), outputs IVF-wrapped VP8 to stdout.
 *
 * The encoder uses a bounded queue: if the encoder is busy and a new frame
 * arrives while the queue is full, the oldest queued frame is dropped in
 * favor of the newest frame. This keeps end-to-end latency bounded.
 */
export class Vp8Encoder extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private recvBuf: Buffer = Buffer.alloc(0);
  private headerConsumed = false;
  private running = false;
  private startTime = Date.now();
  private frameCount = 0;
  private droppedFrames = 0;
  private queue: QueuedJpeg[] = [];
  private queueProcessing = false;
  private width = 1280;
  private height = 800;

  private readonly MAX_QUEUE = 2; // at most 2 pending frames beyond current encoding
  private readonly MIN_FRAME_INTERVAL_MS = 1000 / 30; // hard cap: never accept more than 30/s

  private lastWriteTime = 0;
  private statsStartTime = 0;
  private bitrate = '1500k';

  private ffmpegFailed = false;

  start(width: number, height: number, bitrate = '2000k'): void {
    if (this.running) return;
    this.running = true;
    this.startTime = Date.now();
    this.recvBuf = Buffer.alloc(0);
    this.headerConsumed = false;
    this.queue = [];
    this.queueProcessing = false;
    this.droppedFrames = 0;
    this.frameCount = 0;
    this.lastWriteTime = 0;
    this.statsStartTime = Date.now();
    this.ffmpegFailed = false;
    this.width = width;
    this.height = height;
    this.bitrate = bitrate;

    // Use ffmpeg to encode JPEG frames to VP8 IVF.
    // -deadline realtime + -lag-in-frames 0 + -auto-alt-ref 0 = low latency.
    // -cpu-used 6 = realtime quality/speed balance (8 was fastest but visibly blockier).
    // No -minrate (VBR under -maxrate cap) lets libvpx allocate bits for motion.
    // -qmin/-qmax bound quality so motion scenes don't collapse into blockiness.
    this.ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-framerate', '30',
      '-i', 'pipe:0',
      '-c:v', 'libvpx',
      '-b:v', bitrate,
      '-maxrate', bitrate,
      '-deadline', 'realtime',
      '-cpu-used', '6',
      '-lag-in-frames', '0',
      '-error-resilient', '1',
      '-auto-alt-ref', '0',
      '-qmin', '4',
      '-qmax', '56',
      '-keyint_min', '30',
      '-g', '90',
      '-f', 'ivf',
      'pipe:1',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.ffmpeg.stdout!.on('data', (chunk: Buffer) => {
      this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
      this.parseIvf();
    });

    // Log ALL stderr so we can see the real failure reason (e.g. "Unknown encoder",
    // "pulseaudio: ...", "Cannot open ..."). Filtering only lines containing
    // "error" hid critical diagnostics on Render.
    this.ffmpeg.stderr!.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.error('[VP8Encoder] FFmpeg stderr:', msg);
    });

    this.ffmpeg.on('error', (err) => {
      this.ffmpegFailed = true;
      console.error('[VP8Encoder] FFmpeg process error:', err.message);
      this.emit('error', new Error(`FFmpeg process failed: ${err.message}`));
    });

    this.ffmpeg.on('close', (code, signal) => {
      if (this.running) {
        // code is null when the process was killed by a signal (e.g. OOM-killer)
        console.log(`[VP8Encoder] FFmpeg exited code=${code} signal=${signal}`);
        this.running = false;
        this.ffmpeg = null;
        this.emit('error', new Error(`FFmpeg exited unexpectedly code=${code} signal=${signal}`));
      }
    });

    console.log(`[VP8Encoder] Started FFmpeg encoder ${width}x${height} @ ${bitrate}`);
  }

  /**
   * Write a JPEG frame buffer. Returns false if the frame was dropped
   * (rate-limited, encoder busy, or queue full).
   */
  writeJpeg(jpegData: Buffer, width?: number, height?: number): boolean {
    if (!this.running || !this.ffmpeg?.stdin?.writable || this.ffmpegFailed) {
      this.droppedFrames++;
      return false;
    }

    // Hard rate cap to avoid flooding FFmpeg
    const now = Date.now();
    if (now - this.lastWriteTime < this.MIN_FRAME_INTERVAL_MS) {
      this.droppedFrames++;
      return false;
    }

    // Bounded queue: if full, drop the OLDEST frame and enqueue the newest.
    if (this.queue.length >= this.MAX_QUEUE) {
      this.queue.shift();
      this.droppedFrames++;
    }

    this.queue.push({ data: jpegData, width: width || this.width, height: height || this.height });

    if (!this.queueProcessing) {
      this.processQueue();
    }

    return true;
  }

  private async processQueue(): Promise<void> {
    if (this.queueProcessing) return;
    this.queueProcessing = true;

    // Yield to the event loop between frames so we don't starve other work
    await new Promise(r => setImmediate(r));

    while (this.queue.length > 0 && this.running && this.ffmpeg?.stdin?.writable) {
      const frame = this.queue.shift()!;

      // Space writes a small amount to avoid blocking the event loop
      const ok = this.ffmpeg.stdin.write(frame.data);
      if (!ok) {
        // stdin buffer full: drop this frame and wait a tick
        this.droppedFrames++;
        await new Promise(r => setImmediate(r));
      } else {
        this.frameCount++;
      }

      await new Promise(r => setImmediate(r));
    }

    this.queueProcessing = false;
  }

  private parseIvf(): void {
    // Skip 32-byte IVF global header (DKIF magic)
    if (!this.headerConsumed) {
      if (this.recvBuf.length < 32) return;
      if (this.recvBuf.slice(0, 4).toString('ascii') === 'DKIF') {
        this.recvBuf = this.recvBuf.slice(32);
        this.headerConsumed = true;
      } else {
        // Not IVF, skip
        this.recvBuf = Buffer.alloc(0);
        return;
      }
    }

    // Parse IVF frames: 12-byte frame header + N bytes data
    while (this.recvBuf.length >= 12) {
      const frameSize = this.recvBuf.readUInt32LE(0);
      if (this.recvBuf.length < 12 + frameSize) break;

      const frameData = Buffer.from(this.recvBuf.slice(12, 12 + frameSize));
      this.recvBuf = this.recvBuf.slice(12 + frameSize);

      // VP8 keyframe detection: the first 3 bytes of the partition 0 data
      // contain the frame tag. Bit 0 = 0 means intra (keyframe).
      const isKeyframe = frameData.length >= 3 && (frameData[0] & 0x01) === 0;

      const timestamp = Date.now() - this.startTime;

      this.emit('frame', { data: frameData, isKeyframe, timestamp } as Vp8Frame);
    }
  }

  getStats(): EncoderStats {
    const now = Date.now();
    const elapsed = (now - this.statsStartTime) / 1000;
    return {
      frameCount: this.frameCount,
      droppedFrames: this.droppedFrames,
      queueSize: this.queue.length,
      encodeFps: elapsed > 0 ? Math.round(this.frameCount / elapsed) : 0,
      inputFps: elapsed > 0 ? Math.round((this.frameCount + this.droppedFrames) / elapsed) : 0,
      bitrate: this.bitrate,
    };
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.queue = [];
    this.queueProcessing = false;
    if (this.ffmpeg) {
      try { this.ffmpeg.stdin?.end(); } catch {}
      try { this.ffmpeg.kill('SIGTERM'); } catch {}
      this.ffmpeg = null;
    }
    this.recvBuf = Buffer.alloc(0);
    this.headerConsumed = false;
    console.log(`[VP8Encoder] Stopped (${this.frameCount} encoded, ${this.droppedFrames} dropped)`);
  }

  isRunning(): boolean {
    return this.running;
  }

  getDroppedFrames(): number {
    return this.droppedFrames;
  }
}