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
  // Transient: ICE dropped and we are attempting recovery (grace period elapsed
  // or 'failed'). The session may well still be alive server-side, so the UI
  // must NOT claim the session ended while in this state.
  | 'reconnecting'
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
  geometry: { width: number; height: number } | null;

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
  // Actual capture/video dimensions (window size incl. browser chrome), reported
  // by the server. Used for client->video coordinate mapping.
  const [geometry, setGeometry] = useState<{ width: number; height: number } | null>(null);

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

  // Poll for URL/title/tabs changes. Exactly ONE loop may run at a time.
  // History: startPolling() used to overwrite pollTimerRef without clearing
  // the previous interval, and start() never called stopPolling() — so every
  // session started without a clean stop leaked a loop that kept 404ing the
  // dead session forever (observed: 5+ concurrent stale loops). Fixed by:
  // clearing on start/stop/unmount, PLUS self-healing when the server
  // reports the session gone.
  const pollSessionRef = useRef<string | null>(null);
  // Set when the USER intentionally stops the session, so the poll loop can
  // distinguish "user clicked Stop" from "session died unexpectedly".
  const intentionalStopRef = useRef(false);
  // ── Reconnection state ──────────────────────────────────────────────────────
  // A brief ICE drop is NOT a dead session. ICE 'disconnected' routinely recovers
  // on its own within seconds, and the previous code surfaced the reconnect
  // screen as soon as the server reported the session gone — so a momentary
  // blip on a 2-vCore VPS (which is CPU-starved and stalls its media pipeline)
  // threw the user out of a session that was still perfectly alive.
  //
  // `disconnected` -> wait ICE_GRACE_MS, then if still not connected, try an
  //                  ICE restart.
  // `failed`       -> skip the wait, attempt the restart immediately.
  // `connected`    -> cancel any pending grace timer and any restart attempts.
  //
  // "Session ended" is shown ONLY when the server says the session is gone
  // (404 / active:false / alive:false) or when a restart actually fails.
  const ICE_GRACE_MS = Number(import.meta.env?.VITE_ICE_GRACE_MS ?? 5000);
  const iceGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartAttemptRef = useRef(0);
  const MAX_RESTART_ATTEMPTS = 3;
  // How many CONSECUTIVE polls must report the session dead while we are
  // reconnecting before we believe it. One poll can race a server restart or a
  // status blip; two agreeing polls (3s apart) is a real signal.
  const DEAD_CONFIRM_POLLS = 2;
  const consecutiveDeadRef = useRef(0);
  const [reconnecting, setReconnecting] = useState(false);
  // Mirrors of state for use inside the 1.5s poll closure, which is created once
  // and would otherwise capture stale values.
  const connectionStateRef = useRef<ConnectionState>(connectionState);
  connectionStateRef.current = connectionState;
  const reconnectingRef = useRef(reconnecting);
  reconnectingRef.current = reconnecting;
  const clearIceGraceTimer = useCallback(() => {
    if (iceGraceTimerRef.current) {
      clearTimeout(iceGraceTimerRef.current);
      iceGraceTimerRef.current = null;
    }
  }, []);
  const clearPollLoop = useCallback((reason: string) => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      console.log(`[Poll] Cleared for session ${pollSessionRef.current ?? '?'} (${reason})`);
      pollTimerRef.current = null;
      pollSessionRef.current = null;
    }
  }, []);

  const startPolling = useCallback((sid: string) => {
    // Guard: never leave an old loop running when a new one starts.
    clearPollLoop('replaced by new session');
    pollSessionRef.current = sid;
    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/session/status?sessionId=${sid}`);
        if (!r.ok) {
          // An explicit 404 is the ONLY status-level proof the session is gone.
          // A transient 5xx / network error is not, so it must not end anything.
          console.log(`[Poll] status HTTP ${r.status} for ${sid} at ${new Date().toISOString().slice(11, 23)}`);
          if (r.status === 404 && !intentionalStopRef.current) {
            setConnectionState('failed');
            setError('Session ended — the server no longer has this session. Click Start Browser to reconnect.');
            clearPollLoop('status 404 — session gone server-side');
          }
          return;
        }
        const d = await r.json();
        // Log the poll result so the exact moment of a drop is visible in the
        // browser console alongside the ICE transitions.
        console.log(
          `[Poll] ${sid} at ${new Date().toISOString().slice(11, 23)}: active=${d.active} alive=${d.alive} ` +
          `connection=${connectionStateRef.current} reconnecting=${reconnectingRef.current}`,
        );
        if (d.active === false || d.alive === false) {
          // The SERVER says the session is really gone (stopped by its disconnect
          // grace timer, or the browser target crashed / was OOM-killed). Only
          // now is "Session ended" truthful. If we are mid-reconnection, still
          // allow a couple of polls to be sure before declaring it dead.
          if (reconnectingRef.current) {
            consecutiveDeadRef.current += 1;
            console.warn(
              `[Poll] session reported dead while reconnecting ` +
              `(${consecutiveDeadRef.current}/${DEAD_CONFIRM_POLLS})`,
            );
            if (consecutiveDeadRef.current < DEAD_CONFIRM_POLLS) return;
          }
          if (!intentionalStopRef.current) {
            setConnectionState('failed');
            setReconnecting(false);
            clearIceGraceTimer();
            setError(
              d.alive === false
                ? 'Session ended — the remote browser stopped responding. Click Start Browser to reconnect.'
                : 'Session ended — the server closed this session. Click Start Browser to reconnect.',
            );
          }
          clearPollLoop(d.alive === false ? 'browser target died' : 'status active=false');
          return;
        }
        consecutiveDeadRef.current = 0;
        if (d.url !== undefined) setCurrentUrl(prev => (prev === d.url ? prev : d.url));
        if (d.title !== undefined) setCurrentTitle(prev => (prev === d.title ? prev : d.title));
        // Only update when values actually changed — a new object identity
        // every poll forces constant re-renders of the whole viewport tree
        // (flicker) and re-fires every geometry-dependent effect.
        if (d.width && d.height) {
          setGeometry(prev => (prev && prev.width === d.width && prev.height === d.height ? prev : { width: d.width, height: d.height }));
        }
        const tabR = await fetch(`${API_BASE}/api/tab/list?sessionId=${sid}`);
        if (tabR.status === 404) {
          // Session gone server-side — stop the stale loop.
          clearPollLoop('tab/list 404 — session gone server-side');
          return;
        }
        if (tabR.ok) {
          const td = await tabR.json();
          setTabs(prev => {
            const next = td.tabs || [];
            const same = prev.length === next.length && prev.every((t, i) => t.id === next[i]?.id && t.title === next[i]?.title && t.url === next[i]?.url && t.loading === next[i]?.loading);
            return same ? prev : next;
          });
          setActiveTabId(prev => (prev === (td.activeTabId || null) ? prev : (td.activeTabId || null)));
        }
      } catch { /* ignore */ }
    };
    poll();
    pollTimerRef.current = setInterval(poll, 1500);
    console.log(`[Poll] Started for session ${sid}`);
  }, [clearPollLoop]);

  const stopPolling = useCallback(() => {
    clearPollLoop('stop');
  }, [clearPollLoop]);

  const setupWebRTC = useCallback((sid: string, iceServers: RTCIceServer[]) => {
    const pc = new RTCPeerConnection({ iceServers });

    console.log('[Client] RTCPeerConnection created with ICE servers:', JSON.stringify(iceServers));

    // Try to recover a dropped connection WITHOUT tearing the session down.
    // restartIce() re-gathers candidates on the existing peer connection, which
    // is far cheaper than a full reconnect and is enough for the transient
    // failures seen here. If it is unavailable, the server-side session status
    // poll remains the source of truth: if the session is genuinely gone we get
    // active:false and only then do we surface "Session ended".
    const attemptRecovery = (why: string) => {
      if (intentionalStopRef.current) return;
      if (restartAttemptRef.current >= MAX_RESTART_ATTEMPTS) {
        console.warn(`[Client] Reconnection gave up after ${restartAttemptRef.current} attempts (${why})`);
        setReconnecting(false);
        return;
      }
      const attempt = ++restartAttemptRef.current;
      console.log(`[Client] Reconnection attempt ${attempt}/${MAX_RESTART_ATTEMPTS} (${why})`);
      setReconnecting(true);
      try {
        pc.restartIce();
        console.log('[Client] pc.restartIce() called — waiting for the connection to come back');
      } catch (e) {
        console.warn('[Client] restartIce() unavailable or threw:', e);
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      const at = new Date().toISOString().slice(11, 23);
      console.log(`[Client] WebRTC connection state: ${state} at ${at} (ice=${pc.iceConnectionState}, session=${sessionIdRef.current ?? '?'})`);
      if (state === 'connected') {
        // Recovery worked (or was never needed): reset the retry budget and
        // cancel any pending grace timer so a later 'disconnected' starts fresh.
        clearIceGraceTimer();
        if (restartAttemptRef.current > 0) {
          console.log(`[Client] Connection recovered after ${restartAttemptRef.current} attempt(s)`);
        }
        restartAttemptRef.current = 0;
        setReconnecting(false);
        setConnectionState('connected');
        return;
      }

      if (state === 'failed') {
        // Terminal for this pc: do not wait, try to recover immediately.
        clearIceGraceTimer();
        setConnectionState('reconnecting');
        attemptRecovery('connection failed');
        return;
      }

      if (state === 'disconnected') {
        // NOT an error. ICE recovers by itself very often; wait before doing
        // anything at all. This is the case that used to end the session.
        setConnectionState('disconnected');
        clearIceGraceTimer();
        console.log(`[Client] ICE disconnected — waiting ${ICE_GRACE_MS}ms before considering recovery`);
        iceGraceTimerRef.current = setTimeout(() => {
          iceGraceTimerRef.current = null;
          // Re-check: the connection may have come back on its own during the
          // grace period, in which case the 'connected' handler already ran.
          if (pc.connectionState === 'connected' || intentionalStopRef.current) {
            console.log('[Client] Connection recovered on its own during the grace period');
            return;
          }
          setConnectionState('reconnecting');
          attemptRecovery('still disconnected after grace period');
        }, ICE_GRACE_MS);
        return;
      }

      if (state === 'closed') {
        // The pc was closed deliberately (unmount/stop). Not a failure.
        clearIceGraceTimer();
        console.log('[Client] Peer connection closed');
      }
    };

    pc.oniceconnectionstatechange = () => {
      const at = new Date().toISOString().slice(11, 23);
      console.log(`[Client] ICE connection state: ${pc.iceConnectionState} at ${at} (signaling=${pc.signalingState}, session=${sid})`);
    };

    pc.onicegatheringstatechange = () => {
      const at = new Date().toISOString().slice(11, 23);
      console.log(`[Client] ICE gathering state: ${pc.iceGatheringState} at ${at} (session=${sid})`);
    };

    pc.ontrack = (event: RTCTrackEvent) => {
      console.log('[Client] Track received:', event.track.kind, 'streams:', event.streams.length);
      if (videoRef.current && event.streams[0]) {
        const v = videoRef.current;
        v.srcObject = event.streams[0];
        // Audio playback: ensure the track is audible. Chrome requires a user
        // gesture for UNMUTED play — the Start click provides sticky
        // activation, but if the browser still blocks it, fall back to muted
        // playback and unmute on the next interaction.
        v.volume = 1;
        v.muted = false;
        v.play().catch((e: DOMException) => {
          if (e.name === 'NotAllowedError') {
            console.warn('[Client] Unmuted autoplay blocked — starting muted, will unmute on next click/keypress');
            v.muted = true;
            v.play().catch(() => {});
            const unmute = () => {
              v.muted = false;
              v.volume = 1;
              v.play().catch(() => {});
              window.removeEventListener('pointerdown', unmute);
              window.removeEventListener('keydown', unmute);
            };
            window.addEventListener('pointerdown', unmute);
            window.addEventListener('keydown', unmute);
          } else {
            console.warn('[Client] Auto-play failed:', e);
          }
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
    // Audit-critical: clear any polling loop from a previous session BEFORE
    // starting a new one — startPolling() alone can't be trusted for this
    // when a prior session was never cleanly stopped.
    stopPolling();
    intentionalStopRef.current = false; // new session — unexpected deaths should surface again
    // Fresh reconnection budget for the new session: otherwise a previous
    // session's exhausted retry counter would make the first blip here look
    // like an unrecoverable one.
    clearIceGraceTimer();
    restartAttemptRef.current = 0;
    consecutiveDeadRef.current = 0;
    setReconnecting(false);
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

      // Buffer for remote ICE candidates that arrive before remote description
      // is set (trickle ICE race condition: server may send candidates before answer)
      const remoteCandidatesBuffer: RTCIceCandidateInit[] = [];

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

            // Now that remote description is set, add all buffered candidates
            if (remoteCandidatesBuffer.length > 0) {
              console.log(`[Client] Adding ${remoteCandidatesBuffer.length} buffered remote ICE candidates`);
              for (const candidate of remoteCandidatesBuffer) {
                try {
                  await pc.addIceCandidate(candidate);
                  console.log(`[Client] Buffered ICE candidate added: ${candidate.candidate?.slice(0, 60)}`);
                } catch (e) {
                  console.warn('[Client] Buffered ICE candidate add failed:', e);
                }
              }
              remoteCandidatesBuffer.length = 0;
            }
          }
        } else if (msg.type === 'ice') {
          const payload = msg.payload as { candidate: RTCIceCandidateInit };
          const pc = pcRef.current;
          if (pc && payload.candidate) {
            const c = payload.candidate;
            console.log(`[Client] Remote ICE candidate: ${c.candidate?.slice(0, 60)}`);

            // If remote description not yet set, buffer the candidate
            // (trickle ICE: candidates can arrive before the answer)
            if (!pc.remoteDescription || !pc.remoteDescription.type) {
              console.log('[Client] Buffering remote ICE candidate (waiting for remote description)');
              remoteCandidatesBuffer.push(payload.candidate);
            } else {
              try {
                await pc.addIceCandidate(payload.candidate);
              } catch (e) {
                console.warn('[Client] ICE candidate add failed:', e);
              }
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
  }, [setupWebRTC, sendSignal, startPolling, stopPolling]);

  const stop = useCallback(async () => {
    intentionalStopRef.current = true; // user-driven stop — not an unexpected death
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
    if (!sid) { console.warn(`[Client] ${path} skipped: no sessionId`); return; }
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
      // Surface non-OK responses — previously swallowed silently, which made
      // intermittent navigation failures impossible to diagnose.
      const errBody = await r.text().catch(() => '');
      console.warn(`[Client] ${path} failed: HTTP ${r.status} ${errBody}`);
    } catch (e) {
      console.warn(`[Client] ${path} threw:`, e);
    }
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
    geometry,
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
