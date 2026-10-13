# Media Storage & Direct Upload Architecture

## Overview
Spatial Watch uses a **Zero-Egress Direct Upload Architecture** powered by Cloudflare R2 object storage. Video clips uploaded by hosts never transit through the Go backend server; instead, they stream directly from the user's browser straight to the Cloudflare R2 bucket.

## Why Direct Zero-Egress Replaced Server-Side Transcoding
In previous versions, video files were routed to a backend endpoint (`POST /api/media/upload-faststart`) to run `ffmpeg -movflags faststart`. However, routing 50MB–500MB video files through a server reverse proxy introduces major bottlenecks:
1. **Gateway Timeouts:** Cloudflare edge proxies enforce strict 30-second connection timeouts. Uploading large files over standard residential connections takes longer than 30 seconds, leading to `504 Gateway Timeout` errors.
2. **Container Memory & CPU Strain:** Parsing multi-megabyte multipart forms and executing FFmpeg child processes risks container out-of-memory (OOM) crashes and CPU starvation on cloud hosting tiers.
3. **Bandwidth Costs:** Streaming video files through the server consumes double the bandwidth (browser-to-server and server-to-storage).

## Current Architecture

### 1. Direct Presigned Upload (Browser to R2)
- **Endpoint:** `POST /api/media/presign-upload` (handled in `backend/handlers/handlers.go`).
- **Flow:**
  1. The browser requests an authorized S3 presigned PUT URL from the backend.
  2. The backend generates an expiring presigned PUT URL using static Cloudflare R2 credentials via AWS SDK v2.
  3. The browser streams the video directly to the Cloudflare R2 bucket (`https://<account>.r2.cloudflarestorage.com/<bucket>/uploads/<uuid>.mp4`) with progress reporting.
  4. The host seeds the local video into `Cinema.seedMediaBlob(streamUrl, file)`, allowing immediate zero-latency local playback without re-downloading.
  5. Guests streaming the file fetch it from Cloudflare R2's public edge URL.

### 2. HTTP 206 Partial Content Range Streaming
- Cloudflare R2 natively supports HTTP `Range: bytes=...` requests.
- Modern HTML5 video players and Three.js video textures can seek, buffer, and stream MP4 files seamlessly via Range requests, even if the `moov` atom is at the end of the file.
- Server-side FFmpeg transcoding is completely eliminated.
