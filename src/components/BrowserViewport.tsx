import { useCallback, useEffect, useRef } from 'react';
import type { RemoteBrowserApi, ConnectionState } from '@/hooks/useRemoteBrowser';

interface BrowserViewportProps {
  api: RemoteBrowserApi;
  connectionState: ConnectionState;
  videoRef: React.RefObject<HTMLVideoElement>;
  immersive: boolean;
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

export function BrowserViewport({ api, connectionState, videoRef, immersive }: BrowserViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isConnected = connectionState === 'connected';
  // Track drag state: which button is currently held down
  const dragRef = useRef<{ button: 'left' | 'right' | 'middle' } | null>(null);
  // Track actual viewport dimensions (not video element dimensions which may be 0 for WebRTC)
  const viewportRef = useRef<{ w: number; h: number }>({ w: 1280, h: 800 });
  // Track last requested viewport size to prevent resize loops
  const lastViewportRequestRef = useRef<{ w: number; h: number }>({ w: 1280, h: 800 });
  // Called when viewport actually changes (from setViewport response)
  const updateViewportRef = useCallback((w: number, h: number) => {
    viewportRef.current = { w, h };
  }, []);

  // NOTE: Coordinate mapping deliberately maps to the CAPTURE/video frame (which in
  // headful mode includes the browser chrome at the top). The server translates
  // capture coords -> page viewport coords using its measured chrome offset, so we
  // must NOT apply an offset here (it would double-compensate).
  const getRelativeCoords = useCallback((e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const video = videoRef.current;
    if (!video) return { x: 0, y: 0 };

    const rect = video.getBoundingClientRect();
    // Use the server-reported capture dimensions (window size incl. browser
    // chrome). fall back to the tracked viewport size. WebRTC streams report
    // video.videoWidth/videoHeight as 0, so we can't use those.
    const videoW = api.geometry?.width ?? viewportRef.current.w;
    const videoH = api.geometry?.height ?? viewportRef.current.h;

    // Account for object-contain letterboxing
    const videoAspect = videoW / videoH;
    const rectAspect = rect.width / rect.height;

    let renderedW: number, renderedH: number, offsetX: number, offsetY: number;
    if (videoAspect > rectAspect) {
      renderedW = rect.width;
      renderedH = rect.width / videoAspect;
      offsetX = 0;
      offsetY = (rect.height - renderedH) / 2;
    } else {
      renderedH = rect.height;
      renderedW = rect.height * videoAspect;
      offsetX = (rect.width - renderedW) / 2;
      offsetY = 0;
    }

    const scaleX = videoW / renderedW;
    const scaleY = videoH / renderedH;

    // Clamp to valid capture bounds (clicks in letterboxing bars get clamped to edge)
    return {
      x: Math.max(0, Math.min(videoW, Math.round((e.clientX - rect.left - offsetX) * scaleX))),
      y: Math.max(0, Math.min(videoH, Math.round((e.clientY - rect.top - offsetY) * scaleY))),
    };
  }, [videoRef, api.geometry]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isConnected) return;
    e.preventDefault();
    containerRef.current?.focus();
    const { x, y } = getRelativeCoords(e);
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    dragRef.current = { button };
    api.sendMouseDown(x, y, button);
    // Attach window-level listeners for reliable drag tracking outside video bounds
    const onMove = (we: MouseEvent) => {
      if (!dragRef.current) return;
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
      const { x, y } = getRelativeCoords(e);
      api.sendMouseUp(x, y, dragRef.current.button);
      dragRef.current = null;
    }
    // Window-level listeners are removed by the onUp callback itself
  }, [isConnected, getRelativeCoords, api]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!isConnected) return;
    e.preventDefault();
    const { x, y } = getRelativeCoords(e);
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    api.sendMouseDoubleClick(x, y, button);
  }, [isConnected, getRelativeCoords, api]);

  const lastMouseMoveTime = useRef(0);
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isConnected) return;
    // Throttle mouse moves to ~30fps to avoid overwhelming server with HTTP requests
    const now = performance.now();
    if (now - lastMouseMoveTime.current < 33) return;
    lastMouseMoveTime.current = now;
    const { x, y } = getRelativeCoords(e);
    api.sendMouseMove(x, y);
  }, [isConnected, getRelativeCoords, api]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!isConnected) return;
    e.preventDefault();
    const { x, y } = getRelativeCoords(e);
    api.sendMouseScroll(x, y, -e.deltaX, -e.deltaY);
  }, [isConnected, getRelativeCoords, api]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isConnected) return;
    if (PREVENT_KEYS.has(e.key)) e.preventDefault();
    const key = KEY_MAP[e.key] || e.key;

    // Send modifier keys first so shortcuts like Ctrl+A work
    if (e.ctrlKey && !MODIFIER_KEYS.has(e.key)) api.sendKeyDown('Control');
    if (e.shiftKey && !MODIFIER_KEYS.has(e.key)) api.sendKeyDown('Shift');
    if (e.altKey && !MODIFIER_KEYS.has(e.key)) api.sendKeyDown('Alt');
    if (e.metaKey && !MODIFIER_KEYS.has(e.key)) api.sendKeyDown('Meta');

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

  // Disconnect cleanup: release mouse buttons and clear modifiers on disconnect
  useEffect(() => {
    if (!isConnected) {
      if (dragRef.current) {
        api.sendMouseUp(0, 0, dragRef.current.button);
        dragRef.current = null;
      }
      ['Control', 'Shift', 'Alt', 'Meta'].forEach(mod => api.sendKeyUp(mod));
    }
  }, [isConnected, api]);

  // Passive wheel listener on the container to allow preventDefault
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => { if (isConnected) e.preventDefault(); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [isConnected]);

  // NOTE: Viewport resizing removed. In headful mode (Xvfb) the Chromium
  // window has a fixed 1280x800 size. CSS object-contain scales the video
  // for display. Calling setViewport would physically resize the X11 window
  // and trigger a resize feedback loop.

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-gray-950 outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className="w-full h-full object-contain cursor-default select-none"
        style={{ display: isConnected ? 'block' : 'none' }}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        onMouseMove={isConnected ? handleMouseMove : undefined}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
      />

      {/* Overlay for non-connected states */}
      {!isConnected && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center space-y-4 px-8">
            {connectionState === 'connecting' && (
              <>
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-2">
                  <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                </div>
                <p className="text-muted font-medium">Launching remote browser…</p>
                <p className="text-xs text-muted/60">Establishing WebRTC connection</p>
              </>
            )}
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
            {connectionState === 'failed' && (
              <>
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-red-500/10 mb-2">
                  <svg className="w-8 h-8 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 8v5M12 16h.01"/>
                  </svg>
                </div>
                <p className="text-red-400 font-medium">Connection failed</p>
                <p className="text-xs text-muted/60">Check the error above and try again</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
