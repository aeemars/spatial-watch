# Spatial Watch

> **Spatial Watch** is a hands-first social virtual cinema for Meta VR devices and modern web browsers. It brings friends together into private virtual screening rooms to watch synchronized films with controller-free hand/pinch interactions, floating 3D spatial reactions, and an interactive "Director's Cut" scene commentary system — running entirely through WebXR with zero app installation.

![Spatial Watch](https://img.shields.io/badge/Platform-WebXR-blue) ![Go](https://img.shields.io/badge/Backend-Go-00ADD8) ![MongoDB](https://img.shields.io/badge/Database-MongoDB%20Atlas-47A248)

---


### Tech Stack

| Layer      | Technology                        |
|------------|-----------------------------------|
| Frontend   | Vanilla HTML, CSS, JavaScript     |
| 3D/WebXR   | Three.js (rendering helper only)  |
| Backend    | Go (gorilla/mux, gorilla/websocket) |
| Database   | MongoDB Atlas (Driver v2) with zero-config in-memory fallback |
| Sessions   | Secure HttpOnly cookie sessions (`sw_session`), SHA-256 hashed |
| Realtime   | WebSockets (cookie-authenticated handshakes) |
| Fonts      | Inter (UI), Playfair Display (editorial) |

---

## Guest-Session Authentication Architecture

Spatial Watch implements a **secure, frictionless guest-session authentication system**. Every visitor is automatically granted a persistent, server-issued unique identity (`userId` UUID v4) without requiring an account or email/password signup.

### Why Guest Sessions?
1. **Zero-Friction VR & Web Onboarding**: Entering a virtual cinema shouldn't require filling out registration forms, verifying emails, or typing complex passwords inside a VR headset.
2. **Instant Watch Parties**: Anyone with a room link or room code can jump directly into a screening room in seconds.
3. **Identity Without Profiling**: Each guest is assigned a pleasant cinema-themed display name (e.g., *Cinema Fox*, *Quiet Comet*) that can be customized at any time without storing sensitive personal data.
4. **Clean Upgrade Path**: The system uses immutable UUID v4 user IDs so OAuth or magic-link account linking can be added in the future without changing room ownership or identity logic.

### Security Model
- **Opaque Session Tokens**: Generated using 32 cryptographically secure random bytes from Go's `crypto/rand` (`base64.RawURLEncoding`). Never uses UUIDs as session tokens.
- **SHA-256 Token Hashing**: The database and in-memory store **never store raw session tokens**. Only the SHA-256 hash (`hex.EncodeToString(sha256(token))`) is stored.
- **HttpOnly Cookies**: Session tokens are transmitted exclusively via the `sw_session` cookie. JavaScript cannot read the token, preventing XSS-based token theft.
- **Zero Client-Side Token Storage**: No session tokens or credentials are ever stored in `localStorage`, `sessionStorage`, IndexedDB, or URL query parameters.
- **Server-Derived Authority**: The client cannot spoof participant IDs or host permissions. In room creation, joins, and WebSocket messages, user identity and host authorization are derived entirely from the server session context.
- **Sliding Session Expiration**: Sessions are valid for 30 days (`SESSION_DURATION_DAYS`), refreshed lazily on active use (thresholded to prevent excessive database writes).

### Development vs. Production Cookie Configuration
- **Development**:
  - `COOKIE_SECURE=false`: Allows cookies to function over plain HTTP on `localhost` or local network IPs.
  - `HttpOnly: true` and `SameSite: Lax` are strictly preserved in development.
- **Production**:
  - `COOKIE_SECURE=true`: Enforces the `Secure` attribute over HTTPS (mandatory for production WebXR).
  - WebXR hand tracking and immersive VR require HTTPS in production browsers.

---

## MongoDB Collections & Indexes

When connected to MongoDB Atlas, the backend automatically provisions and indexes the following collections:

### 1. `users`
Represents anonymous guests and authenticated users.
```go
type User struct {
    ID          string    `bson:"_id" json:"id"` // UUID v4
    DisplayName string    `bson:"displayName" json:"displayName"`
    IsGuest     bool      `bson:"isGuest" json:"isGuest"`
    CreatedAt   time.Time `bson:"createdAt" json:"createdAt"`
    LastSeenAt  time.Time `bson:"lastSeenAt" json:"lastSeenAt"`
}
```

### 2. `sessions`
Represents active browser sessions. Raw tokens are never persisted.
```go
type Session struct {
    ID         bson.ObjectID `bson:"_id,omitempty"`
    TokenHash  string        `bson:"tokenHash"`
    UserID     string        `bson:"userId"`
    CreatedAt  time.Time     `bson:"createdAt"`
    ExpiresAt  time.Time     `bson:"expiresAt"`
    LastSeenAt time.Time     `bson:"lastSeenAt"`
}
```
**Indexes**:
- Unique index on `tokenHash`: Fast, constant-time session lookup.
- Index on `userId`: Enables querying or revoking sessions by user.
- TTL index on `expiresAt` with `expireAfterSeconds: 0`: Automatic background expiration by MongoDB.

### 3. `rooms`, `participants`, `commentaryCues`, `reactions`
Standard room and social cinema collections, with unique index on `roomCode` and participant lookups.

---

## Local Setup

### Prerequisites

- **Go** 1.21+ (tested on Go 1.25)
- **MongoDB** *(Optional)*: The backend includes a built-in, concurrent in-memory repository fallback. The app runs fully and passes all tests without a MongoDB instance running.
- A modern browser (Chrome, Edge, Meta Quest Browser)

### 1. Clone & Configure

```bash
cd "spatial watch"
cp .env.example .env
```

Review configuration variables in `.env` (refer to `.env.example`):
```env
PORT=8080
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
DATABASE_NAME=spatialwatch
PUBLIC_BASE_URL=http://localhost:8080

# Session & Security Settings
COOKIE_SECURE=false
COOKIE_DOMAIN=
CORS_ALLOWED_ORIGINS=
SESSION_DURATION_DAYS=30
```

### 2. Run the Backend

```bash
# Using the pre-built binary:
./spatialwatch-server

# Or running from source:
cd backend
go run main.go
```

The server starts on `http://localhost:8080`.

### 3. Run Automated Tests

```bash
cd backend
go test -v ./...
```

---

## Environment Variables

| Variable                | Description                                                          | Default                     |
|-------------------------|----------------------------------------------------------------------|-----------------------------|
| `PORT`                  | HTTP server listening port                                           | `8080`                      |
| `MONGODB_URI`           | MongoDB Atlas connection string (fallback to in-memory if omitted)   | `mongodb://localhost:27017` |
| `DATABASE_NAME`         | MongoDB database name                                                | `spatialwatch`              |
| `PUBLIC_BASE_URL`       | Public application URL                                               | `http://localhost:8080`     |
| `COOKIE_SECURE`         | Set `true` in production to enforce `Secure` cookies over HTTPS      | `false` (in dev)            |
| `COOKIE_DOMAIN`         | Optional domain attribute for cookies (empty for host-only)          | `""`                        |
| `CORS_ALLOWED_ORIGINS`   | Comma-separated allowed origins for credentialed cross-origin access  | `""` (same-origin only)     |
| `SESSION_DURATION_DAYS` | Inactivity lifetime of guest session in days                         | `30`                        |

---

## Testing Two Different Guests

Because sessions are stored in an `sw_session` cookie, you can test multi-user rooms locally:

1. **Host Guest (Window 1)**:
   - Open `http://localhost:8080` in a **standard browser window**.
   - Notice the top-right profile chip with your server-issued guest name (e.g. *Cinema Fox*).
   - Click **Create a Room** → Room is created with your guest ID as Host.
   - Note the 7-character room code (e.g., `SW-AB12`).

2. **Second Guest (Window 2)**:
   - Open `http://localhost:8080` in an **Incognito / Private Window** (or a separate browser profile / different browser).
   - A distinct guest session is automatically issued with a different guest identity and UUID.
   - Click **Join with Code** → enter the room code.
   - Both guests appear in the Lobby and Cinema.

3. **Verifying Host Permissions**:
   - Only Window 1 (Host) has permission to play, pause, seek, or toggle Director's Cut.
   - Window 2 will receive real-time playback sync and can send reactions.

### How to Clear or Reset Local Guest Sessions
- **In UI**: Click the Guest Profile chip at top-right → click **Reset Identity**.
- **Via API**: Send a `POST /api/auth/logout` request.
- **In Browser**: Open Developer Tools &rarr; Application &rarr; Cookies &rarr; Delete `sw_session`.

---

## Future Account-Linking Path

The architecture is explicitly designed so external authentication can be added without rewriting room or identity logic:

1. **Current State**:
   - User has `User{ ID: "<uuid-v4>", IsGuest: true, DisplayName: "Cinema Fox" }`.
   - Rooms and participants are permanently keyed to this immutable `User.ID`.
2. **Adding Magic-Link or OAuth Later**:
   - Add an `identities` collection or fields on `User`:
     ```go
     type UserIdentity struct {
         UserID   string // references User.ID
         Provider string // "google", "github", "email_magic_link"
         Subject  string // provider subject/email
     }
     ```
   - When a guest chooses "Link Google Account" or "Save Profile with Email", verify the external identity and link it to the existing `User.ID`.
   - Update `User.IsGuest = false`.
   - All existing room history, host privileges, and settings remain associated with the exact same internal user ID.

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

### Docker Deployment

A lightweight, multi-stage production [`Dockerfile`](Dockerfile) is provided:

```bash
# Build Docker image
docker build -t spatialwatch .

# Run container
docker run -p 8080:8080 -e PORT=8080 spatialwatch
```

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
