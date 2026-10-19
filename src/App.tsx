import { useRef, useState, useCallback, useEffect } from 'react';
import {
  Play, Square, X, Maximize2, Minimize2, Settings, Sun, Moon,
  Monitor, Eye, EyeOff, AlertCircle, Globe, Loader2, Volume2, SlidersHorizontal,
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
  const [launchMethod, setLaunchMethod] = useState<'about:blank' | 'blob:'>(
    () => loadCloakState('cloak_launchMethod', 'about:blank')
  );
  const [cloakTargetUrl, setCloakTargetUrl] = useState<string>(() =>
    loadCloakState('cloak_targetUrl', 'https://google.com')
  );

  useEffect(() => { saveCloakState('cloak_customTitle', customTitle); }, [customTitle]);
  useEffect(() => { saveCloakState('cloak_customFavicon', customFavicon); }, [customFavicon]);
  useEffect(() => { saveCloakState('cloak_autoCloakEnabled', autoCloakEnabled); }, [autoCloakEnabled]);
  useEffect(() => { saveCloakState('cloak_antiCloseEnabled', antiCloseEnabled); }, [antiCloseEnabled]);
  useEffect(() => { saveCloakState('cloak_launchMethod', launchMethod); }, [launchMethod]);
  useEffect(() => { saveCloakState('cloak_targetUrl', cloakTargetUrl); }, [cloakTargetUrl]);

  const [settingsTab, setSettingsTab] = useState<'appearance' | 'audio' | 'cloaking'>('appearance');

  const [selectedBrowser, setSelectedBrowser] = useState('chromium');
  // Which browser the CURRENT session actually launched. Tracked separately
  // from selectedBrowser because the dropdown is hidden while connected, and
  // because the user may change the selection before pressing Start -- the
  // favicon/title must describe what is running, not what is highlighted.
  const [runningBrowser, setRunningBrowser] = useState<string | null>(null);

  const { connectionState, error, currentUrl, currentTitle, availableBrowsers, setAudioBitrate } = api;
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

  useEffect(() => {
    // Tab Cloak overrides: custom title/favicon take precedence over the
    // default browser auto-logic. When both are empty, fall back to default.
    if (customTitle || customFavicon) {
      let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      document.title = customTitle || 'Cloud Browser';
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
    // Populate the input with the preset's short label ("Gmail", "HTMW", ...);
    // launchCloak maps it back to the preset's long title for the cloaked tab.
    setCustomTitle(p.label);
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
      const a = document.createElement('a');
      a.href = 'about:blank';
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
                active={showSettings}
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

      {/* Settings panel */}
      {showSettings && !immersive && (
        <div
          className="absolute right-3 z-40 rounded-xl border shadow-2xl p-4 w-64 animate-fadein"
          style={{
            top: immersive ? '8px' : '60px',
            background: 'var(--surface)',
            borderColor: 'var(--border)',
          }}
        >
          <button
            onClick={() => setShowSettings(false)}
            className="absolute top-3 right-3"
            style={{ color: 'var(--muted)' }}
          >
            <X className="w-4 h-4" />
          </button>
          <div className="flex gap-1 mb-3">
            <button
              onClick={() => setSettingsTab('appearance')}
              className={`flex-1 px-2 py-1.5 text-xs rounded-lg border transition-colors ${settingsTab === 'appearance' ? 'bg-primary border-primary' : 'border-transparent text-muted hover:bg-surface-2'}`}
              style={{ color: settingsTab === 'appearance' ? 'var(--primary-text)' : 'var(--muted)' }}
            >
              Appearance
            </button>
            <button
              onClick={() => setSettingsTab('audio')}
              className={`flex-1 px-2 py-1.5 text-xs rounded-lg border transition-colors ${settingsTab === 'audio' ? 'bg-primary border-primary' : 'border-transparent text-muted hover:bg-surface-2'}`}
              style={{ color: settingsTab === 'audio' ? 'var(--primary-text)' : 'var(--muted)' }}
            >
              <Volume2 className="w-3 h-3 mr-1" /> Audio
            </button>
            <button
              onClick={() => setSettingsTab('cloaking')}
              className={`flex-1 px-2 py-1.5 text-xs rounded-lg border transition-colors ${settingsTab === 'cloaking' ? 'bg-primary border-primary' : 'border-transparent text-muted hover:bg-surface-2'}`}
              style={{ color: settingsTab === 'cloaking' ? 'var(--primary-text)' : 'var(--muted)' }}
            >
              <Globe className="w-3 h-3 mr-1" /> Cloaking
            </button>
          </div>
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