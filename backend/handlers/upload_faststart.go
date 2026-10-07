package handlers

import (
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

	// Limit to 500MB
	r.Body = http.MaxBytesReader(w, r.Body, 500*1024*1024)
	if err := r.ParseMultipartForm(500 * 1024 * 1024); err != nil {
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

	// 2. Run ffmpeg faststart
	fastPath := filepath.Join("/tmp", randomID+"_fast"+ext)
	cmd := exec.Command("./ffmpeg", "-i", rawPath, "-c", "copy", "-movflags", "faststart", fastPath)
	if err := cmd.Run(); err != nil {
		log.Printf("[upload] ffmpeg faststart error: %v", err)
		// Fallback to uploading the raw file if ffmpeg fails
		fastPath = rawPath
	} else {
		defer os.Remove(fastPath)
	}

	// 3. Upload to R2 using a presigned URL
	fileInfo, err := os.Stat(fastPath)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to read optimized file")
		return
	}

	res, err := h.Storage.PresignPut(r.Context(), key, cType, fileInfo.Size(), 15*time.Minute)
	if err != nil {
		log.Printf("[upload] failed to generate presigned upload URL: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to generate presigned upload URL")
		return
	}

	fastFile, err := os.Open(fastPath)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to open optimized file for upload")
		return
	}
	defer fastFile.Close()

	reqPut, err := http.NewRequest("PUT", res.UploadURL, fastFile)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create upload request")
		return
	}
	reqPut.Header.Set("Content-Type", cType)
	reqPut.ContentLength = fileInfo.Size()

	client := &http.Client{}
	respPut, err := client.Do(reqPut)
	if err != nil || respPut.StatusCode != http.StatusOK {
		log.Printf("[upload] upload to R2 failed: err=%v, status=%d", err, respPut.StatusCode)
		respondError(w, http.StatusInternalServerError, "Failed to upload to R2")
		return
	}

	respondJSON(w, http.StatusOK, res)
}
