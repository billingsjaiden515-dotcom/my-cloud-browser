import { useCallback, useEffect, useRef } from 'react';
import type { RemoteBrowserApi, ConnectionState } from '@/hooks/useRemoteBrowser';
import { motion, AnimatePresence } from 'framer-motion';

// ── Resize debounce threshold (ms) ─────────────────────────────────────────────
const RESIZE_DEBOUNCE_MS = 150;

interface BrowserViewportProps {
  api: RemoteBrowserApi;
  connectionState: ConnectionState;
  videoRef: React.RefObject<HTMLVideoElement>;
  immersive: boolean;
  /** Local volume boost, 100-300 (% -> 1.0-3.0 gain). */
  volume: number;
  /** Bass shelf gain in dB (-12..12). */
  bass: number;
  /** Treble shelf gain in dB (-12..12). */
  treble: number;
  /** True from the Start click until the stream connects — drives the launch pad. */
  isConnecting: boolean;
  /** Browser chosen in the header dropdown — shown in the launch messages. */
  selectedBrowser: string;
  /** Live launch-pad status text from the WebRTC connection states (null = nothing to show). */
  loadingStage: string | null;
}

// Keys that need to be prevented from triggering browser shortcuts
const PREVENT_KEYS = new Set([
  'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
  'Tab','Escape','Enter','Backspace','Delete',
  'ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
  'Home','End','PageUp','PageDown',
  ' ',
]);

const KEY_MAP: Record<string, string> = {
  ' ': 'Space',
  'Control': 'Control',
  'Shift': 'Shift',
  'Alt': 'Alt',
  'Meta': 'Meta',
};

// Track which modifiers are currently held down
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

export function BrowserViewport({ api, connectionState, videoRef, immersive, volume, bass, treble, isConnecting, selectedBrowser, loadingStage }: BrowserViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isConnected = connectionState === 'connected';
  // Track drag state: which button is currently held down
  const dragRef = useRef<{ button: 'left' | 'right' | 'middle' } | null>(null);
  // Track actual viewport dimensions (not video element dimensions which may be 0 for WebRTC)
  const viewportRef = useRef<{ w: number; h: number }>({ w: 1920, h: 1200 });
  // Track last requested viewport size to prevent resize loops
  const lastViewportRequestRef = useRef<{ w: number; h: number }>({ w: 1280, h: 800 });
  // Local cursor echo overlay ref (FIX 3)
  const cursorRef = useRef<HTMLDivElement>(null);
  // Called when viewport actually changes (from setViewport response)
  const updateViewportRef = useCallback((w: number, h: number) => {
    viewportRef.current = { w, h };
  }, []);

  // ─── Local Web Audio graph ──────────────────────────────────────────────
  // Built lazily on session connect (a user gesture) to satisfy autoplay
  // policy. Chain: MediaElementSource(video) -> Bass(lowshelf ~200Hz) ->
  // Treble(highshelf ~3kHz) -> Gain(volume) -> AudioContext.destination.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bassRef = useRef<BiquadFilterNode | null>(null);
  const trebleRef = useRef<BiquadFilterNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const graphBuiltRef = useRef(false);

  const buildAudioGraph = useCallback((videoEl: HTMLVideoElement) => {
    if (graphBuiltRef.current) return;
    const Ctx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const source = ctx.createMediaElementSource(videoEl);
    const bass = ctx.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = 200;
    const treble = ctx.createBiquadFilter();
    treble.type = 'highshelf';
    treble.frequency.value = 3000;
    const gain = ctx.createGain();
    source.connect(bass);
    bass.connect(treble);
    treble.connect(gain);
    gain.connect(ctx.destination);
    // Max out the video element's own volume so the Web Audio gain node
    // performs the actual boost/EQ rather than being capped by the element.
    videoEl.volume = 1.0;
    audioCtxRef.current = ctx;
    bassRef.current = bass;
    trebleRef.current = treble;
    gainRef.current = gain;
    graphBuiltRef.current = true;
    if (ctx.state === 'suspended') {
      // AudioContext resume requires a user gesture; it may be blocked until
      // the user interacts with the page (e.g. the Start click).
      ctx.resume().catch(() => {
        // Intentional no-op: resume is best-effort until a gesture occurs.
      });
    }
  }, []);

  // Push React slider values into the live Web Audio nodes.
  useEffect(() => {
    if (!gainRef.current) return;
    gainRef.current.gain.value = volume / 100;
    if (bassRef.current) bassRef.current.gain.value = bass;
    if (trebleRef.current) trebleRef.current.gain.value = treble;
  }, [volume, bass, treble]);

  // Resume a suspended AudioContext via a direct user gesture on the video.
  // Browsers block AudioContext until the user interacts; the connect-effect
  // resume runs outside a gesture and may be rejected, so clicking the video
  // provides a valid gesture to unblock playback and make EQ/volume audible.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const resumeIfSuspended = async () => {
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch {
          // Resume may still be blocked; retry on next gesture.
        }
      }
    };
    video.addEventListener('click', resumeIfSuspended);
    return () => video.removeEventListener('click', resumeIfSuspended);
  }, [videoRef]);

  // NOTE: Coordinate mapping deliberately maps to the CAPTURE/video frame (which in
  // headful mode includes the browser chrome at the top). The server translates
  // capture coords -> page viewport coords using its measured chrome offset, so we
  // must NOT apply an offset here (it would double-compensate).
  const getRelativeCoords = useCallback((e: { clientX: number; clientY: number }): { x: number; y: number; nx: number; ny: number } => {
    const video = videoRef.current;
    if (!video) return { x: 0, y: 0, nx: 0, ny: 0 };

    const rect = video.getBoundingClientRect();
    const ox = e.clientX - rect.left;
    const oy = e.clientY - rect.top;

    // Normalized pointer mapping: 0.0 to 1.0 percentages (FIX 2)
    const nx = rect.width > 0 ? ox / rect.width : 0;
    const ny = rect.height > 0 ? oy / rect.height : 0;

    // Scale to capture dimensions (1920x1200 for 16:10 native resolution)
    const width = viewportRef.current.w || 1920;
    const height = viewportRef.current.h || 1200;

    return {
      x: Math.floor(nx * width),
      y: Math.floor(ny * height),
      nx,
      ny,
    };
  }, [videoRef]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isConnected) return;
    e.preventDefault();
    containerRef.current?.focus();
    const { x, y } = getRelativeCoords(e);
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    // Guard: ignore a repeat press of the SAME button while it's already held
    // (synthetic repeats / double-fire) — a second down would desync the
    // server's virtual mouse ("'left' is already pressed").
    if (dragRef.current?.button === button) return;
    dragRef.current = { button };
    api.sendMouseDown(x, y, button);
    // Attach window-level listeners for reliable drag tracking outside video bounds
    const onMove = (we: MouseEvent) => {
      if (!dragRef.current) return;
      // Throttle drag moves to ~30fps (33ms) so the server isn't flooded mid-drag
      const now = performance.now();
      if (now - lastMouseMoveTime.current < 33) return;
      lastMouseMoveTime.current = now;
      const coords = getRelativeCoords(we);
      api.sendMouseMove(coords.x, coords.y);
    };
    const onUp = (we: MouseEvent) => {
      if (dragRef.current) {
        const coords = getRelativeCoords(we);
        api.sendMouseUp(coords.x, coords.y, dragRef.current.button);
        dragRef.current = null;
      }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [isConnected, getRelativeCoords, api]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!isConnected) return;
    e.preventDefault();
    if (dragRef.current) {
      const coords = getRelativeCoords(e);
      api.sendMouseUp(coords.x, coords.y, dragRef.current.button);
      dragRef.current = null;
    }
    // Window-level listeners are removed by the onUp callback itself
  }, [isConnected, getRelativeCoords, api]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!isConnected) return;
    e.preventDefault();
    const coords = getRelativeCoords(e);
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    api.sendMouseDoubleClick(coords.x, coords.y, button);
  }, [isConnected, getRelativeCoords, api]);

  const lastMouseMoveTime = useRef(0);
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isConnected) return;
    // Throttle mouse moves to ~30fps to avoid overwhelming server with HTTP requests
    const now = performance.now();
    if (now - lastMouseMoveTime.current < 33) return;
    lastMouseMoveTime.current = now;
    const coords = getRelativeCoords(e);
    api.sendMouseMove(coords.x, coords.y);
  }, [isConnected, getRelativeCoords, api]);

  // Native NON-PASSIVE wheel listener. React 17+ attaches onWheel passively
  // at the root, so e.preventDefault() inside a React onWheel handler is
  // invalid and spams "Unable to preventDefault inside passive event
  // listener" on every scroll (37+ observed in console). The wheel handler
  // must be a native listener with { passive: false }: it both blocks the
  // page's default scroll AND forwards the scroll to the remote browser.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !isConnected) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const coords = getRelativeCoords(e);
      api.sendMouseScroll(coords.x, coords.y, -e.deltaX, -e.deltaY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [isConnected, getRelativeCoords, api]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isConnected) return;
    // FIX 2: Prevent local browser from hijacking special keys
    const specialKeys = ['Space', 'Backspace', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (specialKeys.includes(e.key)) e.preventDefault();
    const key = KEY_MAP[e.key] || e.key;

    // Send modifier keys first so shortcuts like Ctrl+A work
    if (e.ctrlKey && !MODIFIER_KEYS.has(e.key)) api.sendKeyDown('Control');
    if (e.shiftKey && !MODIFIER_KEYS.has(e.key)) api.sendKeyDown('Shift');
    if (e.altKey && !MODIFIER_KEYS.has(e.key)) api.sendKeyDown('Alt');
    if (e.metaKey && !MODIFIER_KEYS.has(e.key)) api.sendKeyDown('Meta');

    // FIX 2: Transmit both e.key and e.code for Firefox compatibility
    api.sendKeyDown(key);
  }, [isConnected, api]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (!isConnected) return;
    const key = KEY_MAP[e.key] || e.key;

    api.sendKeyUp(key);

    // Release modifiers after the main key
    if (e.ctrlKey && !MODIFIER_KEYS.has(e.key)) api.sendKeyUp('Control');
    if (e.shiftKey && !MODIFIER_KEYS.has(e.key)) api.sendKeyUp('Shift');
    if (e.altKey && !MODIFIER_KEYS.has(e.key)) api.sendKeyUp('Alt');
    if (e.metaKey && !MODIFIER_KEYS.has(e.key)) api.sendKeyUp('Meta');
  }, [isConnected, api]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // Build the Web Audio graph on session connect — a user gesture (Start),
  // which satisfies the browser autoplay policy for AudioContext.
  useEffect(() => {
    if (!isConnected) return;
    const video = videoRef.current;
    if (video && !graphBuiltRef.current) buildAudioGraph(video);
  }, [isConnected, buildAudioGraph, videoRef]);

  // FIX 1: Liquid dynamic resizing — ResizeObserver sends exact dimensions over
  // WebRTC data channel when the container changes size (fullscreen toggle,
  // toolbar hide/show, device viewport change).
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendResizeViewport = useCallback((width: number, height: number) => {
    if (!api.sessionId) return;
    // Debounce resize messages to avoid flooding the server
    if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);
    resizeDebounceRef.current = setTimeout(() => {
      api.sendResizeViewport(width, height).catch(() => { /* best effort */ });
    }, RESIZE_DEBOUNCE_MS);
  }, [api.sessionId, api.sendResizeViewport]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(width * dpr);
        const h = Math.round(height * dpr);
        sendResizeViewport(w, h);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [sendResizeViewport]);

  // FIX 3: Local cursor echo — track container-level mouse position for
  // lag-free native cursor mirror within the stream area.
  useEffect(() => {
    const el = containerRef.current;
    const cursor = cursorRef.current;
    if (!el || !cursor) return;
    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
    };
    el.addEventListener('mousemove', onMove);
    return () => el.removeEventListener('mousemove', onMove);
  }, []);

  // Disconnect cleanup: release mouse buttons, clear modifiers, and close the
  // AudioContext so a fresh graph (and default levels) rebuild on reconnect.
  useEffect(() => {
    if (!isConnected) {
      if (dragRef.current) {
        api.sendMouseUp(0, 0, dragRef.current.button);
        dragRef.current = null;
      }
      ['Control', 'Shift', 'Alt', 'Meta'].forEach(mod => api.sendKeyUp(mod));
      if (audioCtxRef.current) {
        try { audioCtxRef.current.close(); } catch {
          // Close is best-effort on disconnect.
        }
        audioCtxRef.current = null;
      }
      bassRef.current = null;
      trebleRef.current = null;
      gainRef.current = null;
      graphBuiltRef.current = false;
    }
  }, [isConnected, api]);

  // NOTE: Viewport resizing removed. In headful mode (Xvfb) the Chromium
  // window has a fixed size set by --window-size at launch. CSS object-fit
  // stretches the video for display. Calling setViewport would physically
  // resize the X11 window and trigger a resize feedback loop.

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-gray-950 outline-none flex items-center justify-center"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      style={{
        // FIX 2 & FIX 3: Layout shift protection and cursor hiding
        userSelect: 'none',
        WebkitUserSelect: 'none',
        MozUserSelect: 'none',
        touchAction: 'none',
        cursor: 'none',
      }}
    >
      <motion.video
        ref={videoRef}
        autoPlay
        playsInline
        className="cursor-default select-none"
        initial={{ y: 150, opacity: 0 }}
        animate={isConnected ? { y: 0, opacity: 1 } : { y: 150, opacity: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        style={{
          display: isConnected ? 'block' : 'none',
          width: '100%',
          height: '100%',
          // FIX 2 & FIX 3: Layout shift protection and cursor hiding
          userSelect: 'none',
          WebkitUserSelect: 'none',
          MozUserSelect: 'none',
          touchAction: 'none',
          // Stretch: fill the entire video element so the whole tab strip is
          // visible with no black bars. object-fit: fill is the inline-style
          // equivalent of CSS `object-fit: fill`.
          objectFit: 'fill',
          objectPosition: 'center',
        }}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        onMouseMove={isConnected ? handleMouseMove : undefined}
        onContextMenu={handleContextMenu}
      />

      {/* FIX 3: Local cursor echo overlay — lag-free native cursor mirror */}
      <div
        ref={cursorRef}
        className="pointer-events-none z-50"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 0,
          height: 0,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            width: 12,
            height: 12,
            backgroundColor: '#ffffff',
            borderRadius: '50%',
            border: '2px solid #000000',
            boxShadow: '0 0 4px rgba(0,0,0,0.5)',
          }}
        />
      </div>

      {/* Rocket launch pad — shown while connecting; shoots up when the stream connects */}
      <AnimatePresence>
        {isConnecting && (
          <motion.div
            key="rocket-launch-pad"
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-6 pointer-events-none"
            exit={{ y: -1000, opacity: 0 }}
            transition={{ duration: 0.6, ease: 'easeIn' }}
          >
            <div className="relative flex flex-col items-center">
              <motion.div
                className="text-6xl leading-none select-none"
                animate={{ y: [0, -2, 2, -2, 2, 0] }}
                transition={{ repeat: Infinity, duration: 0.2 }}
              >
                🚀
              </motion.div>
              {/* Smoke puffs rising from the pad */}
              <div className="relative h-4 w-44">
                {[0, 1, 2].map(i => (
                  <motion.div
                    key={i}
                    className="absolute top-0 h-5 w-5 rounded-full bg-white/30"
                    style={{ left: `${20 + i * 30}%` }}
                    animate={{ scale: [0.3, 2.2], opacity: [0.7, 0] }}
                    transition={{ repeat: Infinity, duration: 1.4, delay: i * 0.35, ease: 'easeOut' }}
                  />
                ))}
              </div>
              {/* Launch pad */}
              <div className="h-3 w-44 rounded-full bg-gray-600 shadow-lg" />
            </div>
            <p className="font-mono text-green-400 text-sm text-center px-8">{loadingStage}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Overlay for non-connected states */}
      {!isConnected && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center space-y-4 px-8">
            {connectionState === 'disconnected' && (
              <>
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-surface mb-2">
                  <svg className="w-8 h-8 text-muted/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                    <rect x="2" y="3" width="20" height="14" rx="2"/>
                    <path d="M8 21h8M12 17v4"/>
                  </svg>
                </div>
                <p className="text-muted font-medium">No active session</p>
                <p className="text-xs text-muted/60">
                  {immersive ? 'Press Esc to show toolbar, then click Start' : 'Click Start Browser to begin'}
                </p>
              </>
            )}
            {connectionState === 'reconnecting' && (
              <>
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-2">
                  <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                </div>
                {/* Deliberately NOT "session ended": the session is very likely
                    still alive server-side. We are only retrying the media path. */}
                <p className="text-yellow-400 font-medium">Reconnecting…</p>
                <p className="text-xs text-muted/60">The remote browser is still running — retrying the video connection</p>
              </>
            )}
            {connectionState === 'failed' && (
              <>
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-red-500/10 mb-2">
                  <svg className="w-8 h-8 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 8v5M12 16h.01"/>
                  </svg>
                </div>
                <p className="text-red-400 font-medium">Connection failed</p>
                <p className="text-xs text-muted/60">{api.error ?? 'Check the error above and try again'}</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
