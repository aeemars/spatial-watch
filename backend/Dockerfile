# ═══════════════════════════════════════════════════════════
# Spatial Watch — Go Backend Standalone Dockerfile
# Optimized for Pxxl and standalone container hosting
# ═══════════════════════════════════════════════════════════

FROM golang:1.23-alpine AS builder

WORKDIR /build

RUN apk add --no-cache ca-certificates git

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /build/spatialwatch-server .

FROM alpine:3.20

WORKDIR /app

RUN apk add --no-cache ca-certificates tzdata ffmpeg && \
    addgroup -g 10001 -S spatialwatch && \
    adduser -u 10001 -S spatialwatch -G spatialwatch

COPY --from=builder /build/spatialwatch-server ./spatialwatch-server

ENV PORT=8080
EXPOSE 8080

USER spatialwatch:spatialwatch

CMD ["./spatialwatch-server"]
