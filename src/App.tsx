import { useRef, useState, useCallback, useEffect } from 'react';
import {
  Play, Square, X, Maximize2, Minimize2, Settings, Sun, Moon,
  Monitor, Eye, EyeOff, AlertCircle, Globe, Loader2,
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
  const [selectedBrowser, setSelectedBrowser] = useState('chromium');

  const { connectionState, error, currentUrl, currentTitle, availableBrowsers } = api;
  const isConnected = connectionState === 'connected';
  const isConnecting = connectionState === 'connecting';
  const isBusy = isConnecting;

  // Sync URL input with current URL
  useEffect(() => {
    if (currentUrl && currentUrl !== 'about:blank') {
      setUrlInput(currentUrl);
    }
  }, [currentUrl]);

  useEffect(() => {
    if (error) setShowError(true);
  }, [error]);

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

  const handleStart = useCallback(async () => {
    setUrlInput('');
    await api.start(selectedBrowser);
  }, [api, selectedBrowser]);

  const handleStop = useCallback(async () => {
    await api.stop();
    setUrlInput('');
    setImmersive(false);
  }, [api]);

  const handleNavigate = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!urlInput.trim() || !isConnected) return;
    api.navigate(urlInput.trim());
  }, [api, urlInput, isConnected]);

  // Browser logo component
  const BrowserLogo = ({ name, size = 16 }: { name: string; size?: number }) => (
    <img
      src={`/icons/${name}.svg`}
      alt={name}
      width={size}
      height={size}
      className="shrink-0"
      onError={(e) => {
        // Fallback to globe icon if SVG fails
        (e.target as HTMLImageElement).style.display = 'none';
      }}
    />
  );

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
                <Monitor className="w-4 h-4 text-white" />
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
                  onFocus={e => e.target.select()}
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
                  className="flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-semibold text-white transition-colors"
                  style={{ background: 'var(--primary)' }}
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
          <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text)' }}>
            Appearance
          </h3>
          <div className="space-y-1">
            {THEMES.map(t => (
              <button
                key={t.value}
                onClick={() => setTheme(t.value)}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left"
                style={{
                  background: theme === t.value ? 'var(--primary)' : 'transparent',
                  color: theme === t.value ? 'white' : 'var(--text)',
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