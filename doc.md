# MP4 Fast Start Transcoder

## Purpose
By default, standard MP4 files place the `moov` atom (the metadata instructing the player how to read the video frames) at the **end** of the file. This forces the browser to download almost the entire video file before it can begin playing. 

The **Fast Start Transcoder** shifts this `moov` atom to the **front** of the video file. This allows WebGL/HTML5 video players (used in the Spatial Watch cinema room) to start streaming and playing the video instantly, drastically reducing loading times and buffering issues.

## Implementation Details

The fast-start logic applies differently depending on whether the video is uploaded dynamically by a user or is part of the curated catalog.

### 1. Dynamic User Uploads (Backend)
When a user uploads a video to host a custom room, the application bypasses direct-to-R2 uploads and routes the file through the backend to be processed.

- **Endpoint:** `POST /api/media/upload-faststart` (handled in `backend/handlers/upload_faststart.go`).
- **Process:** 
  1. The backend receives the video and writes it to a raw temporary file (`/tmp`).
  2. It executes the local `backend/ffmpeg` binary using the command: 
     `backend/ffmpeg -i raw.mp4 -c copy -movflags faststart fast.mp4`
  3. The newly optimized `fast.mp4` file is then uploaded to the Cloudflare R2 bucket (`spatialwatch-media`) via a presigned PUT request.
  4. If the FFmpeg process fails, the system safely falls back to uploading the raw, un-optimized file.
- **Frontend Tracking:** Handled in `frontend/js/api.js` (`uploadFastStart`), utilizing `XMLHttpRequest` to provide real-time upload progress to the UI.

### 2. Curated Catalog Videos (Manual)
Videos seeded directly into the database (e.g., in `backend/seed/seed.go`) bypass the backend upload handler. These videos must be manually optimized *before* uploading to the R2 dashboard.

- **Command:** `ffmpeg -i original.mp4 -c copy -movflags faststart optimized.mp4`
- **Result:** The `optimized.mp4` file is then uploaded to Cloudflare R2, and its exact URL is placed in the database seed logic.

## Dependencies
- A local `ffmpeg` executable must be present at `./backend/ffmpeg` relative to where the `spatialwatch-server` binary is executed. This ensures the environment remains self-contained without relying on global server dependencies.
