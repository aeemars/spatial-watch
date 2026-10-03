# Spatial Watch

> A hands-first social cinema experience for Meta VR — built for the Meta VR Start Developer Competition 2026, Entertainment track.

![Spatial Watch](https://img.shields.io/badge/Platform-WebXR-blue) ![Go](https://img.shields.io/badge/Backend-Go-00ADD8) ![MongoDB](https://img.shields.io/badge/Database-MongoDB%20Atlas-47A248)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                 Browser / Meta Quest             │
│                                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐ │
│  │ Landing UI │→ │  Lobby UI  │→ │ Cinema +   │ │
│  │            │  │            │  │ WebXR Scene│ │
│  └────────────┘  └────────────┘  └─────┬──────┘ │
│                        │               │         │
│              WebSocket ▼         REST API        │
└──────────────────────┬─────────────┬─────────────┘
                       │             │
              ┌────────▼─────────────▼────────┐
              │          Go Backend            │
              │                                │
              │  ┌──────────┐  ┌────────────┐  │
              │  │ HTTP API │  │ WS Room Hub│  │
              │  └────┬─────┘  └─────┬──────┘  │
              │       │              │          │
              │  ┌────▼──────────────▼────────┐│
              │  │   MongoDB Repositories     ││
              │  └────────────┬───────────────┘│
              └───────────────┬────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  MongoDB Atlas     │
                    │  ─ rooms           │
                    │  ─ participants    │
                    │  ─ commentaryCues  │
                    │  ─ reactions       │
                    └───────────────────┘
```

### Tech Stack

| Layer      | Technology                        |
|------------|-----------------------------------|
| Frontend   | Vanilla HTML, CSS, JavaScript     |
| 3D/WebXR   | Three.js (rendering helper only)  |
| Backend    | Go (gorilla/mux, gorilla/websocket) |
| Database   | MongoDB Atlas                     |
| Realtime   | WebSockets                        |
| Fonts      | Inter (UI), Playfair Display (editorial) |

---

## Local Setup

### Prerequisites

- **Go** 1.21+
- **MongoDB** (Optional: the backend automatically uses an in-memory store for instant zero-dependency local testing/demo; MongoDB Atlas is supported for persistent multi-instance production deployments)
- A modern browser (Chrome 119+, Meta Quest Browser)

### 1. Clone & Configure

```bash
cd "spatial watch"
cp .env.example .env
```

Edit `.env` with your MongoDB connection string:

```env
PORT=8080
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true&w=majority
DATABASE_NAME=spatialwatch
PUBLIC_BASE_URL=http://localhost:8080
```

### 2. MongoDB Atlas Setup

1. Create a free Atlas cluster at [cloud.mongodb.com](https://cloud.mongodb.com)
2. Create a database user
3. Whitelist your IP address (or use `0.0.0.0/0` for development)
4. Copy the connection string to your `.env` file
5. The app automatically creates collections and indexes on first run

### 3. Run the Backend

```bash
cd backend
go mod tidy
go run main.go
```

The server starts on `http://localhost:8080` and serves both the API and the frontend static files.

### 4. Run Tests

```bash
cd backend
go test -v ./...
```

---

## Environment Variables

| Variable         | Description                      | Default                     |
|------------------|----------------------------------|-----------------------------|
| `PORT`           | HTTP server port                 | `8080`                      |
| `MONGODB_URI`    | MongoDB connection string        | `mongodb://localhost:27017` |
| `DATABASE_NAME`  | MongoDB database name            | `spatialwatch`              |
| `PUBLIC_BASE_URL`| Public URL of the application    | `http://localhost:8080`     |

---

## Testing Shared Rooms in Two Browser Windows

1. Start the backend: `cd backend && go run main.go`
2. Open `http://localhost:8080` in **Window 1**
3. Click "Create a Room" → enter a display name → create
4. Copy the room code (e.g., `SW-AB12`)
5. Open `http://localhost:8080` in **Window 2**
6. Click "Join with Code" → paste the room code → enter a different name → join
7. Both users should appear in the lobby
8. Click "Enter Cinema" in both windows
9. The host (Window 1) controls playback — play, pause, seek
10. Both windows should synchronize in real time
11. Try sending reactions from either window
12. Toggle Director's Cut from the host window

---

## Testing WebXR on Meta Quest

### Requirements

- Meta Quest 2, 3, or Pro
- Meta Quest Browser
- The server must be accessible from the Quest (same network or deployed)

### Steps

1. Deploy the app or use a tunneling service (e.g., ngrok, Cloudflare Tunnel)
2. Open the URL in Meta Quest Browser
3. The landing page should show "Immersive VR + hand tracking available"
4. Create or join a room → enter the cinema
5. Click the VR headset icon in the cinema controls
6. The scene enters immersive VR mode
7. Use **hand pinch** gestures or **gaze dwell** (800ms) to interact with the floating control panel:
   - Play/Pause
   - Seek ±10s
   - Director's Cut toggle
   - Reactions
   - Exit

### Checks Requiring Physical Hardware

- [ ] Hand tracking pinch detection accuracy
- [ ] Gaze dwell timing feels natural
- [ ] Spatial control panel is comfortably positioned for seated use
- [ ] Video texture renders correctly on the cinema screen
- [ ] Frame rate stays above 72fps on Quest hardware
- [ ] Seat markers and name labels are readable at distance
- [ ] Reactions render in 3D space without motion discomfort

---

## Deployment Guidance

### Go Backend

The backend is a single binary. Build and deploy to any cloud provider:

```bash
cd backend
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o spatialwatch-server .
```

Deploy to:
- **Railway** / **Render** / **Fly.io** (recommended for hackathons)
- **Google Cloud Run**
- **AWS ECS / Lambda**
- Any VPS with Go runtime

### Static Frontend

The `frontend/` directory is served by the Go backend. For CDN deployment:
- Copy `frontend/` to a CDN (Vercel, Netlify, Cloudflare Pages)
- Update `PUBLIC_BASE_URL` in the backend config
- Configure CORS headers for cross-origin API/WS access

### HTTPS Requirement

WebXR requires HTTPS in production. Use:
- Let's Encrypt / Certbot
- Cloudflare proxy
- Platform-provided TLS (Railway, Render, etc.)

---

## Design System

### Design Tokens

All visual values are defined as CSS custom properties in [`tokens.css`](frontend/css/tokens.css):

| Category     | Examples                                         |
|--------------|--------------------------------------------------|
| Colors       | `--bg`, `--gold`, `--violet`, `--surface-1`–`4`  |
| Typography   | `--font-body`, `--font-display`, `--text-xs`–`4xl` |
| Spacing      | `--space-1`–`20` (4px–80px)                      |
| Radii        | `--radius-sm`–`full`                              |
| Shadows      | `--shadow-sm`–`xl`, `--shadow-glow-gold`          |
| Motion       | `--ease-out`, `--ease-in-out`, `--duration-*`     |
| Z-index      | `--z-base`–`--z-tooltip`                          |

### Components

Defined in [`components.css`](frontend/css/components.css):

- **Buttons**: primary, secondary, ghost, destructive, icon-only (all sizes)
- **Inputs**: text, room-code (monospace/tabular)
- **Labels & Helpers**: with error states
- **Chips & Badges**: gold, violet, presence, count variants
- **Avatars**: default and small
- **Cards**: preview, screening, participants
- **Modals**: center-origin with overlay
- **Toasts**: bottom-center, stacked, success/error variants
- **Connection Status**: dot + text with connected/connecting/disconnected states
- **Commentary Cards**: Director's Cut display with dismiss
- **Tooltips**: delay-on-first, immediate-adjacent
- **Reactions**: floating emoji with stagger
- **Skeletons**: shimmer loading states
- **Empty States**: icon + message

### Motion Rules

Following Emil Kowalski's design engineering philosophy:

1. **Never use `transition: all`** — animate specific properties only
2. **Never animate from `scale(0)`** — start at `scale(0.95)` + `opacity: 0`
3. **All hover styles gated** inside `@media (hover: hover) and (pointer: fine)`
4. **Every pressable element** has `:active { transform: scale(0.97) }`
5. **Entering elements** use `ease-out` (responsive)
6. **Moving elements** use `ease-in-out` (natural)
7. **Never use `ease-in`** for UI animations
8. **UI animations stay under 300ms**
9. **`prefers-reduced-motion`** supported — removes positional motion, retains opacity
10. **Tooltips**: initial delay (400ms), adjacent skips delay

---

## Design References

This project follows the UI engineering philosophy from:

1. **[Emil Kowalski — Design Engineering](https://github.com/emilkowalski/skills/blob/main/skills/emil-design-eng/SKILL.md)**: Animation decision framework, component principles, easing curves, and perceived performance.

2. **[Emil Kowalski — Mobile Native](https://github.com/emilkowalski/skills/blob/main/skills/mobile-native/SKILL.md)**: Touch-native fixes — hover gating, tap highlight removal, viewport units, input sizing, safe areas, and overscroll behavior.

---

## Competition Submission Checklist

### Meta VR Start Developer Competition 2026 — Entertainment Track

- [ ] **Hosted WebXR URL** — deploy and provide public HTTPS URL
- [ ] **Public demo video** — record a 3-minute walkthrough
- [ ] **Hands-first testing** — verify on Meta Quest with hand tracking
- [ ] **3-minute demo flow**:
  1. Show landing page and create a room (0:00–0:30)
  2. Join from a second device, show lobby sync (0:30–1:00)
  3. Enter cinema, demonstrate synchronized playback (1:00–1:45)
  4. Send reactions from both devices (1:45–2:15)
  5. Enable Director's Cut, show commentary cues (2:15–2:45)
  6. Enter VR mode on Quest, demonstrate hand interaction (2:45–3:00)
- [ ] **Screenshots**:
  - Landing page (dark cinema hero)
  - Room lobby with participants
  - Desktop cinema with controls
  - VR cinema with floating control panel
  - Director's Cut commentary card
  - Reaction animations
- [ ] **Project description**: social VR cinema with hands-first interaction, synchronized playback, real-time reactions, and Director's Cut commentary
- [ ] **Technical stack**: Go + MongoDB + WebSockets + Vanilla JS + Three.js + WebXR
- [ ] **Original work**: no third-party templates, no copyrighted media
- [ ] **Accessibility**: keyboard navigation, ARIA labels, screen reader support, reduced motion

---

## Project Structure

```
spatial watch/
├── .env.example
├── README.md
├── backend/
│   ├── main.go                  # Entry point, server setup
│   ├── main_test.go             # Tests
│   ├── go.mod
│   ├── config/
│   │   └── config.go            # Environment config
│   ├── handlers/
│   │   └── handlers.go          # HTTP + WS handlers
│   ├── models/
│   │   └── models.go            # Domain models
│   ├── repository/
│   │   ├── rooms.go             # Room CRUD
│   │   ├── participants.go      # Participant CRUD
│   │   ├── commentary.go        # Commentary cues
│   │   └── reactions.go         # Reaction events
│   ├── seed/
│   │   └── seed.go              # Default commentary cues
│   └── websocket/
│       ├── hub.go               # Room message routing
│       ├── client.go            # WS connection handling
│       └── ratelimit.go         # Rate limiting
└── frontend/
    ├── index.html               # Main HTML (all screens)
    ├── css/
    │   ├── tokens.css           # Design tokens
    │   ├── base.css             # Resets & fundamentals
    │   ├── components.css       # Reusable components
    │   └── scenes.css           # Screen layouts
    └── js/
        ├── api.js               # REST API client
        ├── websocket.js         # WebSocket client
        ├── reactions.js         # Emoji reactions
        ├── directors-cut.js     # Commentary cues
        ├── cinema.js            # Three.js cinema scene
        ├── xr.js                # WebXR + hand tracking
        └── app.js               # App orchestration
```

---

## License

Built for the Meta VR Start Developer Competition 2026. All original work.
