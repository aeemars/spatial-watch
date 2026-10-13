# ═══════════════════════════════════════════════════════════
# Spatial Watch — Go Backend Production Dockerfile
# Optimized for Pxxl with Base Directory: backend
# ═══════════════════════════════════════════════════════════

# ─── Stage 1: Builder ─────────────────────────────────────
FROM golang:1.25-alpine AS builder

WORKDIR /build

ENV GOTOOLCHAIN=auto

# Install CA certificates and git for module fetching
RUN apk add --no-cache ca-certificates git

# Cache Go dependency downloads
COPY go.mod go.sum ./
RUN go mod download

# Copy source code and build static binary
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /build/spatialwatch-server .

# ─── Stage 2: Minimal Runtime ─────────────────────────────
FROM alpine:3.20

WORKDIR /app

RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -g 10001 -S spatialwatch && \
    adduser -u 10001 -S spatialwatch -G spatialwatch

# Copy the compiled binary from builder
COPY --from=builder /build/spatialwatch-server ./spatialwatch-server

# Set production defaults (overridden by Pxxl env vars)
ENV PORT=8080

EXPOSE 8080

USER spatialwatch:spatialwatch

CMD ["./spatialwatch-server"]
