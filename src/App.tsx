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
    favicon: 'https://www.youtube.com/s/desktop/5d669aa8/img/favicon_48x48.png',
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
    title: 'Skyward',
    favicon: 'https://skyweb.dsisdtx.us/favicon.ico',
  },
  {
    label: 'Gmail',
    title: 'Inbox - Gmail',
    favicon: 'https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico',
  },
  {
    label: 'iCEV',
    title: 'iCEV',
    favicon: 'https://a.favicon.im/login.icevonline.com',
  },
  {
    label: 'How The Market Works',
    title: 'How The Market Works',
    favicon: 'https://www.howthemarketworks.com/wp-content/uploads/2016/12/cropped-touch-icon-ipad-retina-32x32.png',
  },
];

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
  const [launchMethod, setLaunchMethod] = useState<'about:blank' | 'blob:'>(
    () => loadCloakState('cloak_launchMethod', 'about:blank')
  );

  useEffect(() => { saveCloakState('cloak_customTitle', customTitle); }, [customTitle]);
  useEffect(() => { saveCloakState('cloak_customFavicon', customFavicon); }, [customFavicon]);
  useEffect(() => { saveCloakState('cloak_autoCloakEnabled', autoCloakEnabled); }, [autoCloakEnabled]);
  useEffect(() => { saveCloakState('cloak_launchMethod', launchMethod); }, [launchMethod]);

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
        const faviconUrl = (name === 'vivaldi' || name === 'opera')
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
    // Vivaldi and Opera use their PNG icons from public/icons/ directly, so the
    // tab and the dropdown can't drift. Chromium, Firefox and Brave keep their
    // SVG favicon wrappers (which encode the full colour + transparency).
    const faviconUrl = (name === 'vivaldi' || name === 'opera')
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
    setCustomTitle(p.title);
    setCustomFavicon(p.favicon);
  }, []);

  const resetCloak = useCallback(() => {
    setCustomTitle('');
    setCustomFavicon('');
  }, []);

  // ─── Tab Cloak: launch a cloaked tab ─────────────────────────────────────
  const launchCloak = useCallback(() => {
    let w;
    if (launchMethod === 'blob:') {
      const html = `<!DOCTYPE html><html><head><title>${customTitle || 'Cloud Browser'}</title></head><body></body></html>`;
      const blob = new Blob([html], { type: 'text/html' });
      const blobUrl = URL.createObjectURL(blob);
      w = window.open(blobUrl, '_blank');
    } else {
      w = window.open('about:blank', '_blank');
    }

    if (!w || w.closed) {
      console.warn('[Cloak] Popup blocked or window closed');
      return;
    }

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
        doc.title = customTitle || 'Cloud Browser';
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
  }, [launchMethod, customTitle, customFavicon]);

  const handleStart = useCallback(async () => {
    // Auto-Cloak: launch a cloaked tab instead of starting the stream here.
    if (autoCloakEnabled) {
      launchCloak();
      return;
    }
    setUrlInput('');
    // Record the browser BEFORE awaiting, so the favicon flips the instant the
    // user commits to it. If start() fails the session never reaches
    // 'connected', so the isConnected gate above ignores this value and the
    // favicon is correct again without an explicit rollback.
    setRunningBrowser(selectedBrowser);
    await api.start(selectedBrowser);
  }, [api, selectedBrowser, autoCloakEnabled, launchCloak]);

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
    const [src, setSrc] = useState(`/icons/${name}.svg`);
    return (
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        className="shrink-0"
        onError={() => {
          // Try PNG fallback, then globe icon
          if (src.endsWith('.svg')) {
            setSrc(`/icons/${name}.png`);
          } else {
            (document.getElementById(`logo-${name}`) as HTMLImageElement).style.display = 'none';
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
                  title={p.label}
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
            <button
              onClick={launchCloak}
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