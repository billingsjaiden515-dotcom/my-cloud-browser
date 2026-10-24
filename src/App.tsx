import { useRef, useState, useCallback, useEffect } from 'react';
import {
  Play, Square, X, Maximize2, Minimize2, Settings, Sun, Moon,
  Monitor, Eye, EyeOff, AlertCircle, Globe, Loader2, Volume2, SlidersHorizontal,
  Activity,
} from 'lucide-react';
import { useRemoteBrowser } from '@/hooks/useRemoteBrowser';
import { BrowserViewport } from '@/components/BrowserViewport';
import { StatusIndicator } from '@/components/StatusIndicator';
import { useTheme, type Theme } from '@/contexts/ThemeContext';

const THEMES: { value: Theme; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: '💻' },
  { value: 'light',  label: 'Light',  icon: '☀️' },
  { value: 'dark',   label: 'Dark',   icon: '🌙' },
  { value: 'midnight', label: 'Midnight', icon: '🌌' },
  { value: 'ocean',  label: 'Ocean',  icon: '🌊' },
  { value: 'forest', label: 'Forest', icon: '🌲' },
  { value: 'navy', label: 'Navy', icon: '⚓' },
  { value: 'sage', label: 'Sage', icon: '🌿' },
  { value: 'cherry', label: 'Cherry', icon: '🍒' },
  { value: 'rose', label: 'Rose', icon: '🌹' },
  { value: 'amber', label: 'Amber', icon: '🔥' },
  { value: 'indigo', label: 'Indigo', icon: '🔮' },
  { value: 'mono', label: 'Mono', icon: '🌗' },
  { value: 'gold', label: 'Gold', icon: '💰' },
];

/**
 * Browser id -> human label. Used for the document title. The ids must match
 * server/browser-finder.ts BrowserInfo.name, since the dropdown is driven by
 * /api/browsers.
 */
const BROWSER_META: Record<string, { label: string }> = {
  chromium: { label: 'Chromium' },
  firefox:  { label: 'Firefox' },
  brave:    { label: 'Brave' },
  vivaldi:  { label: 'Vivaldi' },
  opera:    { label: 'Opera' },
  edge:     { label: 'Edge' },
  helium:   { label: 'Helium' },
  librewolf: { label: 'LibreWolf' },
  zen: { label: 'Zen' },
  floorp: { label: 'Floorp' },
  midori: { label: 'Midori' },
  waterfox: { label: 'Waterfox' },
};

// Audio bitrate mapping for Settings -> Audio -> Sound Quality.
const AUDIO_BITRATE: Record<'low' | 'medium' | 'high', number> = {
  low: 32000,
  medium: 64000,
  high: 128000,
};

/** GET /api/system-stats response (backend os-module snapshot). */
interface SystemStats {
  cpuLoad: number[]; // os.loadavg(): [1m, 5m, 15m]
  cores: number;
  totalMemMB: number;
  freeMemMB: number;
}

/** Target FPS options for Settings > Appearance > Stream Settings. */
const FPS_OPTIONS = ['15', '20', '30', '40', '60', 'unlimited'] as const;

// Tab Cloaking presets: clickable tiles that pre-fill the Title / Favicon inputs.
const CLOAK_PRESETS: { label: string; title: string; favicon: string }[] = [
  {
    label: 'YouTube',
    title: 'YouTube',
    favicon: 'data:image/png;base64,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',
  },
  {
    label: 'Google Drive',
    title: 'My Drive - Google Drive',
    favicon: 'https://drive.google.com/favicon.ico',
  },
  {
    label: 'Canvas (DSISD)',
    title: 'Dashboard',
    favicon: 'https://dsisd.instructure.com/favicon.ico',
  },
  {
    label: 'Canvas (Alt)',
    title: 'Dashboard',
    favicon: 'https://favicon.run/favicon?domain=dsisd.instructure.com&sz=48',
  },
  {
    label: 'Skyward',
    title: 'Login - Powered by Skyward',
    favicon: 'https://skyweb.dsisdtx.us/favicon.ico',
  },
  {
    label: 'Gmail',
    title: 'Inbox (899) - Michael.Towns@dsisdconnect.com - ...',
    favicon: 'https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico',
  },
  {
    label: 'iCEV',
    title: 'iCEV | Content | Principles Of Business - HILL - period 03 | Key Concepts ...',
    favicon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAyhpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDcuMS1jMDAwIDc5LjljY2M0ZGU5MywgMjAyMi8wMy8xNC0xNDowNzoyMiAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIDIzLjMgKE1hY2ludG9zaCkiIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6NjVFM0U5MDdCODEyMTFFQ0I5NDZCNjhENUIzNTg5REUiIHhtcE1NOkRvY3VtZW50SUQ9InhtcC5kaWQ6NjVFM0U5MDhCODEyMTFFQ0I5NDZCNjhENUIzNTg5REUiPiA8eG1wTU06RGVyaXZlZEZyb20gc3RSZWY6aW5zdGFuY2VJRD0ieG1wLmlpZDo2NUUzRTkwNUI4MTIxMUVDQjk0NkI2OEQ1QjM1ODlERSIgc3RSZWY6ZG9jdW1lbnRJRD0ieG1wLmRpZDo2NUUzRTkwNkI4MTIxMUVDQjk0NkI2OEQ1QjM1ODlERSIvPiA8L3JkZjpEZXNjcmlwdGlvbj4gPC9yZGY6UkRGPiA8L3g6eG1wbWV0YT4gPD94cGFja2V0IGVuZD0iciI/PktiPBoAAAGFSURBVHja7NO/S8NAFAfwe3fXYlN/YLXUof5At4KDOCp2E3FQRHFxdeiggw7+DeLg5uTo5G4RHUQ7Ogil4KIWUbEFLbaNSdv0cuc3Tu5u4sEnXN4Ll/fCCxlj2G8WZ79cf+AAuZvbZDLUnnl5Hnkq5CfHQ6F2GnEFN9AFAxCGEvTCMRRhEmbl3UeeMUOjp+epTK1aXhBSHSJRgxlYh0c4Aw8yELxgDo7gVVJbD9WqiZTXiC92WuoARe38qHAlqBKScAlrcAX7MAILsl5pTler+lap8DXneolInyBhG1TFiPUwwx4YowvEtNYyh1hW8PaW1mJPG3kvJlbHEpbVKJIMZ+v17iGl5LI2lOZcRTFjFSLVLUQrRVxNJeKFy0i4krfd/mErUt5OxG5c2sjO41CTJGoNOp/RmOtYca3IcN70fEV9xvguM+rN+H6Dk+srj9mO09WSwrYF917o3Sl9NxsMNCcj0EIU2w6jWTDkLi5NfGQ/uEFb388RQ1LzEPY+/f8L7EuAAQBY8agFnYgsqAAAAABJRU5ErkJggg==',
  },
  {
    label: 'HTMW',
    title: 'HowTheMarketWorks.com - Virtual Trading - Trading Stocks',
    favicon: 'https://www.howthemarketworks.com/wp-content/uploads/2016/12/cropped-touch-icon-ipad-retina-32x32.png',
  },
  {
    label: 'New Tab',
    title: 'New Tab',
    favicon: 'https://ssl.gstatic.com/gb/images/sprites/p_1x_dark.png',
  },
  {
    label: 'Google',
    title: 'Google',
    favicon: 'https://www.google.com/favicon.ico',
  },
];

// Named window target used by the proxy-style on-load spawn: the hidden anchor
// opens this named window, and window.open with the same name then recovers a
// reference to it so the cloak injection can run.
const CLOAK_WINDOW_NAME = 'cloud-browser-cloak';

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const api = useRemoteBrowser(videoRef);
  const { theme, setTheme } = useTheme();

  const [urlInput, setUrlInput] = useState('');
  const [immersive, setImmersive] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showError, setShowError] = useState(true);

  // ─── Audio settings (local Web Audio EQ + WebRTC bitrate) ───────────────
  // All four values default per spec; volume 100-300%, bass/treble ±12 dB,
  // quality Low/Medium/High -> 32/64/128 kbps. State is the source of truth;
  // BrowserViewport applies volume/bass/treble to the Web Audio graph and the
  // effect below applies quality -> maxBitrate on the RTCRtpSender.
  const [audioSettings, setAudioSettings] = useState<{
    volume: number;   // 100 .. 300
    bass: number;     // -12 .. +12 (dB)
    treble: number;   // -12 .. +12 (dB)
    quality: 'low' | 'medium' | 'high';
  }>({ volume: 100, bass: 0, treble: 0, quality: 'high' });

  const resetAudio = useCallback(() => {
    setAudioSettings({ volume: 100, bass: 0, treble: 0, quality: 'high' });
  }, []);

  // ─── Tab Cloaking state (persisted to localStorage) ──────────────────────
  const loadCloakState = <T,>(key: string, fallback: T): T => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  const saveCloakState = (key: string, value: unknown) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // localStorage unavailable or quota exceeded — silently ignore.
    }
  };

  const [customTitle, setCustomTitle] = useState<string>(() =>
    loadCloakState('cloak_customTitle', '')
  );
  const [customFavicon, setCustomFavicon] = useState<string>(() =>
    loadCloakState('cloak_customFavicon', '')
  );
  const [autoCloakEnabled, setAutoCloakEnabled] = useState<boolean>(() =>
    loadCloakState('cloak_autoCloakEnabled', false)
  );
  const [antiCloseEnabled, setAntiCloseEnabled] = useState<boolean>(() =>
    loadCloakState('cloak_antiCloseEnabled', false)
  );
  const [redirectMainTab, setRedirectMainTab] = useState(() => localStorage.getItem('cloak_redirectMainTab') === 'true');
  const [launchMethod, setLaunchMethod] = useState<'about:blank' | 'blob:'>(
    () => loadCloakState('cloak_launchMethod', 'about:blank')
  );
  // The target URL is stored RAW (localStorage.setItem, not JSON) so the
  // on-load redirect can read it directly with getItem(); accept both the raw
  // format and the legacy JSON-quoted value written by saveCloakState.
  const [cloakTargetUrl, setCloakTargetUrl] = useState<string>(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem('cloak_targetUrl');
    } catch {
      raw = null;
    }
    if (!raw) return 'https://google.com';
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'string' ? parsed || 'https://google.com' : raw;
    } catch {
      return raw; // raw (non-JSON) format written directly by the input
    }
  });

  useEffect(() => { saveCloakState('cloak_customTitle', customTitle); }, [customTitle]);
  useEffect(() => { saveCloakState('cloak_customFavicon', customFavicon); }, [customFavicon]);
  useEffect(() => { saveCloakState('cloak_autoCloakEnabled', autoCloakEnabled); }, [autoCloakEnabled]);
  useEffect(() => { saveCloakState('cloak_antiCloseEnabled', antiCloseEnabled); }, [antiCloseEnabled]);
  useEffect(() => { saveCloakState('cloak_launchMethod', launchMethod); }, [launchMethod]);
  // Raw (non-JSON) write: the on-load redirect reads this key with a plain
  // getItem(), so the value must be the bare URL, not a JSON-quoted string.
  useEffect(() => {
    try {
      localStorage.setItem('cloak_targetUrl', cloakTargetUrl);
    } catch {
      // localStorage unavailable or quota exceeded — silently ignore.
    }
  }, [cloakTargetUrl]);

  const [settingsTab, setSettingsTab] = useState<'appearance' | 'audio' | 'cloaking' | 'stream' | 'telemetry'>('appearance');

  // Stream tab settings, persisted to localStorage.
  const [streamResolution, setStreamResolution] = useState<string>('1920x1080');
  const [streamBitrate, setStreamBitrate] = useState<'low' | 'medium' | 'high'>('high');
  const [telemetryTab, setTelemetryTab] = useState<'debug' | 'specs' | 'stats'>('debug');
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const [webrtcDebug, setWebrtcDebug] = useState<{ signaling: string; ice: string; conn: string; audio: string }>({
    signaling: '—',
    ice: '—',
    conn: '—',
    audio: '—',
  });

  /** Live inbound-rtp (video) stats from RTCPeerConnection.getStats(). */
  const [rtpStats, setRtpStats] = useState<{
    fps: number | null;
    bitrateKbps: number | null;
    frameWidth: number | null;
    frameHeight: number | null;
    packetsLost: number | null;
    jitterMs: number | null;
    rttMs: number | null;
  }>({
    fps: null,
    bitrateKbps: null,
    frameWidth: null,
    frameHeight: null,
    packetsLost: null,
    jitterMs: null,
    rttMs: null,
  });

  // ─── Stream Settings (Target FPS) ──────────────────────────────────────────
  // Persisted under stream_fps (default 30) and POSTed to the backend on mount
  // and on every change, so the wiring is ready for the H.264 pipeline rewrite.
  const [targetFps, setTargetFps] = useState<string>(() => {
    try {
      const stored = localStorage.getItem('stream_fps');
      if (stored && (FPS_OPTIONS as readonly string[]).includes(stored)) return stored;
    } catch {
      // localStorage unavailable — fall through to the default.
    }
    return '30';
  });

  useEffect(() => {
    try {
      localStorage.setItem('stream_fps', targetFps);
    } catch {
      // localStorage unavailable — keep the in-memory value.
    }
    fetch('/api/stream-fps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fps: targetFps }),
    }).catch(() => {
      // Backend offline — the value is still persisted locally.
    });
  }, [targetFps]);

  const [selectedBrowser, setSelectedBrowser] = useState('chromium');
  // Which browser the CURRENT session actually launched. Tracked separately
  // from selectedBrowser because the dropdown is hidden while connected, and
  // because the user may change the selection before pressing Start -- the
  // favicon/title must describe what is running, not what is highlighted.
  const [runningBrowser, setRunningBrowser] = useState<string | null>(null);

  const { connectionState, error, currentUrl, currentTitle, availableBrowsers, setAudioBitrate, pcRef } = api;
  const isConnected = connectionState === 'connected';
  const isConnecting = connectionState === 'connecting';
  const isBusy = isConnecting;

  // Sync URL input with current URL, but NEVER while the user is editing the
  // input (focused) — overwriting a focused input's value mid-edit both eats
  // keystrokes and re-triggers the select-on-focus highlight.
  useEffect(() => {
    if (currentUrl && currentUrl !== 'about:blank') {
      const input = document.activeElement;
      const editing = input instanceof HTMLInputElement && input.type === 'text';
      if (!editing) setUrlInput(currentUrl);
    }
  }, [currentUrl]);

  useEffect(() => {
    if (error) setShowError(true);
  }, [error]);

  // Apply the selected Sound Quality -> maxBitrate on the audio RTCRtpSender.
  // Runs whenever connected or the quality changes, so the default "High"
  // (128000 kbps) is applied on session start and changes take effect live.
  useEffect(() => {
    if (!isConnected) return;
    setAudioBitrate(AUDIO_BITRATE[audioSettings.quality]).catch(() => {});
  }, [isConnected, audioSettings.quality, setAudioBitrate]);

  // Clear the running browser when the session ends WITHOUT going through
  // handleStop (crash, 410 session_dead, WebRTC drop). Without this the tab
  // keeps showing, say, the Firefox icon after a Firefox session died on its
  // own, which is exactly the "favicon reverts on disconnect" requirement.
  // Gated on a real transition so it does not fire on the initial render.
  const wasConnected = useRef(false);
  useEffect(() => {
    if (isConnected) {
      wasConnected.current = true;
    } else if (wasConnected.current) {
      wasConnected.current = false;
      setRunningBrowser(null);
    }
  }, [isConnected]);

  // ── Favicon + document title ──────────────────────────────────────────
  // While a session is running the dropdown is hidden, so the selection can
  // no longer be edited: the favicon must follow the browser that is ACTUALLY
  // running, not the dropdown value. Once disconnected, it falls back to the
  // current selection so the tab previews the browser you are about to start.
  // With no session and no meaningful selection it reverts to Chromium.
  // Favicon + document title ─────────────────────────────────────────────
  // The favicon set is driven by BROWSER_META, so any browser in the
  // dropdown must also have a public/favicon-<name>.svg tracked in the repo
  // and served by Vite. Chromium, Firefox, Brave, Vivaldi, and Opera all
  // resolve through the single generic link below, so no per-browser branch
  // is needed. (BROWSER_META keys: chromium, firefox, brave, vivaldi, opera.)

  const activeBrowser: string = isConnected ? (runningBrowser ?? selectedBrowser) : selectedBrowser;
  // Cache-busted favicon swap: Chrome caches favicons by URL string, so a raw
  // /favicon-<name>.svg href would stick on the first dropdown selection. A
  // page-wide version counter bumps on every change so each swap is a unique
  // URL that the browser re-fetches immediately.
  const [faviconVersion, setFaviconVersion] = useState(0);
  useEffect(() => {
    setFaviconVersion((v) => v + 1);
  }, [activeBrowser, isConnected]);

  // Main tab title follows the Custom Tab Title value: preset clicks store the
  // preset's long title, manual edits store the typed text, and clearing it
  // falls back to "Cloud Browser". Declared BEFORE the favicon effect below so
  // the connected-state browser label it applies in its default branch stays
  // authoritative when no custom title is set.
  useEffect(() => {
    document.title = customTitle || 'Cloud Browser';
  }, [customTitle]);

  useEffect(() => {
    // Tab Cloak overrides: custom title/favicon take precedence over the
    // default browser auto-logic. When both are empty, fall back to default.
    // (The main tab title is owned by the dedicated customTitle effect above.)
    if (customTitle || customFavicon) {
      let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      if (customFavicon) {
        link.type = 'image/png';
        link.href = customFavicon;
      } else {
        // Only the title was overridden; restore the default favicon.
        const name = BROWSER_META[activeBrowser] ? activeBrowser : 'chromium';
        // Edge uses a favicon.run URL; Vivaldi and Opera ship PNG icons directly;
        // all others use SVG wrappers from public/favicon-<name>.svg.
        const faviconUrl = name === 'edge'
          ? 'https://favicon.run/favicon?domain=explore.microsoft.com&sz=32'
          : (name === 'vivaldi' || name === 'opera')
            ? `/icons/${name}.png`
            : `/favicon-${name}.svg`;
        link.type = 'image/png';
        link.href = `${faviconUrl}?v=${faviconVersion}`;
      }
      return;
    }

    const name = BROWSER_META[activeBrowser] ? activeBrowser : 'chromium';
    const meta = BROWSER_META[name];

    // Reuse the <link> from index.html instead of appending a new one on every
    // change -- repeated appendChild calls accumulate dead link elements, and
    // browsers may keep using the first one, which would freeze the icon.
    let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = 'image/png';
    // Edge uses a favicon.run URL; Vivaldi and Opera ship PNG icons directly;
    // all others use SVG wrappers from public/favicon-<name>.svg.
    const faviconUrl = name === 'edge'
      ? 'https://favicon.run/favicon?domain=explore.microsoft.com&sz=32'
      : (name === 'vivaldi' || name === 'opera')
        ? `/icons/${name}.png`
        : `/favicon-${name}.svg`;
    link.href = `${faviconUrl}?v=${faviconVersion}`;
    document.title = isConnected ? `Cloud Browser (${meta.label})` : 'Cloud Browser';
  }, [customTitle, customFavicon, activeBrowser, faviconVersion, isConnected]);

  // Escape key to exit immersive
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && immersive && !isConnected) {
        setImmersive(false);
      }
      // F11 for fullscreen
      if (e.key === 'F11') {
        e.preventDefault();
        toggleFullscreen();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [immersive, isConnected]);

  // Track real fullscreen state
  useEffect(() => {
    const handler = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  // ─── Tab Cloak: preset application + reset ───────────────────────────────
  const applyPreset = useCallback((p: { label: string; title: string; favicon: string }) => {
    // Populate the input with the preset's LONG title. The grid tiles keep the
    // short label; this value drives the Custom Tab Title input, the main
    // tab's document.title, and — via cloakWindow's lookup falling through to
    // the stored value — the cloaked tab's title.
    setCustomTitle(p.title);
    setCustomFavicon(p.favicon);
  }, []);

  const resetCloak = useCallback(() => {
    setCustomTitle('');
    setCustomFavicon('');
  }, []);

  // ─── Tab Cloak: shared window wiring (manual launch + auto-cloak spawn) ───
  // Escape hatch + iframe + title/favicon injection for an already-opened
  // cloak window.
  const cloakWindow = useCallback((w: Window) => {
    // Cloaked tab title: look up the preset's `title` (the long, realistic
    // name) by the `label` currently in the input; free-typed text is used
    // as-is so a manual override in the Custom Tab Title input still wins.
    const matched = CLOAK_PRESETS.find(p => p.label === customTitle);
    const finalTitle = matched ? matched.title : customTitle;

    // Escape hatch: Escape closes the cloaked tab and returns focus to the
    // original Cloud Browser tab.
    w.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        w.close();
        window.focus();
      }
    });

    const applyCloak = () => {
      try {
        const doc = w.document;
        const iframe = doc.createElement('iframe');
        iframe.src = window.location.origin; // Loads the app itself
        iframe.style.cssText =
          'position:fixed; top:0; left:0; width:100%; height:100%; border:none;';
        iframe.allow =
          'microphone; camera; autoplay; clipboard-read; clipboard-write';
        doc.body.appendChild(iframe);

        // Update the new window's title and favicon.
        doc.title = finalTitle || 'Cloud Browser';
        let cloakLink = doc.querySelector<HTMLLinkElement>('link[rel~="icon"]');
        if (!cloakLink) {
          cloakLink = doc.createElement('link');
          cloakLink.rel = 'icon';
          doc.head.appendChild(cloakLink);
        }
        if (customFavicon) {
          cloakLink.type = 'image/png';
          cloakLink.href = customFavicon;
        }
      } catch (e) {
        console.warn('[Cloak] Failed to write iframe:', e);
      }
    };

    // about:blank is ready immediately; blob: may still be loading.
    if (w.document.readyState === 'complete') {
      applyCloak();
    } else {
      w.addEventListener('load', applyCloak, { once: true });
    }
  }, [customTitle, customFavicon]);

  // ─── Tab Cloak: launch a cloaked tab ─────────────────────────────────────
  // Single source of truth for opening + injecting a cloak window. The manual
  // button and the first-input fallback call it with no argument so it opens
  // the window itself; the on-load auto-cloak passes the window it already
  // grabbed via the named-target anchor trick so BOTH paths run this exact
  // same injection logic.
  const launchCloak = useCallback((existingWindow?: Window | null) => {
    let w: Window | null = existingWindow ?? null;
    if (!w) {
      if (launchMethod === 'blob:') {
        // Seed the blob document with the same resolved title; cloakWindow
        // re-applies it (plus favicon + iframe) once the window exists.
        const matched = CLOAK_PRESETS.find(p => p.label === customTitle);
        const finalTitle = matched ? matched.title : customTitle;
        const html = `<!DOCTYPE html><html><head><title>${finalTitle || 'Cloud Browser'}</title></head><body></body></html>`;
        const blob = new Blob([html], { type: 'text/html' });
        const blobUrl = URL.createObjectURL(blob);
        w = window.open(blobUrl, '_blank');
      } else {
        w = window.open('about:blank', '_blank');
      }
    }

    if (!w || w.closed) {
      console.warn('[Cloak] Popup blocked or window closed');
      return;
    }

    cloakWindow(w);
  }, [launchMethod, customTitle, cloakWindow]);

  const handleStart = useCallback(async () => {
    setUrlInput('');
    // Record the browser BEFORE awaiting, so the favicon flips the instant the
    // user commits to it. If start() fails the session never reaches
    // 'connected', so the isConnected gate above ignores this value and the
    // favicon is correct again without an explicit rollback.
    setRunningBrowser(selectedBrowser);
    await api.start(selectedBrowser);
  }, [api, selectedBrowser]);

  // ─── Tab Cloak: proxy-style auto-cloak on load ───────────────────────────
  // An anchor navigation is treated as user-initiated more liberally than
  // window.open, so on load we open a NAMED about:blank window via a hidden
  // anchor; window.open with the same target name then recovers a reference to
  // that already-open window (popup blockers only block CREATING windows, not
  // reusing existing ones), letting the cloak title/favicon/iframe injection
  // run. If the browser blocks the spawn anyway, fall back to firing
  // launchCloak on the first click/keydown/touchstart.
  const autoCloakInput = useRef(false);
  const autoCloakSpawnTried = useRef(false);
  useEffect(() => {
    // Never spawn from inside the cloaked tab's own iframe (the cloak window
    // hosts an iframe of this app) — otherwise every cloak would nest another.
    if (window.self !== window.top) return;

    const isAutoCloakEnabled = () => {
      try {
        return localStorage.getItem('cloak_autoCloakEnabled') === 'true';
      } catch {
        return false;
      }
    };

    // Proxy-style attempt: spawn the cloaked tab immediately on load (once).
    if (!autoCloakSpawnTried.current && isAutoCloakEnabled()) {
      autoCloakSpawnTried.current = true;

      // Respect the Launch Method setting: blob: seeds the spawned window with
      // the same HTML template the manual button uses; about:blank keeps the
      // original behavior. (saveCloakState writes JSON, so accept both the
      // JSON-quoted and the raw form of the stored value.)
      let spawnHref: string = 'about:blank';
      let storedMethod: unknown = null;
      try {
        const raw = localStorage.getItem('cloak_launchMethod');
        if (raw !== null) {
          try {
            storedMethod = JSON.parse(raw);
          } catch {
            storedMethod = raw;
          }
        }
      } catch {
        storedMethod = null;
      }
      if (storedMethod === 'blob:') {
        const matched = CLOAK_PRESETS.find(p => p.label === customTitle);
        const finalTitle = matched ? matched.title : customTitle;
        const html = `<!DOCTYPE html><html><head><title>${finalTitle || 'Cloud Browser'}</title></head><body></body></html>`;
        spawnHref = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      }

      const a = document.createElement('a');
      a.href = spawnHref;
      a.target = CLOAK_WINDOW_NAME;
      a.rel = 'opener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Grab the window the anchor opened. An EMPTY url means "return the
      // existing window WITHOUT navigating it" — passing 'about:blank' here
      // triggers a second navigation that replaces the document we are about to
      // inject into, leaving a blank tab. Then run the exact same launchCloak()
      // the manual button uses, handing it the captured reference so the
      // title/favicon/iframe injection is identical.
      const w = window.open('', CLOAK_WINDOW_NAME);
      if (w && !w.closed) {
        console.log('[Cloak] Proxy-style spawn succeeded on load');
        autoCloakInput.current = true;
        launchCloak(w);
        const isRedirectEnabled = localStorage.getItem('cloak_redirectMainTab') === 'true';
        const targetUrl = localStorage.getItem('cloak_targetUrl') || 'https://google.com';

        if (isRedirectEnabled) {
          // Slight delay ensures the new cloaked window grabs focus before the main tab navigates away
          setTimeout(() => {
            window.location.replace(targetUrl);
          }, 100);
        }
      } else {
        console.log('[Cloak] On-load spawn blocked; waiting for first input');
      }
    }

    // Fallback: wait for the first click/keydown/touchstart anywhere on the
    // page. Fires once, then removes the listeners.
    const handleFirstInput = () => {
      if (autoCloakInput.current) return;
      if (!isAutoCloakEnabled()) return;
      autoCloakInput.current = true;
      launchCloak();
      cleanup();
    };
    const cleanup = () => {
      document.removeEventListener('click', handleFirstInput);
      document.removeEventListener('keydown', handleFirstInput);
      document.removeEventListener('touchstart', handleFirstInput);
    };
    document.addEventListener('click', handleFirstInput);
    document.addEventListener('keydown', handleFirstInput);
    document.addEventListener('touchstart', handleFirstInput);
    return cleanup;
  }, [launchCloak]);

  // ─── Anti-Close Protection ───────────────────────────────────────────────
  // While enabled, closing the tab triggers the browser's native confirmation
  // dialog. The listener is attached only while the toggle is on and removed
  // on toggle-off and on unmount via the effect cleanup.
  useEffect(() => {
    if (!antiCloseEnabled) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // Triggers the browser's native confirmation dialog
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [antiCloseEnabled]);

  // ─── Telemetry ─────────────────────────────────────────────────────────────
  // Poll /api/system-stats every 5s and refresh the local WebRTC snapshot
  // every 1s — ONLY while the Telemetry settings tab is open. Switching away
  // (or closing Settings) tears both intervals down.
  useEffect(() => {
    if (!showSettings || settingsTab !== 'telemetry') return;

    let cancelled = false;
    const pollStats = async () => {
      try {
        const r = await fetch('/api/system-stats');
        if (!r.ok || cancelled) return;
        const d = (await r.json()) as SystemStats;
        if (!cancelled) setSystemStats(d);
      } catch {
        // Backend unreachable — keep the last snapshot.
      }
    };
    pollStats();
    const statsId = setInterval(pollStats, 5000);

    const readWebRTC = () => {
      const pc = pcRef.current;
      const audioTrack = pc?.getReceivers().find(r => r.track?.kind === 'audio')?.track ?? null;
      setWebrtcDebug({
        signaling: pc?.signalingState ?? '—',
        ice: pc?.iceConnectionState ?? '—',
        conn: pc?.connectionState ?? '—',
        audio: audioTrack ? audioTrack.readyState : pc ? 'no audio track' : '—',
      });
    };
    readWebRTC();
    const webrtcId = setInterval(readWebRTC, 1000);

    return () => {
      cancelled = true;
      clearInterval(statsId);
      clearInterval(webrtcId);
    };
  }, [showSettings, settingsTab, pcRef]);

  // Live WebRTC stats for Telemetry -> Stats: parsed from the full
  // getStats() report every 1s. Runs ONLY while the Stats sub-tab is open.
  useEffect(() => {
    if (!showSettings || settingsTab !== 'telemetry' || telemetryTab !== 'stats') return;
    let cancelled = false;
    const tick = async () => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const report = await pc.getStats();
        // Accumulate per-video inbound-rtp stats across ticks for the
        // bitrate delta, and separately capture FPS/resolution/packet loss.
        const video: {
          bytes: number | null;
          fps: number | null;
          frameWidth: number | null;
          frameHeight: number | null;
          packetsLost: number | null;
          jitter: number | null;
        } = {
          bytes: null,
          fps: null,
          frameWidth: null,
          frameHeight: null,
          packetsLost: null,
          jitter: null,
        };
        // Latest candidate-pair (the one with a currentRoundTripTime)
        let bestPair: { currentRoundTripTime?: number | null; bytesReceived?: number | null } | null = null;
        for (const s of report.values()) {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            const v: {
              bytes: number | null;
              fps: number | null;
              frameWidth: number | null;
              frameHeight: number | null;
              packetsLost: number | null;
              jitter: number | null;
            } = {
              bytes: typeof s.bytesReceived === 'number' ? s.bytesReceived : null,
              fps: typeof s.framesPerSecond === 'number' ? s.framesPerSecond : null,
              frameWidth: typeof s.frameWidth === 'number' ? s.frameWidth : null,
              frameHeight: typeof s.frameHeight === 'number' ? s.frameHeight : null,
              packetsLost: typeof s.packetsLost === 'number' ? s.packetsLost : null,
              jitter: typeof s.jitter === 'number' ? s.jitter : null,
            };
            if (v.bytes !== null) {
              if (video.bytes === null) video.bytes = v.bytes;
              // Keep the largest bytesReceived as the authoritative sample.
              if (v.bytes > (video.bytes as number)) video.bytes = v.bytes;
            }
            // FPS + resolution come straight from the report (single value).
            if (v.fps !== null) video.fps = v.fps;
            if (v.frameWidth !== null && v.frameHeight !== null) {
              video.frameWidth = v.frameWidth;
              video.frameHeight = v.frameHeight;
            }
            if (v.packetsLost !== null) video.packetsLost = v.packetsLost;
            if (v.jitter !== null) video.jitter = v.jitter;
          } else if (s.type === 'candidate_pair' && typeof s.currentRoundTripTime === 'number') {
            // The "remote candidate" pair with the current RTT is the active one.
            if (bestPair === null || (s as { currentRoundTripTime?: number }).currentRoundTripTime !== null) {
              bestPair = s as { currentRoundTripTime?: number | null; bytesReceived?: number | null };
            }
          }
        }
        // Compute 1s bitrate delta from bytesReceived change between ticks.
        let prev = video.bytes;
        if (prev !== null) {
          if (prev > 0) {
            const kbps = Math.round((prev * 8) / 1000);
            setRtpStats(prevState => {
              const rttMs = bestPair !== null && typeof bestPair.currentRoundTripTime === 'number'
                ? Math.round(bestPair.currentRoundTripTime * 1000)
                : prevState.rttMs ?? null;
              return {
                fps: prevState.fps ?? video.fps ?? null,
                bitrateKbps: kbps,
                frameWidth: video.frameWidth ?? prevState.frameWidth ?? null,
                frameHeight: video.frameHeight ?? prevState.frameHeight ?? null,
                packetsLost: video.packetsLost ?? prevState.packetsLost ?? null,
                jitterMs: video.jitter !== null ? Math.round(video.jitter * 1000) : prevState.jitterMs ?? null,
                rttMs,
              };
            });
          }
        }
        // Keep using a persistent pixel-accumulator for the delta-based kbps
        // across ticks: stash it at module scope of this effect.
        if (cancelled) return;
        prev = video.bytes;
      } catch {
        // getStats() unavailable (e.g. no peer connection yet) — keep last values.
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [showSettings, settingsTab, telemetryTab, pcRef]);

  const handleStop = useCallback(async () => {
    await api.stop();
    setUrlInput('');
    setImmersive(false);
    setRunningBrowser(null);
  }, [api]);

  const handleNavigate = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const url = urlInput.trim();
    if (!url || !isConnected) {
      console.log(`[UI] Navigate blocked: url="${url}" connected=${isConnected}`);
      return;
    }
    console.log(`[UI] Navigate submit: ${url}`);
    api.navigate(url);
  }, [api, urlInput, isConnected]);

  // Browser logo component - supports SVG and PNG icons
  const BrowserLogo = ({ name, size = 16 }: { name: string; size?: number }) => {
    // Edge uses a favicon.run URL; Vivaldi and Opera ship PNG icons directly;
    // all others use SVG wrappers from public/favicon-<name>.svg.
    const defaultSrc = name === 'edge'
      ? 'https://favicon.run/favicon?domain=explore.microsoft.com&sz=32'
      : name === 'vivaldi' || name === 'opera'
        ? `/icons/${name}.png`
        : `/favicon-${name}.svg`;
    const [src, setSrc] = useState(defaultSrc);

    // Re-resolve the icon whenever the browser selection changes so the
    // displayed logo always matches the selected browser.
    useEffect(() => {
      setSrc(defaultSrc);
    }, [name, defaultSrc]);

    return (
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        className="shrink-0"
        onError={() => {
          if (name === 'edge' || src.endsWith('.png')) {
            (document.getElementById(`logo-${name}`) as HTMLImageElement).style.display = 'none';
          } else {
            setSrc(`/icons/${name}.png`);
          }
        }}
        id={`logo-${name}`}
      />
    );
  };

  return (
    <div
      className="flex flex-col h-full"
      style={{ background: 'var(--bg)', color: 'var(--text)' }}
    >
      {/* ─── Toolbar ──────────────────────────────────────────────────────────── */}
      {!immersive && (
        <div
          className="flex flex-col shrink-0 border-b"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
        >
          {/* Top bar: logo + controls + status */}
          <div className="flex items-center gap-2 px-3 h-[52px]">
            {/* Logo */}
            <div className="flex items-center gap-2 shrink-0 mr-1">
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center"
                style={{ background: 'var(--primary)', opacity: 0.9 }}
              >
                <Monitor className="w-4 h-4" style={{ color: 'var(--primary-text)' }} />
              </div>
              <span className="text-sm font-semibold hidden sm:block" style={{ color: 'var(--text)' }}>
                Cloud Browser
              </span>
            </div>

            {/* Address bar */}
            <form onSubmit={handleNavigate} className="flex-1 min-w-0">
              <div
                className="flex items-center gap-2 rounded-lg px-3 h-8 border transition-colors"
                style={{
                  background: 'var(--surface-2)',
                  borderColor: 'var(--border)',
                }}
              >
                <Globe className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--muted)' }} />
                <input
                  type="text"
                  value={urlInput}
                  onChange={e => setUrlInput(e.target.value)}
                  placeholder={isConnected ? 'Enter URL or search…' : 'Start a session to browse'}
                  disabled={!isConnected}
                  className="flex-1 min-w-0 bg-transparent text-sm outline-none"
                  style={{ color: 'var(--text)' }}
                  onFocus={e => {
                    // Select all only on genuine user focus (mouse click /
                    // tab into). Programmatic focus during re-renders must
                    // NOT re-select, or the bar looks stuck highlighted.
                    if (e.target !== document.activeElement) {
                      e.target.select();
                    } else {
                      requestAnimationFrame(() => e.target.select());
                    }
                  }}
                />
              </div>
            </form>

            {/* Browser selector */}
            {!isConnected && (
              <div className="flex items-center gap-1 shrink-0">
                <div
                  className="flex items-center gap-1 rounded-lg border px-2 h-8"
                  style={{ background: 'var(--surface-2)', borderColor: 'var(--border)' }}
                >
                  <BrowserLogo name={selectedBrowser} size={14} />
                  <select
                    value={selectedBrowser}
                    onChange={e => setSelectedBrowser(e.target.value)}
                    className="bg-transparent text-xs outline-none pr-1"
                    style={{ color: 'var(--text)' }}
                  >
                    {availableBrowsers.length > 0 ? availableBrowsers.map(b => (
                      <option key={b.name} value={b.name} disabled={!b.available}>
                        {b.displayName}{!b.available ? ' (unavailable)' : ''}
                      </option>
                    )) : (
                      <option value="chromium">Chromium</option>
                    )}
                  </select>
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-1.5 shrink-0">
              {!isConnected && !isConnecting && (
                <button
                  onClick={handleStart}
                  disabled={isBusy}
                  className="flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-semibold transition-colors"
                  style={{ background: 'var(--primary)', color: 'var(--primary-text)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--primary-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'var(--primary)')}
                >
                  <Play className="w-3.5 h-3.5" />
                  Start
                </button>
              )}
              {(isConnected || isConnecting) && (
                <button
                  onClick={handleStop}
                  className="flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-semibold text-white bg-red-600 hover:bg-red-500 transition-colors"
                >
                  <Square className="w-3.5 h-3.5" />
                  Disconnect
                </button>
              )}
            </div>

            {/* Right-side controls */}
            <div className="flex items-center gap-0.5 shrink-0 ml-1">
              <StatusIndicator state={connectionState} compact />

              <ToolbarBtn
                icon={<EyeOff className="w-4 h-4" />}
                onClick={() => setImmersive(true)}
                title="Immersive mode (hide toolbar)"
              />
              <ToolbarBtn
                icon={fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                onClick={toggleFullscreen}
                title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              />
              <ToolbarBtn
                icon={<Settings className="w-4 h-4" />}
                onClick={() => setShowSettings(s => !s)}
                title="Settings"
              />
            </div>
          </div>
        </div>
      )}

      {/* Immersive restore handle */}
      {immersive && (
        <div
          className="absolute top-0 left-1/2 -translate-x-1/2 z-50 pt-0.5"
          style={{ zIndex: 50 }}
        >
          <button
            onClick={() => setImmersive(false)}
            className="flex items-center gap-1.5 px-3 py-1 rounded-b-lg text-xs font-medium transition-all"
            style={{
              background: 'var(--surface)',
              color: 'var(--muted)',
              border: '1px solid var(--border)',
              borderTop: 'none',
            }}
          >
            <Eye className="w-3 h-3" />
            Show toolbar
          </button>
        </div>
      )}

      {/* Error banner */}
      {error && showError && (
        <div
          className="flex items-start gap-3 px-4 py-2.5 shrink-0"
          style={{ background: 'rgba(239,68,68,0.1)', borderBottom: '1px solid rgba(239,68,68,0.3)' }}
        >
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <p className="flex-1 text-xs text-red-300">{error}</p>
          <button onClick={() => setShowError(false)} className="text-red-400 hover:text-red-300">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Settings panel — full-screen glass modal */}
      {showSettings && !immersive && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4"
          onClick={() => setShowSettings(false)}
        >
          <div
            className="relative w-full max-w-5xl h-[80vh] backdrop-blur-xl bg-slate-900/80 border border-white/10 rounded-2xl shadow-2xl flex overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Large close button (top right) */}
            <button
              onClick={() => setShowSettings(false)}
              aria-label="Close settings"
              className="absolute top-4 right-4 z-10 p-2 rounded-lg bg-slate-900/70 border border-white/10 text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="w-6 h-6" />
            </button>

            {/* Sidebar */}
            <aside className="w-[200px] shrink-0 border-r border-white/10 p-4 flex flex-col gap-2 bg-white/5">
              <button
                onClick={() => setSettingsTab('appearance')}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors text-left ${settingsTab === 'appearance' ? 'bg-primary border-primary' : 'border-transparent hover:bg-white/10'}`}
                style={{ color: settingsTab === 'appearance' ? 'var(--primary-text)' : 'var(--muted)' }}
              >
                <Sun className="w-4 h-4" /> Appearance
              </button>
              <button
                onClick={() => setSettingsTab('audio')}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors text-left ${settingsTab === 'audio' ? 'bg-primary border-primary' : 'border-transparent hover:bg-white/10'}`}
                style={{ color: settingsTab === 'audio' ? 'var(--primary-text)' : 'var(--muted)' }}
              >
                <Volume2 className="w-4 h-4" /> Audio
              </button>
              <button
                onClick={() => setSettingsTab('cloaking')}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors text-left ${settingsTab === 'cloaking' ? 'bg-primary border-primary' : 'border-transparent hover:bg-white/10'}`}
                style={{ color: settingsTab === 'cloaking' ? 'var(--primary-text)' : 'var(--muted)' }}
              >
                <Globe className="w-4 h-4" /> Cloaking
              </button>
              <button
                onClick={() => setSettingsTab('stream')}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors text-left ${settingsTab === 'stream' ? 'bg-primary border-primary' : 'border-transparent hover:bg-white/10'}`}
                style={{ color: settingsTab === 'stream' ? 'var(--primary-text)' : 'var(--muted)' }}
              >
                <Monitor className="w-4 h-4" /> Stream
              </button>
              <button
                onClick={() => setSettingsTab('telemetry')}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors text-left ${settingsTab === 'telemetry' ? 'bg-primary border-primary' : 'border-transparent hover:bg-white/10'}`}
                style={{ color: settingsTab === 'telemetry' ? 'var(--primary-text)' : 'var(--muted)' }}
              >
                <Activity className="w-4 h-4" /> Telemetry
              </button>
            </aside>

            {/* Scrollable content area */}
            <main className="flex-1 min-w-0 overflow-y-auto p-6 pr-14">
          <div className="space-y-1" style={{ display: settingsTab === 'appearance' ? 'block' : 'none' }}>
            {THEMES.map(t => (
              <button
                key={t.value}
                onClick={() => setTheme(t.value)}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left"
                style={{
                  background: theme === t.value ? 'var(--primary)' : 'transparent',
                  color: theme === t.value ? 'var(--primary-text)' : 'var(--text)',
                }}
                onMouseEnter={e => {
                  if (theme !== t.value) e.currentTarget.style.background = 'var(--surface-2)';
                }}
                onMouseLeave={e => {
                  if (theme !== t.value) e.currentTarget.style.background = 'transparent';
                }}
              >
                <span>{t.icon}</span>
                {t.label}
                {t.value === 'system' && (
                  window.matchMedia('(prefers-color-scheme: dark)').matches
                    ? <Moon className="w-3 h-3 ml-auto opacity-50" />
                    : <Sun className="w-3 h-3 ml-auto opacity-50" />
                )}
              </button>
            ))}
          </div>
          <div className="space-y-3" style={{ display: settingsTab === 'appearance' ? 'block' : 'none' }}>
            <div className="pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
              <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
                <span>Stream Settings</span>
              </div>
              <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
                <span>Target FPS</span>
                <span>{targetFps === 'unlimited' ? 'Unlimited' : targetFps}</span>
              </div>
              <select
                value={targetFps}
                onChange={e => setTargetFps(e.target.value)}
                className="w-full bg-surface-2 border rounded-lg text-xs cursor-pointer"
                style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: '0.5rem' }}
              >
                <option value="15">15</option>
                <option value="20">20</option>
                <option value="30">30</option>
                <option value="40">40</option>
                <option value="60">60</option>
                <option value="unlimited">Unlimited</option>
              </select>
            </div>
          </div>
          <div className="space-y-3" style={{ display: settingsTab === 'audio' ? 'block' : 'none' }}>
            <div>
              <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
                <span>Volume Boost</span>
                <span>{audioSettings.volume}%</span>
              </div>
              <input
                type="range"
                min="100"
                max="300"
                step="10"
                value={audioSettings.volume}
                onChange={e => setAudioSettings(s => ({ ...s, volume: Number(e.target.value) }))}
                className="w-full h-2 bg-surface-2 rounded-lg appearance-none cursor-pointer"
                style={{ accentColor: 'var(--primary)' }}
              />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
                <span>Bass Boost</span>
                <span>{audioSettings.bass} dB</span>
              </div>
              <input
                type="range"
                min="-12"
                max="12"
                step="1"
                value={audioSettings.bass}
                onChange={e => setAudioSettings(s => ({ ...s, bass: Number(e.target.value) }))}
                className="w-full h-2 bg-surface-2 rounded-lg appearance-none cursor-pointer"
                style={{ accentColor: 'var(--primary)' }}
              />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
                <span>Treble Boost</span>
                <span>{audioSettings.treble} dB</span>
              </div>
              <input
                type="range"
                min="-12"
                max="12"
                step="1"
                value={audioSettings.treble}
                onChange={e => setAudioSettings(s => ({ ...s, treble: Number(e.target.value) }))}
                className="w-full h-2 bg-surface-2 rounded-lg appearance-none cursor-pointer"
                style={{ accentColor: 'var(--primary)' }}
              />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
                <span>Sound Quality</span>
                <span>{audioSettings.quality === 'high' ? 'High' : audioSettings.quality === 'medium' ? 'Medium' : 'Low'}</span>
              </div>
              <select
                value={audioSettings.quality}
                onChange={e => setAudioSettings(s => ({ ...s, quality: e.target.value as 'low' | 'medium' | 'high' }))}
                className="w-full bg-surface-2 border rounded-lg text-xs cursor-pointer"
                style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: '0.5rem' }}
              >
                <option value="low">Low (32 kbps)</option>
                <option value="medium">Medium (64 kbps)</option>
                <option value="high">High (128 kbps)</option>
              </select>
            </div>
            <button
              onClick={resetAudio}
              className="w-full px-3 py-1.5 text-xs border rounded-lg transition-colors cursor-pointer"
              style={{ borderColor: 'var(--border)', color: 'var(--muted)', borderRadius: '0.5rem' }}
            >
              <SlidersHorizontal className="w-3 h-3 mr-2" /> Reset to Defaults
            </button>
          </div>
          {/* ─── Stream tab ─── */}
          <div
            className="space-y-3"
            style={{ display: settingsTab === 'stream' ? 'block' : 'none' }}
          >
            <div>
              <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
                <span>Target Resolution</span>
                <span>
                  {streamResolution === '1920x1080'
                    ? '1920x1080'
                    : streamResolution === '1280x720'
                      ? '1280x720'
                      : '854x480'}
                </span>
              </div>
              <select
                value={streamResolution}
                onChange={e => {
                  setStreamResolution(e.target.value);
                  localStorage.setItem('stream_resolution', e.target.value);
                }}
                className="w-full bg-surface-2 border rounded-lg text-xs cursor-pointer"
                style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: '0.5rem' }}
              >
                <option value="1920x1080">1920x1080 (Full HD)</option>
                <option value="1280x720">1280x720 (HD)</option>
                <option value="854x480">854x480 (SD)</option>
              </select>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
                <span>Target Bitrate</span>
                <span>
                  {streamBitrate === 'high' ? 'High (6Mbps)' : streamBitrate === 'medium' ? 'Medium (3Mbps)' : 'Low (1Mbps)'}
                </span>
              </div>
              <select
                value={streamBitrate}
                onChange={e => {
                  setStreamBitrate(e.target.value as 'low' | 'medium' | 'high');
                  localStorage.setItem('stream_bitrate', e.target.value);
                }}
                className="w-full bg-surface-2 border rounded-lg text-xs cursor-pointer"
                style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: '0.5rem' }}
              >
                <option value="high">High (6 Mbps)</option>
                <option value="medium">Medium (3 Mbps)</option>
                <option value="low">Low (1 Mbps)</option>
              </select>
            </div>
          </div>
        {/* ─── Tab Cloaking panel ─── */}
        <div
          className="space-y-3"
          style={{ display: settingsTab === 'cloaking' ? 'block' : 'none' }}
        >
          {/* Preset grid */}
          <div>
            <div className="text-xs mb-1" style={{ color: 'var(--muted)' }}>
              Presets
            </div>
            <div className="grid grid-cols-4 gap-1 mb-3">
              {CLOAK_PRESETS.map(p => (
                <button
                  key={p.label}
                  onClick={() => applyPreset(p)}
                  title={p.title}
                  className="flex flex-col items-center gap-1 px-1 py-2 rounded-lg border transition-colors cursor-pointer"
                  style={{
                    borderColor: 'var(--border)',
                    background: 'var(--surface-2)',
                    color: 'var(--text)',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = 'var(--surface)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = 'var(--surface-2)';
                  }}
                >
                  <img
                    src={p.favicon}
                    alt=""
                    className="w-6 h-6 rounded object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                  <span className="text-[10px] leading-none truncate" style={{ color: 'var(--muted)' }}>
                    {p.label}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Custom Tab Title input */}
          <div>
            <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
              <span>Custom Tab Title</span>
            </div>
            <input
              type="text"
              value={customTitle}
              onChange={e => setCustomTitle(e.target.value)}
              placeholder="Cloud Browser"
              className="w-full bg-surface-2 border rounded-lg text-xs outline-none"
              style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: '0.5rem' }}
            />
          </div>

          {/* Custom Favicon URL input */}
          <div>
            <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
              <span>Custom Favicon URL</span>
            </div>
            <input
              type="text"
              value={customFavicon}
              onChange={e => setCustomFavicon(e.target.value)}
              placeholder="https://example.com/favicon.ico"
              className="w-full bg-surface-2 border rounded-lg text-xs outline-none"
              style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: '0.5rem' }}
            />
          </div>

          {/* Reset overrides */}
          <button
            onClick={resetCloak}
            className="w-full px-3 py-1.5 text-xs border rounded-lg transition-colors cursor-pointer text-red-400"
            style={{ borderColor: 'var(--border)', borderRadius: '0.5rem' }}
          >
            <X className="w-3 h-3 mr-2" /> Reset overrides
          </button>

          <div className="pt-1 border-t" style={{ borderColor: 'var(--border)' }}>
            <div className="flex justify-between text-xs mb-2" style={{ color: 'var(--muted)' }}>
              <span>Auto-Cloak</span>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoCloakEnabled}
                  onChange={e => setAutoCloakEnabled(e.target.checked)}
                  className="accent-primary"
                />
                <span>On / Off</span>
              </label>
            </div>
            <div className="flex justify-between text-xs mb-2" style={{ color: 'var(--muted)' }}>
              <span>Anti-Close Protection</span>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={antiCloseEnabled}
                  onChange={e => setAntiCloseEnabled(e.target.checked)}
                  className="accent-primary"
                />
                <span>On / Off</span>
              </label>
            </div>
            <div className="flex justify-between text-xs mb-2" style={{ color: 'var(--muted)' }}>
              <span>Auto Redirect Tab</span>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={redirectMainTab}
                  onChange={e => {
                    const next = e.target.checked;
                    setRedirectMainTab(next);
                    localStorage.setItem('cloak_redirectMainTab', String(next));
                  }}
                  className="accent-primary"
                />
                <span>On / Off</span>
              </label>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
                <span>Launch Method</span>
              </div>
              <select
                value={launchMethod}
                onChange={e => setLaunchMethod(e.target.value as 'about:blank' | 'blob:')}
                className="w-full bg-surface-2 border rounded-lg text-xs cursor-pointer"
                style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: '0.5rem' }}
              >
                <option value="about:blank">about:blank</option>
                <option value="blob:">blob:</option>
              </select>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
                <span>Cloak Target URL</span>
              </div>
              <input
                type="text"
                value={cloakTargetUrl}
                onChange={e => setCloakTargetUrl(e.target.value)}
                placeholder="https://google.com"
                className="w-full bg-surface-2 border rounded-lg text-xs outline-none"
                style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: '0.5rem' }}
              />
            </div>
            <button
              onClick={() => launchCloak()}
              className="w-full px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors"
              style={{
                background: 'var(--primary)',
                color: 'var(--primary-text)',
                borderRadius: '0.5rem',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'var(--primary-hover)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'var(--primary)';
              }}
            >
              Launch Cloaked Tab
            </button>
          </div>
        </div>
        {/* ─── Telemetry panel ─── */}
        <div className="space-y-3" style={{ display: settingsTab === 'telemetry' ? 'block' : 'none' }}>
          {/* Sub-tabs: Debug | Specs | Stats */}
          <div className="flex gap-1">
            <button
              onClick={() => setTelemetryTab('debug')}
              className={`flex-1 px-2 py-1 text-[11px] rounded-lg border transition-colors ${telemetryTab === 'debug' ? 'bg-primary border-primary' : 'border-transparent text-muted hover:bg-surface-2'}`}
              style={{ color: telemetryTab === 'debug' ? 'var(--primary-text)' : 'var(--muted)' }}
            >
              Debug
            </button>
            <button
              onClick={() => setTelemetryTab('specs')}
              className={`flex-1 px-2 py-1 text-[11px] rounded-lg border transition-colors ${telemetryTab === 'specs' ? 'bg-primary border-primary' : 'border-transparent text-muted hover:bg-surface-2'}`}
              style={{ color: telemetryTab === 'specs' ? 'var(--primary-text)' : 'var(--muted)' }}
            >
              Specs
            </button>
            <button
              onClick={() => setTelemetryTab('stats')}
              className={`flex-1 px-2 py-1 text-[11px] rounded-lg border transition-colors ${telemetryTab === 'stats' ? 'bg-primary border-primary' : 'border-transparent text-muted hover:bg-surface-2'}`}
              style={{ color: telemetryTab === 'stats' ? 'var(--primary-text)' : 'var(--muted)' }}
            >
              Stats
            </button>
          </div>

          {/* Debug: live WebRTC + audio state from the existing RTCPeerConnection */}
          <div className="space-y-2" style={{ display: telemetryTab === 'debug' ? 'block' : 'none' }}>
            <div className="flex justify-between text-xs">
              <span style={{ color: 'var(--muted)' }}>Session</span>
              <span>{connectionState}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span style={{ color: 'var(--muted)' }}>Signaling State</span>
              <span>{webrtcDebug.signaling}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span style={{ color: 'var(--muted)' }}>ICE Connection</span>
              <span>{webrtcDebug.ice}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span style={{ color: 'var(--muted)' }}>Peer Connection</span>
              <span>{webrtcDebug.conn}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span style={{ color: 'var(--muted)' }}>Audio</span>
              <span>{webrtcDebug.audio}</span>
            </div>
          </div>

          {/* Specs: static stream/capture information */}
          <div className="space-y-2" style={{ display: telemetryTab === 'specs' ? 'block' : 'none' }}>
            <div className="flex justify-between text-xs gap-3">
              <span style={{ color: 'var(--muted)' }}>Active Browser</span>
              <span>{BROWSER_META[activeBrowser]?.label ?? activeBrowser}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span style={{ color: 'var(--muted)' }}>Current Encoder</span>
              <span>VP8</span>
            </div>
            <div className="flex justify-between text-xs">
              <span style={{ color: 'var(--muted)' }}>Resolution</span>
              <span>1920x1080</span>
            </div>
            <div className="flex justify-between text-xs gap-3">
              <span style={{ color: 'var(--muted)' }}>Capture Pipeline</span>
              <span className="text-right" style={{ wordBreak: 'break-word' }}>
                Puppeteer CDP screencast → VP8 encoder (werift) → WebRTC
              </span>
            </div>
          </div>

          {/* Stats: polled from /api/system-stats while the Telemetry tab is open */}
          <div className="space-y-3" style={{ display: telemetryTab === 'stats' ? 'block' : 'none' }}>
            {/* Stats: live WebRTC getStats() values, updated every 1s */}
            <div className="space-y-3" style={{ display: telemetryTab === 'stats' ? 'block' : 'none' }}>
              {rtpStats.fps !== null || rtpStats.bitrateKbps !== null ? (
                <>
                  <div>
                    <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
                      <span>FPS</span>
                      <span>{rtpStats.fps !== null ? `${rtpStats.fps}` : '—'}</span>
                    </div>
                    <div className="w-full h-2 rounded-full" style={{ background: 'var(--surface-2)' }}>
                      <div
                        className="h-2 rounded-full"
                        style={{ width: `${rtpStats.fps !== null ? Math.min(100, rtpStats.fps / 60 * 100) : 0}%`, background: 'var(--primary)' }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
                      <span>Bitrate</span>
                      <span>{rtpStats.bitrateKbps !== null ? `${rtpStats.bitrateKbps} kbps` : '—'}</span>
                    </div>
                    <div className="w-full h-2 rounded-full" style={{ background: 'var(--surface-2)' }}>
                      <div
                        className="h-2 rounded-full"
                        style={{ width: `${rtpStats.bitrateKbps !== null ? Math.min(100, rtpStats.bitrateKbps / 1000 * 100) : 0}%`, background: 'var(--primary)' }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
                      <span>Resolution</span>
                      <span>
                        {rtpStats.frameWidth !== null && rtpStats.frameHeight !== null
                          ? `${rtpStats.frameWidth}x${rtpStats.frameHeight}`
                          : '—'}
                      </span>
                    </div>
                    <div className="w-full h-2 rounded-full" style={{ background: 'var(--surface-2)' }}>
                      <div
                        className="h-2 rounded-full"
                        style={{ width: `${rtpStats.frameWidth !== null ? Math.min(100, rtpStats.frameWidth / 1920 * 100) : 0}%`, background: 'var(--primary)' }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
                      <span>Packet Loss</span>
                      <span>{rtpStats.packetsLost !== null ? `${rtpStats.packetsLost} pps` : '—'}</span>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
                      <span>Jitter</span>
                      <span>{rtpStats.jitterMs !== null ? `${rtpStats.jitterMs} ms` : '—'}</span>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--muted)' }}>
                      <span>RTT (Latency)</span>
                      <span>{rtpStats.rttMs !== null ? `${rtpStats.rttMs} ms` : '—'}</span>
                    </div>
                  </div>
                </>
              ) : (
                <span className="text-xs" style={{ color: 'var(--muted)' }}>
                  Waiting for WebRTC stats (getStats)…
                </span>
              )}
            </div>
            <br />
          </div>
        </div>
            </main>
          </div>
        </div>
    )}

      {/* ─── Viewport ─────────────────────────────────────────────────────────── */}
      <div
        className="flex-1 min-h-0 relative overflow-hidden"
        onClick={() => showSettings && setShowSettings(false)}
      >
        <BrowserViewport
          api={api}
          connectionState={connectionState}
          videoRef={videoRef}
          immersive={immersive}
          volume={audioSettings.volume}
          bass={audioSettings.bass}
          treble={audioSettings.treble}
          isConnecting={isConnecting}
          selectedBrowser={selectedBrowser}
        />
      </div>

      {/* ─── Page title bar (when connected) ─────────────────────────────────── */}
      {isConnected && currentTitle && !immersive && (
        <div
          className="shrink-0 flex items-center gap-2 px-3 py-1 border-t text-xs"
          style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
        >
          <BrowserLogo name={selectedBrowser} size={12} />
          <span className="truncate">{currentTitle}</span>
          <span className="ml-auto shrink-0">
            <StatusIndicator state={connectionState} />
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function ToolbarBtn({
  icon, onClick, disabled = false, title, active = false,
}: {
  icon: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      style={{
        color: active ? 'var(--primary)' : 'var(--muted)',
        background: active ? 'rgba(99,102,241,0.1)' : 'transparent',
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'var(--surface-2)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = active ? 'rgba(99,102,241,0.1)' : 'transparent'; }}
    >
      {icon}
    </button>
  );
}