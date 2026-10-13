package handlers

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"spatialwatch/internal/auth"
)

func (h *Handler) UploadFastStart(w http.ResponseWriter, r *http.Request) {
	authUser, ok := auth.GetAuthenticatedUser(r.Context())
	if !ok || authUser == nil {
		respondError(w, http.StatusUnauthorized, "Authentication required to upload media")
		return
	}

	// Limit to 500MB total body, but only buffer up to 32MB in RAM to avoid container OOM
	r.Body = http.MaxBytesReader(w, r.Body, 500*1024*1024)
	if err := r.ParseMultipartForm(32 * 1024 * 1024); err != nil {
		respondError(w, http.StatusBadRequest, "File too large or invalid multipart form")
		return
	}

	file, header, err := r.FormFile("video")
	if err != nil {
		respondError(w, http.StatusBadRequest, "Missing 'video' in form-data")
		return
	}
	defer file.Close()

	cType := header.Header.Get("Content-Type")
	if cType == "" {
		cType = "video/mp4"
	}
	if !strings.HasPrefix(cType, "video/") && cType != "application/mp4" {
		respondError(w, http.StatusBadRequest, "Only video files (e.g. video/mp4) are supported")
		return
	}

	ext := ".mp4"
	if strings.Contains(header.Filename, ".") {
		parts := strings.Split(header.Filename, ".")
		extractedExt := "." + strings.ToLower(parts[len(parts)-1])
		if extractedExt == ".mp4" || extractedExt == ".webm" || extractedExt == ".mov" {
			ext = extractedExt
		}
	}

	randomID, _ := auth.GenerateUUIDv4()
	if randomID == "" {
		randomID = fmt.Sprintf("%d", time.Now().UnixNano())
	}
	key := fmt.Sprintf("uploads/%s%s", randomID, ext)

	// 1. Save uploaded file to temp disk
	rawPath := filepath.Join("/tmp", randomID+"_raw"+ext)
	out, err := os.Create(rawPath)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create temp file")
		return
	}
	if _, err := io.Copy(out, file); err != nil {
		out.Close()
		respondError(w, http.StatusInternalServerError, "Failed to write temp file")
		return
	}
	out.Close()
	defer os.Remove(rawPath)

	// 2. Run ffmpeg faststart with a conservative timeout so reverse proxy never times out
	fastPath := filepath.Join("/tmp", randomID+"_fast"+ext)
	ffmpegBin := "ffmpeg"
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		if _, err := os.Stat("backend/ffmpeg"); err == nil {
			ffmpegBin = "backend/ffmpeg"
		} else if _, err := os.Stat("./ffmpeg"); err == nil {
			ffmpegBin = "./ffmpeg"
		}
	}
	ffmpegCtx, ffmpegCancel := context.WithTimeout(r.Context(), 15*time.Second)
	cmd := exec.CommandContext(ffmpegCtx, ffmpegBin, "-i", rawPath, "-c", "copy", "-movflags", "faststart", fastPath)
	if err := cmd.Run(); err != nil {
		ffmpegCancel()
		log.Printf("[upload] ffmpeg faststart skipped/error: %v (falling back to raw stream)", err)
		fastPath = rawPath
	} else {
		ffmpegCancel()
		defer os.Remove(fastPath)
	}

	// 3. Upload directly via storage service (handles live R2 via S3 SDK or dev disk)
	fileInfo, err := os.Stat(fastPath)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to read optimized file")
		return
	}

	fastFile, err := os.Open(fastPath)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to open optimized file for upload")
		return
	}
	defer fastFile.Close()

	if h.Storage == nil {
		respondError(w, http.StatusInternalServerError, "Storage service is not configured")
		return
	}

	res, err := h.Storage.PutObject(r.Context(), key, cType, fastFile, fileInfo.Size())
	if err != nil {
		log.Printf("[upload] upload failed: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to store uploaded media")
		return
	}

	respondJSON(w, http.StatusOK, res)
}
