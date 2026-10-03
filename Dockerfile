# ═══════════════════════════════════════════════════════════
# Spatial Watch — Multi-Stage Production Dockerfile
# Lightweight, secure, and standalone
# ═══════════════════════════════════════════════════════════

# ─── Stage 1: Builder ─────────────────────────────────────
FROM golang:1.23-alpine AS builder

WORKDIR /build

# Install CA certificates for external HTTPS requests (e.g., MongoDB Atlas TLS)
RUN apk add --no-cache ca-certificates git

# Cache Go dependency downloads
COPY backend/go.mod backend/go.sum ./
RUN go mod download

# Copy source files and compile static binary
COPY backend/ .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /build/spatialwatch-server .

# ─── Stage 2: Minimal Runtime ─────────────────────────────
FROM alpine:3.20

WORKDIR /app

RUN apk add --no-cache ca-certificates tzdata

# Copy the compiled binary from builder
COPY --from=builder /build/spatialwatch-server ./spatialwatch-server

# Copy frontend static files (HTML, CSS, JS)
COPY frontend/ ./frontend/

# Set production defaults (can be overridden by environment variables)
ENV PORT=8080

EXPOSE 8080

CMD ["./spatialwatch-server"]
