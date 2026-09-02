# Cloud Browser (WebRTC)

A cloud-hosted Chromium browser streamed over WebRTC (VP8 video + Opus audio).

Stack: React + Vite (frontend) → Node/Express (backend) → Puppeteer-core (Chromium) → FFmpeg (VP8/Opus) → werift (WebRTC) → browser client.

---

## Run the whole app with ONE command

```bash
npm run dev
```

This starts everything:
- PulseAudio (best-effort, for audio capture) — **scripts/dev.sh**
- Backend API + WebSocket signaling on port **3001**
- Vite dev server (frontend) on port **5000**, which proxies `/api` and `/signal` to the backend

### Open ONE URL

> **Open the forwarded URL for port 5000** (the frontend).

- In GitHub Codespaces: click the **5000** forwarded port.
- Locally: open `http://localhost:5000`.
- You will see the "Cloud Browser" UI. Click **Start** to launch the remote Chromium.

### Production-style single-port (for a VPS, no Docker)

```bash
npm run start
```

Builds the frontend + backend, then serves **both** the UI and the API on one port
(`3001`, override with `PORT`). This is the command to use when moving the same
code to a standalone Linux VPS.

---

## Ports

| Port | Service |
|------|---------|
| 5000 | Frontend (Vite dev server; proxies `/api` + `/signal` to 3001) |
| 3001 | Backend API + WebSocket signaling (binds `0.0.0.0`) |

---

## Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` / `SERVER_PORT` | Backend port | `3001` |
| `CHROMIUM_PATH` | Path to a Chromium/Chrome binary (override auto-detection) | auto |
| `WEBRTC_ICE_SERVERS` | JSON array of ICE/TURN servers for the media path | `[]` (host candidates) |

### WebRTC / TURN note (important for Codespaces and NAT'd hosts)

WebRTC media uses **UDP**. GitHub Codespaces only forwards **TCP** ports, so the
default host candidates cannot reach a Codespace container. To test WebRTC media
in Codespaces (or on any NAT'd host without a 1:1 public IP), set a **TURN server
reachable over TCP** on both sides via the same env var, e.g.:

```bash
WEBRTC_ICE_SERVERS='[{"urls":"turn:openrelay.metered.ca:443","username":"openrelayproject","credential":"openrelayproject"}]' npm run dev
```

On a VPS with a public IP (or 1:1 NAT), host candidates work without TURN — no
config needed.

---

## Linux system dependencies

Required on the host (installed automatically by the devcontainer setup):
- `chromium` (a Chromium/Chrome binary — `puppeteer-core` does not bundle one)
- `ffmpeg` (with libvpx + libopus)
- `pulseaudio` + `pulseaudio-utils` (audio capture)
- `fonts-liberation`

### GitHub Codespaces

The `.devcontainer/devcontainer.json` installs these and builds the project
automatically. Codespaces-specific config is isolated to `.devcontainer/` and
`scripts/dev.sh` — the application itself is a portable Linux app that runs
identically on a standalone Ubuntu/Debian VPS.

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Full dev stack (PulseAudio + backend + frontend) |
| `npm start` | Production-style single-port build + run |
| `npm run build` | Build frontend (`dist/`) |
| `npm run build:server` | Compile backend (`dist-server/`) |
| `npm run typecheck` | Frontend TS check |
| `npm run typecheck:server` | Backend TS check |

