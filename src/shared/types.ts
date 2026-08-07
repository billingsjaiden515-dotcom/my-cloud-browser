export type SessionStatus = 'idle' | 'launching' | 'streaming' | 'stopping' | 'error';

export interface SessionState {
  sessionId: string | null;
  status: SessionStatus;
  message: string;
}

export interface StartSessionResponse {
  sessionId: string;
  status: 'launching' | 'streaming';
  message: string;
}

export interface StopSessionResponse {
  status: 'stopped';
  message: string;
}

export interface ErrorResponse {
  error: string;
  message: string;
}

export type SignalMessageType = 'offer' | 'answer' | 'ice' | 'ready' | 'error';

export interface SignalMessage {
  type: SignalMessageType;
  sessionId: string;
  payload?: unknown;
}

export interface OfferPayload {
  sdp: string;
  type: string;
}

export interface IcePayload {
  candidate: unknown;
}

export interface ReadyPayload {
  message: string;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  index: number;
}

export interface BrowserInfo {
  name: string;
  displayName: string;
  executablePath: string;
  available: boolean;
}
