# Cloud Browser

A polished cloud browser application that streams a real remote Chromium instance to your browser using genuine WebRTC.

## Architecture

- **Frontend**: React + TypeScript + Tailwind, served by Vite on port 5000
- **Backend**: Node.js + Express + TypeScript on port 3001
- **Video pipeline**: CDP screencast (JPEG) → FFmpeg VP8 encoder → VP8 RTP packets → werift WebRTC → browser `<video>`
- **Input**: Mouse clicks/moves/scrolls and keyboard input forwarded to remote browser via HTTP POST → Puppeteer CDP

## How to run

The workflow `Start application` runs both processes concurrently:
```
npm run dev
```
This starts:
- `tsx watch server/main.ts` — backend server on port 3001
- `vite --port 5000 --host 0.0.0.0` — frontend on port 5000 (proxies /api and /signal to port 3001)

## Key files

| File | Role |
|------|------|
| `server/main.ts` | Backend entry point |
| `server/http-server.ts` | REST API (session, navigation, tabs, input) |
| `server/signaling-server.ts` | WebSocket WebRTC signaling |
| `server/browser-session.ts` | Chromium/Puppeteer management + tab control |
| `server/webrtc-streamer.ts` | VP8 RTP packetization + werift sender |
| `server/vp8-encoder.ts` | FFmpeg-based JPEG→VP8 IVF encoder |
| `server/browser-finder.ts` | Dynamic browser executable path detection |
| `src/App.tsx` | Main UI (toolbar, tabs, themes, immersive mode) |
| `src/hooks/useRemoteBrowser.ts` | WebRTC + signaling + session management hook |
| `src/components/BrowserViewport.tsx` | Video element + input capture |
| `src/contexts/ThemeContext.tsx` | 6-theme system |

## Environment

- **Chromium**: installed via `pkgs.chromium` in replit.nix
- **FFmpeg**: available via Replit runtime path (libvpx VP8 encoder)
- **No external APIs required** — everything runs locally on the server

## User preferences

- No supabase dependency (removed — was unused)
- No artificial frame rate caps
- All browser logos use official SVG designs (public/icons/)
- Themes: system, light, dark, midnight, ocean, forest
