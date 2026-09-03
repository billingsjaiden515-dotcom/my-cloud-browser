import { useCallback, useEffect, useRef, useState } from 'react';
import type { SignalMessage, OfferPayload, TabInfo, BrowserInfo } from '@/shared/types';

// Use relative URLs so Vite proxy handles both dev and production
const API_BASE = '';

// Fallback STUN if the server exposes no ICE configuration (always reachable).
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

function getWsUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/signal`;
}

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'failed';

export interface RemoteBrowserApi {
  sessionId: string | null;
  connectionState: ConnectionState;
  error: string | null;
  currentUrl: string;
  currentTitle: string;
  tabs: TabInfo[];
  activeTabId: string | null;
  availableBrowsers: BrowserInfo[];

  start: (browserType?: string) => Promise<void>;
  stop: () => Promise<void>;

  navigate: (url: string) => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  reload: () => Promise<void>;

  newTab: (url?: string) => Promise<void>;
  switchTab: (tabId: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;

  setViewport: (width: number, height: number) => Promise<void>;
  sendMouseClick: (x: number, y: number, button?: 'left' | 'right' | 'middle') => Promise<void>;
  sendMouseDown: (x: number, y: number, button?: 'left' | 'right' | 'middle') => Promise<void>;
  sendMouseUp: (x: number, y: number, button?: 'left' | 'right' | 'middle') => Promise<void>;
  sendMouseDoubleClick: (x: number, y: number, button?: 'left' | 'right' | 'middle') => Promise<void>;
  sendMouseMove: (x: number, y: number) => Promise<void>;
  sendMouseScroll: (x: number, y: number, deltaX: number, deltaY: number) => Promise<void>;
  sendKeyDown: (key: string) => Promise<void>;
  sendKeyUp: (key: string) => Promise<void>;
  sendKeyPress: (key: string) => Promise<void>;
  typeText: (text: string) => Promise<void>;
}

export function useRemoteBrowser(videoRef: React.RefObject<HTMLVideoElement>): RemoteBrowserApi {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState('');
  const [currentTitle, setCurrentTitle] = useState('');
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [availableBrowsers, setAvailableBrowsers] = useState<BrowserInfo[]>([]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load available browsers on mount
  useEffect(() => {
    fetch(`${API_BASE}/api/browsers`)
      .then(r => r.json())
      .then(d => setAvailableBrowsers(d.browsers || []))
      .catch(() => {});
  }, []);

  const sendSignal = useCallback((msg: SignalMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // Poll for URL/title/tabs changes
  const startPolling = useCallback((sid: string) => {
    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/session/status?sessionId=${sid}`);
        if (!r.ok) return;
        const d = await r.json();
        if (d.url !== undefined) setCurrentUrl(d.url);
        if (d.title !== undefined) setCurrentTitle(d.title);
        if (d.tabs !== undefined) setTabs(d.tabs);
        const tabR = await fetch(`${API_BASE}/api/tab/list?sessionId=${sid}`);
        if (tabR.ok) {
          const td = await tabR.json();
          setTabs(td.tabs || []);
          setActiveTabId(td.activeTabId || null);
        }
      } catch { /* ignore */ }
    };
    poll();
    pollTimerRef.current = setInterval(poll, 1500);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const setupWebRTC = useCallback((sid: string, iceServers: RTCIceServer[]) => {
    const pc = new RTCPeerConnection({ iceServers });

    console.log('[Client] RTCPeerConnection created with ICE servers:', JSON.stringify(iceServers));

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log('[Client] WebRTC connection state:', state);
      if (state === 'connected') {
        setConnectionState('connected');
      } else if (state === 'failed') {
        setConnectionState('failed');
        setError('WebRTC connection failed');
      } else if (state === 'disconnected' || state === 'closed') {
        setConnectionState('disconnected');
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[Client] ICE connection state:', pc.iceConnectionState);
    };

    pc.onicegatheringstatechange = () => {
      console.log('[Client] ICE gathering state:', pc.iceGatheringState);
    };

    pc.ontrack = (event: RTCTrackEvent) => {
      console.log('[Client] Track received:', event.track.kind, 'streams:', event.streams.length);
      if (videoRef.current && event.streams[0]) {
        videoRef.current.srcObject = event.streams[0];
        videoRef.current.play().catch((e) => {
          console.warn('[Client] Auto-play failed:', e);
        });
      }
    };

    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        const c = event.candidate;
        console.log(`[Client] Local ICE candidate: ${c.type} ${c.protocol}:${c.address}:${c.port}`);
        sendSignal({
          type: 'ice',
          sessionId: sid,
          payload: { candidate: event.candidate.toJSON() },
        });
      } else {
        console.log('[Client] ICE gathering complete');
      }
    };

    // Add recvonly transceivers for video and audio
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pcRef.current = pc;
    return pc;
  }, [videoRef, sendSignal]);

  const start = useCallback(async (browserType = 'chromium') => {
    setError(null);
    setConnectionState('connecting');

    try {
      const response = await fetch(`${API_BASE}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ browserType }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || 'Failed to start session');
      }
      const data = await response.json();
      const sid = data.sessionId as string;
      sessionIdRef.current = sid;
      setSessionId(sid);

      // Fetch runtime config (ICE servers) from the backend so the client matches
      // the server's NAT/TURN configuration. Falls back to public STUN.
      let iceServers = DEFAULT_ICE_SERVERS;
      try {
        const cfgRes = await fetch(`${API_BASE}/api/config`);
        if (cfgRes.ok) {
          const cfg = await cfgRes.json();
          if (Array.isArray(cfg.iceServers) && cfg.iceServers.length > 0) {
            iceServers = cfg.iceServers;
          }
        }
      } catch { /* keep default STUN */ }

      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = async () => {
        console.log('[Client] WebSocket connected, creating WebRTC offer');
        const pc = setupWebRTC(sid, iceServers);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        sendSignal({
          type: 'offer',
          sessionId: sid,
          payload: { type: 'offer', sdp: offer.sdp } as OfferPayload,
        });
      };

      ws.onmessage = async (event: MessageEvent) => {
        const msg: SignalMessage = JSON.parse(event.data);
        console.log(`[Client] Signal received: ${msg.type}`);

        if (msg.type === 'answer') {
          const payload = msg.payload as OfferPayload;
          const pc = pcRef.current;
          if (pc) {
            await pc.setRemoteDescription(
              new RTCSessionDescription({ type: 'answer', sdp: payload.sdp }),
            );
            console.log('[Client] Remote description set');
          }
        } else if (msg.type === 'ice') {
          const payload = msg.payload as { candidate: RTCIceCandidateInit };
          const pc = pcRef.current;
          if (pc && payload.candidate) {
            try {
              const c = payload.candidate;
              console.log(`[Client] Remote ICE candidate: ${c.candidate?.slice(0, 60)}`);
              await pc.addIceCandidate(payload.candidate);
            } catch (e) {
              console.warn('[Client] ICE candidate add failed:', e);
            }
          }
        } else if (msg.type === 'error') {
          const payload = msg.payload as { message: string };
          setError(payload.message);
          setConnectionState('failed');
        }
      };

      ws.onerror = () => {
        setError('WebSocket signaling connection failed');
        setConnectionState('failed');
      };

      ws.onclose = () => {
        console.log('[Client] WebSocket closed');
      };

      startPolling(sid);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start browser session');
      setConnectionState('failed');
    }
  }, [setupWebRTC, sendSignal, startPolling]);

  const stop = useCallback(async () => {
    stopPolling();
    const sid = sessionIdRef.current;
    if (sid) {
      try {
        await fetch(`${API_BASE}/api/session/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid }),
        });
      } catch { /* ignore */ }
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    sessionIdRef.current = null;
    setSessionId(null);
    setConnectionState('disconnected');
    setCurrentUrl('');
    setCurrentTitle('');
    setTabs([]);
    setActiveTabId(null);
    setError(null);
  }, [videoRef, stopPolling]);

  // ─── Input helpers ──────────────────────────────────────────────────────────

  const sendInput = useCallback(async (endpoint: string, body: Record<string, unknown>) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await fetch(`${API_BASE}/api/input/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, ...body }),
      });
    } catch { /* ignore */ }
  }, []);

  const post = useCallback(async (path: string, body: Record<string, unknown>): Promise<unknown> => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const r = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, ...body }),
      });
      if (r.ok) {
        const data = await r.json();
        // Update URL from response
        if (data.url) setCurrentUrl(data.url);
        return data;
      }
    } catch { /* ignore */ }
  }, []);

  // ─── Navigation ──────────────────────────────────────────────────────────────

  const navigate = useCallback(async (url: string) => {
    await post('/api/navigate', { url });
    setTimeout(async () => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const r = await fetch(`${API_BASE}/api/session/status?sessionId=${sid}`).catch(() => null);
      if (r?.ok) {
        const d = await r.json();
        if (d.url) setCurrentUrl(d.url);
        if (d.title) setCurrentTitle(d.title);
      }
    }, 500);
  }, [post]);

  const goBack = useCallback(async () => { await post('/api/navigate/back', {}); }, [post]);
  const goForward = useCallback(async () => { await post('/api/navigate/forward', {}); }, [post]);
  const reload = useCallback(async () => { await post('/api/navigate/reload', {}); }, [post]);

  // ─── Tabs ────────────────────────────────────────────────────────────────────

  const newTab = useCallback(async (url?: string) => {
    await post('/api/tab/new', url ? { url } : {});
  }, [post]);

  const switchTab = useCallback(async (tabId: string) => {
    setActiveTabId(tabId);
    await post('/api/tab/switch', { tabId });
  }, [post]);

  const closeTab = useCallback(async (tabId: string) => {
    await post('/api/tab/close', { tabId });
  }, [post]);

  // ─── Viewport ────────────────────────────────────────────────────────────────

  const setViewport = useCallback(async (width: number, height: number) => {
    await post('/api/viewport', { width, height });
  }, [post]);

  // ─── Mouse / keyboard ────────────────────────────────────────────────────────

  const sendMouseClick = useCallback((x: number, y: number, button: 'left' | 'right' | 'middle' = 'left') =>
    sendInput('mouse', { action: 'click', x, y, button }), [sendInput]);

  const sendMouseDown = useCallback((x: number, y: number, button: 'left' | 'right' | 'middle' = 'left') =>
    sendInput('mouse', { action: 'down', x, y, button }), [sendInput]);

  const sendMouseUp = useCallback((x: number, y: number, button: 'left' | 'right' | 'middle' = 'left') =>
    sendInput('mouse', { action: 'up', x, y, button }), [sendInput]);

  const sendMouseDoubleClick = useCallback((x: number, y: number, button: 'left' | 'right' | 'middle' = 'left') =>
    sendInput('mouse', { action: 'doubleclick', x, y, button }), [sendInput]);

  const sendMouseMove = useCallback((x: number, y: number) =>
    sendInput('mouse', { action: 'move', x, y }), [sendInput]);

  const sendMouseScroll = useCallback((x: number, y: number, deltaX: number, deltaY: number) =>
    sendInput('mouse', { action: 'scroll', x, y, deltaX, deltaY }), [sendInput]);

  const sendKeyDown = useCallback((key: string) =>
    sendInput('keyboard', { action: 'keydown', key }), [sendInput]);

  const sendKeyUp = useCallback((key: string) =>
    sendInput('keyboard', { action: 'keyup', key }), [sendInput]);

  const sendKeyPress = useCallback((key: string) =>
    sendInput('keyboard', { action: 'keypress', key }), [sendInput]);

  const typeText = useCallback((text: string) =>
    sendInput('keyboard', { action: 'type', text }), [sendInput]);

  useEffect(() => {
    return () => {
      stopPolling();
      pcRef.current?.close();
      wsRef.current?.close();
    };
  }, [stopPolling]);

  return {
    sessionId,
    connectionState,
    error,
    currentUrl,
    currentTitle,
    tabs,
    activeTabId,
    availableBrowsers,
    start,
    stop,
    navigate,
    goBack,
    goForward,
    reload,
    newTab,
    switchTab,
    closeTab,
    setViewport,
    sendMouseClick,
    sendMouseDown,
    sendMouseUp,
    sendMouseDoubleClick,
    sendMouseMove,
    sendMouseScroll,
    sendKeyDown,
    sendKeyUp,
    sendKeyPress,
    typeText,
  };
}
