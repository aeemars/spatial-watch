package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gorilla/mux"
	gorillaWs "github.com/gorilla/websocket"
	"spatialwatch/internal/auth"
	"spatialwatch/internal/storage"
	"spatialwatch/models"
	"spatialwatch/repository"
	ws "spatialwatch/websocket"
)

// Handler holds all HTTP and WebSocket handler dependencies
type Handler struct {
	RoomRepo       *repository.RoomRepo
	PartRepo       *repository.ParticipantRepo
	CommentRepo    *repository.CommentaryRepo
	ReactionRepo   *repository.ReactionRepo
	Hub            *ws.Hub
	AuthService    *auth.AuthService
	MediaAssetRepo *repository.MediaAssetRepo
	Storage        storage.StorageService
	upgrader       gorillaWs.Upgrader
}

// SetStorage configures the object storage service for the handler
func (h *Handler) SetStorage(s storage.StorageService) {
	h.Storage = s
}

// NewHandler creates a new handler with all dependencies
func NewHandler(
	roomRepo *repository.RoomRepo,
	partRepo *repository.ParticipantRepo,
	commentRepo *repository.CommentaryRepo,
	reactionRepo *repository.ReactionRepo,
	hub *ws.Hub,
	authService *auth.AuthService,
	mediaAssetRepo *repository.MediaAssetRepo,
	corsOrigins []string,
) *Handler {
	return &Handler{
		RoomRepo:       roomRepo,
		PartRepo:       partRepo,
		CommentRepo:    commentRepo,
		ReactionRepo:   reactionRepo,
		Hub:            hub,
		AuthService:    authService,
		MediaAssetRepo: mediaAssetRepo,
		upgrader: gorillaWs.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin:     checkOrigin(corsOrigins),
		},
	}
}

// Health returns service health status
func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, map[string]string{
		"status": "ok",
		"time":   time.Now().UTC().Format(time.RFC3339),
	})
}

// GetMediaAssets handles GET /api/media-assets
// Returns the list of curated short films in the catalog
func (h *Handler) GetMediaAssets(w http.ResponseWriter, r *http.Request) {
	if h.MediaAssetRepo == nil {
		respondJSON(w, http.StatusOK, []models.MediaAsset{})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	assets, err := h.MediaAssetRepo.FindAll(ctx)
	if err != nil {
		log.Printf("[api] failed to fetch media assets: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch media assets")
		return
	}
	if assets == nil {
		assets = []models.MediaAsset{}
	}
	respondJSON(w, http.StatusOK, assets)
}

// ─── Authentication Endpoints ────────────────────────────────────

// GetSession handles GET /api/auth/session
// Returns the current authenticated guest, or automatically creates one if no valid session exists.
func (h *Handler) GetSession(w http.ResponseWriter, r *http.Request) {
	if h.AuthService == nil {
		respondError(w, http.StatusInternalServerError, "Auth service unavailable")
		return
	}

	user, err := h.AuthService.GetOrCreateSession(w, r)
	if err != nil {
		if errors.Is(err, auth.ErrRateLimitExceeded) {
			respondError(w, http.StatusTooManyRequests, "Too many guest session requests. Please wait a moment.")
			return
		}
		log.Printf("[auth] failed to get/create session: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to initialize guest session")
		return
	}

	respondJSON(w, http.StatusOK, models.AuthSessionResponse{
		User: *user,
	})
}

// UpdateProfile handles PATCH /api/auth/profile (Protected by auth middleware)
// Updates the authenticated user's display name
func (h *Handler) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	authUser, ok := auth.GetAuthenticatedUser(r.Context())
	if !ok {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	var req models.UpdateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	user, err := h.AuthService.UpdateProfile(r.Context(), authUser.ID, req.DisplayName)
	if err != nil {
		if errors.Is(err, auth.ErrInvalidDisplayName) {
			respondError(w, http.StatusBadRequest, "Display name must be 2-32 visible characters without control characters or HTML")
			return
		}
		log.Printf("[auth] failed to update profile: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to update profile")
		return
	}

	respondJSON(w, http.StatusOK, models.UpdateProfileResponse{
		User: *user,
	})
}

// Logout handles POST /api/auth/logout
// Invalidates the current session and clears the sw_session cookie
func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	if h.AuthService != nil {
		_ = h.AuthService.Logout(w, r)
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── Room Endpoints ──────────────────────────────────────────────

// CreateRoom handles POST /api/rooms (Protected by auth middleware)
// Host identity is derived from the authenticated session
func (h *Handler) CreateRoom(w http.ResponseWriter, r *http.Request) {
	authUser, ok := auth.GetAuthenticatedUser(r.Context())
	if !ok {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	var req models.CreateRoomRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate room name
	roomName := strings.TrimSpace(req.RoomName)
	if roomName == "" {
		respondError(w, http.StatusBadRequest, "Room name is required (2-50 characters)")
		return
	}
	validRoomName, err := auth.ValidateRoomName(roomName)
	if err != nil {
		respondError(w, http.StatusBadRequest, "Room name must be 2-50 characters without control characters or HTML")
		return
	}

	displayName := authUser.DisplayName
	if trimmed := strings.TrimSpace(req.DisplayName); trimmed != "" {
		validName, err := auth.ValidateDisplayName(trimmed)
		if err != nil {
			respondError(w, http.StatusBadRequest, "Display name must be 2-32 characters without control characters or HTML")
			return
		}
		displayName = validName
		if displayName != authUser.DisplayName && h.AuthService != nil {
			_, _ = h.AuthService.UpdateProfile(r.Context(), authUser.ID, displayName)
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	// Enforce active room name uniqueness (dispels duplicate room names)
	exists, err := h.RoomRepo.ExistsActiveByName(ctx, validRoomName)
	if err != nil {
		log.Printf("[api] failed to check room name uniqueness: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to create room")
		return
	}
	if exists {
		respondError(w, http.StatusConflict, fmt.Sprintf("A room named %q is already active. Please choose a unique name.", validRoomName))
		return
	}

	roomCode, err := repository.GenerateRoomCode()
	if err != nil {
		log.Printf("[api] failed to generate room code: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to create room")
		return
	}

	// Host ID is always the authenticated session user ID
	participantID := authUser.ID

	// Resolve media source: catalog or custom hosted MP4
	mediaAssetID := strings.TrimSpace(req.MediaAssetID)
	customURL := strings.TrimSpace(req.MediaURL)
	customTitle := strings.TrimSpace(req.MediaTitle)

	var (
		mediaSourceType    string
		resolvedAssetID    string
		resolvedMediaURL   string
		resolvedMediaTitle string
		resolvedDuration   float64
	)

	// Mutually exclusive: cannot specify both catalog asset and custom URL/title
	if mediaAssetID != "" && (customURL != "" || customTitle != "") {
		respondError(w, http.StatusBadRequest, "Choose either a catalog media asset or a custom hosted MP4, not both")
		return
	}

	if customURL != "" || customTitle != "" {
		if customURL == "" || customTitle == "" {
			respondError(w, http.StatusBadRequest, "Both mediaUrl and mediaTitle are required for custom hosted media")
			return
		}
		validURL, validTitle, err := auth.ValidateCustomMedia(customURL, customTitle)
		if err != nil {
			respondError(w, http.StatusBadRequest, err.Error())
			return
		}
		mediaSourceType = "custom"
		if req.MediaSourceType == "upload" || req.MediaSourceType == "r2_upload" {
			mediaSourceType = req.MediaSourceType
		}
		resolvedAssetID = ""
		resolvedMediaURL = validURL
		resolvedMediaTitle = validTitle
		resolvedDuration = req.DurationSeconds
	} else if mediaAssetID != "" {
		if h.MediaAssetRepo == nil {
			respondError(w, http.StatusInternalServerError, "Media catalog unavailable")
			return
		}
		asset, err := h.MediaAssetRepo.FindByAssetID(ctx, mediaAssetID)
		if err != nil || asset == nil {
			respondError(w, http.StatusBadRequest, fmt.Sprintf("Catalog media asset %q not found", mediaAssetID))
			return
		}
		mediaSourceType = "catalog"
		resolvedAssetID = asset.AssetID
		resolvedMediaURL = asset.MediaURL
		resolvedMediaTitle = asset.Title
		resolvedDuration = asset.DurationSeconds
		if req.DurationSeconds > 0 {
			resolvedDuration = req.DurationSeconds
		}
	} else {
		// Default screening: Big Buck Bunny from catalog or fallback
		mediaSourceType = "catalog"
		resolvedAssetID = "big-buck-bunny"
		resolvedMediaTitle = "Big Buck Bunny"
		resolvedMediaURL = "/assets/videos/big-buck-bunny.mp4"
		resolvedDuration = 596
		if h.MediaAssetRepo != nil {
			if asset, err := h.MediaAssetRepo.FindByAssetID(ctx, "big-buck-bunny"); err == nil && asset != nil {
				resolvedAssetID = asset.AssetID
				resolvedMediaTitle = asset.Title
				resolvedMediaURL = asset.MediaURL
				resolvedDuration = asset.DurationSeconds
			}
		}
		if req.DurationSeconds > 0 {
			resolvedDuration = req.DurationSeconds
		}
	}

	var expiresAt time.Time
	if resolvedDuration > 0 {
		// Base lifetime of 2 hours, plus the film duration and 5 min buffer
		expiresAt = time.Now().Add(2*time.Hour + time.Duration(resolvedDuration+300)*time.Second)
	} else {
		// Fallback max lifespan (2 hours)
		expiresAt = time.Now().Add(2 * time.Hour)
	}

	room := &models.Room{
		RoomCode:                roomCode,
		Name:                    validRoomName,
		IsActive:                true,
		HostParticipantID:       participantID,
		MediaSourceType:         mediaSourceType,
		MediaAssetID:            resolvedAssetID,
		MediaTitle:              resolvedMediaTitle,
		MediaURL:                resolvedMediaURL,
		DurationSeconds:         resolvedDuration,
		PlaybackPositionSeconds: 0,
		IsPaused:                false,
		DirectorCutEnabled:      false,
		ExpiresAt:               expiresAt,
		CreatedAt:               time.Now(),
		UpdatedAt:               time.Now(),
	}
	if err := h.RoomRepo.Create(ctx, room); err != nil {
		log.Printf("[api] failed to create room: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to create room")
		return
	}

	participant := &models.Participant{
		ParticipantID: participantID,
		RoomCode:      roomCode,
		DisplayName:   displayName,
	}
	if err := h.PartRepo.Create(ctx, participant); err != nil {
		log.Printf("[api] failed to create participant: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to create participant")
		return
	}

	log.Printf("[api] room %s (%s) created by %s (%s)", roomCode, validRoomName, displayName, participantID)

	respondJSON(w, http.StatusCreated, models.CreateRoomResponse{
		RoomCode:        roomCode,
		Name:            validRoomName,
		ParticipantID:   participantID,
		IsHost:          true,
		MediaSourceType: mediaSourceType,
		MediaAssetID:    resolvedAssetID,
		MediaTitle:      resolvedMediaTitle,
		MediaURL:        resolvedMediaURL,
		DurationSeconds: resolvedDuration,
	})
}

// JoinRoom handles POST /api/rooms/join (Protected by auth middleware)
// Participant identity is derived from the authenticated session
func (h *Handler) JoinRoom(w http.ResponseWriter, r *http.Request) {
	authUser, ok := auth.GetAuthenticatedUser(r.Context())
	if !ok {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	var req models.JoinRoomRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	roomCode := strings.TrimSpace(strings.ToUpper(req.RoomCode))
	if len(roomCode) < 4 {
		respondError(w, http.StatusBadRequest, "Invalid room code")
		return
	}

	displayName := authUser.DisplayName
	if trimmed := strings.TrimSpace(req.DisplayName); trimmed != "" {
		validName, err := auth.ValidateDisplayName(trimmed)
		if err != nil {
			respondError(w, http.StatusBadRequest, "Display name must be 2-32 characters without control characters or HTML")
			return
		}
		displayName = validName
		if displayName != authUser.DisplayName && h.AuthService != nil {
			_, _ = h.AuthService.UpdateProfile(r.Context(), authUser.ID, displayName)
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	room, err := h.RoomRepo.FindByCode(ctx, roomCode)
	if err != nil || !room.IsActive {
		respondError(w, http.StatusNotFound, "Room not found or is no longer active")
		return
	}

	// Participant ID is always the authenticated session user ID
	participantID := authUser.ID
	participant := &models.Participant{
		ParticipantID: participantID,
		RoomCode:      roomCode,
		DisplayName:   displayName,
	}
	if err := h.PartRepo.Create(ctx, participant); err != nil {
		log.Printf("[api] failed to create participant: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to join room")
		return
	}

	log.Printf("[api] %s (%s) joined room %s (%s)", displayName, participantID, roomCode, room.Name)

	respondJSON(w, http.StatusOK, models.JoinRoomResponse{
		RoomCode:      roomCode,
		Name:          room.Name,
		ParticipantID: participantID,
		IsHost:        room.HostParticipantID == participantID,
	})
}

// GetRoom handles GET /api/rooms/{roomCode}
func (h *Handler) GetRoom(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	roomCode := strings.ToUpper(vars["roomCode"])

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	room, err := h.RoomRepo.FindByCode(ctx, roomCode)
	if err != nil || !room.IsActive {
		respondError(w, http.StatusNotFound, "Room not found or is no longer active")
		return
	}

	// Auto-heal legacy 403 Google Cloud Storage URLs for catalog films
	if strings.Contains(room.MediaURL, "commondatastorage.googleapis.com") {
		healedURL := "/assets/videos/big-buck-bunny.mp4"
		if h.MediaAssetRepo != nil && room.MediaAssetID != "" {
			if asset, err := h.MediaAssetRepo.FindByAssetID(ctx, room.MediaAssetID); err == nil && asset != nil {
				healedURL = asset.MediaURL
			}
		}
		room.MediaURL = healedURL
		_ = h.RoomRepo.UpdateMediaURL(ctx, roomCode, healedURL)
	}

	participants, _ := h.PartRepo.FindByRoom(ctx, roomCode)

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"room":         room,
		"participants": participants,
		"activeCount":  h.Hub.GetRoomParticipantCount(roomCode),
	})
}

// GetUserRooms handles GET /api/user/rooms (Protected by auth middleware)
// Returns active rooms created by the user and active rooms joined by the user for continued access
func (h *Handler) GetUserRooms(w http.ResponseWriter, r *http.Request) {
	authUser, ok := auth.GetAuthenticatedUser(r.Context())
	if !ok {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	// 1. Fetch active rooms created by user
	createdRooms, err := h.RoomRepo.FindByHost(ctx, authUser.ID)
	if err != nil {
		log.Printf("[api] failed to fetch created rooms: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch room records")
		return
	}

	createdRecords := make([]models.UserRoomRecord, 0, len(createdRooms))
	createdCodes := make(map[string]bool, len(createdRooms))
	for _, room := range createdRooms {
		codeUpper := strings.ToUpper(room.RoomCode)
		createdCodes[codeUpper] = true
		parts, _ := h.PartRepo.FindByRoom(ctx, room.RoomCode)
		mediaTitle := models.FormatMediaTitle(room.MediaTitle, room.MediaURL)
		sourceType := room.MediaSourceType
		if sourceType == "" {
			sourceType = "catalog"
		}
		createdRecords = append(createdRecords, models.UserRoomRecord{
			RoomCode:          room.RoomCode,
			Name:              room.Name,
			HostDisplayName:   authUser.DisplayName,
			HostParticipantID: room.HostParticipantID,
			MediaSourceType:   sourceType,
			MediaAssetID:      room.MediaAssetID,
			MediaTitle:        mediaTitle,
			MediaURL:          room.MediaURL,
			DurationSeconds:   room.DurationSeconds,
			ExpiresAt:         room.ExpiresAt,
			ParticipantCount:  len(parts),
			CreatedAt:         room.CreatedAt,
			IsHost:            true,
			IsActive:          room.IsActive,
		})
	}

	// 2. Fetch participation records for joined rooms
	participations, err := h.PartRepo.FindByParticipantID(ctx, authUser.ID)
	if err != nil {
		log.Printf("[api] failed to fetch user participations: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch room records")
		return
	}

	// Filter out rooms that user created or has left, avoiding duplicate codes
	var joinedCodes []string
	joinedAtMap := make(map[string]time.Time)
	for _, p := range participations {
		codeUpper := strings.ToUpper(p.RoomCode)
		if !createdCodes[codeUpper] && !p.HasLeft {
			if _, exists := joinedAtMap[codeUpper]; !exists {
				joinedCodes = append(joinedCodes, codeUpper)
				joinedAtMap[codeUpper] = p.JoinedAt
			}
		}
	}

	// 3. Fetch active room entities for joined codes
	joinedRooms, err := h.RoomRepo.FindActiveByCodes(ctx, joinedCodes)
	if err != nil {
		log.Printf("[api] failed to fetch joined room entities: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch room records")
		return
	}

	joinedRecords := make([]models.UserRoomRecord, 0, len(joinedRooms))
	for _, room := range joinedRooms {
		parts, _ := h.PartRepo.FindByRoom(ctx, room.RoomCode)
		hostName := "Host"
		for _, part := range parts {
			if part.ParticipantID == room.HostParticipantID {
				hostName = part.DisplayName
				break
			}
		}

		codeUpper := strings.ToUpper(room.RoomCode)
		mediaTitle := models.FormatMediaTitle(room.MediaTitle, room.MediaURL)
		sourceType := room.MediaSourceType
		if sourceType == "" {
			sourceType = "catalog"
		}
		joinedRecords = append(joinedRecords, models.UserRoomRecord{
			RoomCode:          room.RoomCode,
			Name:              room.Name,
			HostDisplayName:   hostName,
			HostParticipantID: room.HostParticipantID,
			MediaSourceType:   sourceType,
			MediaAssetID:      room.MediaAssetID,
			MediaTitle:        mediaTitle,
			MediaURL:          room.MediaURL,
			DurationSeconds:   room.DurationSeconds,
			ExpiresAt:         room.ExpiresAt,
			ParticipantCount:  len(parts),
			CreatedAt:         room.CreatedAt,
			JoinedAt:          joinedAtMap[codeUpper],
			IsHost:            false,
			IsActive:          room.IsActive,
		})
	}

	respondJSON(w, http.StatusOK, models.UserRoomsResponse{
		CreatedRooms: createdRecords,
		JoinedRooms:  joinedRecords,
	})
}

// ShutdownRoom handles DELETE /api/rooms/{roomCode} (Protected by auth middleware)
// Only the host can shut down the room, which terminates connections and removes it from active records
func (h *Handler) ShutdownRoom(w http.ResponseWriter, r *http.Request) {
	authUser, ok := auth.GetAuthenticatedUser(r.Context())
	if !ok {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	vars := mux.Vars(r)
	roomCode := strings.ToUpper(vars["roomCode"])

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	room, err := h.RoomRepo.FindByCode(ctx, roomCode)
	if err != nil {
		respondError(w, http.StatusNotFound, "Room not found")
		return
	}

	if room.HostParticipantID != authUser.ID {
		respondError(w, http.StatusForbidden, "Only the host can shut down this room")
		return
	}

	if err := h.RoomRepo.Shutdown(ctx, roomCode); err != nil {
		log.Printf("[api] failed to shutdown room %s: %v", roomCode, err)
		respondError(w, http.StatusInternalServerError, "Failed to shutdown room")
		return
	}

	// Close WS connections and broadcast room_shutdown
	h.Hub.CloseRoom(roomCode, "This room was shut down by the host.")

	log.Printf("[api] room %s shut down by host %s", roomCode, authUser.ID)
	respondJSON(w, http.StatusOK, map[string]string{
		"status":   "shutdown",
		"roomCode": roomCode,
	})
}

// LeaveRoom handles POST /api/rooms/{roomCode}/leave (Protected by auth middleware)
// Marks the participant as having left the room so it no longer appears in joined records
func (h *Handler) LeaveRoom(w http.ResponseWriter, r *http.Request) {
	authUser, ok := auth.GetAuthenticatedUser(r.Context())
	if !ok {
		respondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	vars := mux.Vars(r)
	roomCode := strings.ToUpper(vars["roomCode"])

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := h.PartRepo.Leave(ctx, roomCode, authUser.ID); err != nil {
		log.Printf("[api] failed to record participant leave %s: %v", roomCode, err)
		respondError(w, http.StatusInternalServerError, "Failed to leave room")
		return
	}

	log.Printf("[api] participant %s left room %s", authUser.ID, roomCode)
	respondJSON(w, http.StatusOK, map[string]string{
		"status":   "left",
		"roomCode": roomCode,
	})
}

func formatMediaTitle(urlStr string) string {
	return models.FormatMediaTitle("", urlStr)
}

// GetCommentary handles GET /api/rooms/{roomCode}/commentary
func (h *Handler) GetCommentary(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	roomCode := strings.ToUpper(vars["roomCode"])

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	cues, err := h.CommentRepo.FindByRoom(ctx, roomCode)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to fetch commentary")
		return
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"cues": cues,
	})
}

// HandleWebSocket handles GET /ws?roomCode=SW-AB12
// WebSocket connections are authenticated via the sw_session cookie
func (h *Handler) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	// 1. Authenticate WebSocket handshake via sw_session cookie
	if h.AuthService == nil {
		http.Error(w, "Auth service unavailable", http.StatusInternalServerError)
		return
	}

	user, err := h.AuthService.AuthenticateRequest(r)
	if err != nil || user == nil {
		log.Printf("[ws] unauthorized connection attempt: %v", err)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	roomCode := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("roomCode")))
	if roomCode == "" {
		http.Error(w, "Missing roomCode parameter", http.StatusBadRequest)
		return
	}

	// 2. Verify room exists
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	room, err := h.RoomRepo.FindByCode(ctx, roomCode)
	if err != nil || !room.IsActive {
		http.Error(w, "Room not found or is no longer active", http.StatusNotFound)
		return
	}

	// 3. Upgrade to WebSocket
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[ws] upgrade error: %v", err)
		return
	}

	// 4. Register client with server-authenticated identity
	client := &ws.Client{
		Hub:           h.Hub,
		Conn:          conn,
		Send:          make(chan []byte, 256),
		RoomCode:      roomCode,
		ParticipantID: user.ID,
		DisplayName:   user.DisplayName,
	}

	h.Hub.Register(client)

	go client.WritePump()
	go client.ReadPump()
}

// ─── Helpers ─────────────────────────────────────────────────────

func checkOrigin(allowedOrigins []string) func(r *http.Request) bool {
	return func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // non-browser or direct request
		}
		if len(allowedOrigins) == 0 {
			return true // default to permissive in dev
		}
		for _, allowed := range allowedOrigins {
			if strings.EqualFold(origin, allowed) {
				return true
			}
		}
		if strings.Contains(origin, r.Host) {
			return true
		}
		return false
	}
}

func respondJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, private")
	w.Header().Set("Pragma", "no-cache")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func respondError(w http.ResponseWriter, status int, message string) {
	respondJSON(w, status, map[string]string{"error": message})
}

// PresignUploadRequest defines the payload for POST /api/media/presign-upload
type PresignUploadRequest struct {
	FileName    string `json:"fileName"`
	FileSize    int64  `json:"fileSize"`
	ContentType string `json:"contentType"`
}

// PresignUpload handles POST /api/media/presign-upload
func (h *Handler) PresignUpload(w http.ResponseWriter, r *http.Request) {
	authUser, ok := auth.GetAuthenticatedUser(r.Context())
	if !ok || authUser == nil {
		respondError(w, http.StatusUnauthorized, "Authentication required to upload media")
		return
	}

	var req PresignUploadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate content-type
	cType := strings.ToLower(strings.TrimSpace(req.ContentType))
	if cType == "" {
		cType = "video/mp4"
	}
	if !strings.HasPrefix(cType, "video/") && cType != "application/mp4" {
		respondError(w, http.StatusBadRequest, "Only video files (e.g. video/mp4) are supported")
		return
	}

	// Validate file size (max 500MB = 524,288,000 bytes)
	const maxFileSize = 500 * 1024 * 1024
	if req.FileSize <= 0 {
		respondError(w, http.StatusBadRequest, "File size must be greater than zero")
		return
	}
	if req.FileSize > maxFileSize {
		respondError(w, http.StatusBadRequest, "File exceeds maximum allowed size of 500MB")
		return
	}

	// Determine file extension
	ext := ".mp4"
	if strings.Contains(req.FileName, ".") {
		parts := strings.Split(req.FileName, ".")
		extractedExt := "." + strings.ToLower(parts[len(parts)-1])
		if extractedExt == ".mp4" || extractedExt == ".webm" || extractedExt == ".mov" {
			ext = extractedExt
		}
	}

	randomID, err := auth.GenerateUUIDv4()
	if err != nil {
		randomID = fmt.Sprintf("%d", time.Now().UnixNano())
	}
	key := fmt.Sprintf("uploads/%s%s", randomID, ext)

	if h.Storage == nil {
		respondError(w, http.StatusInternalServerError, "Storage service is not configured")
		return
	}

	res, err := h.Storage.PresignPut(r.Context(), key, cType, req.FileSize, 15*time.Minute)
	if err != nil {
		log.Printf("[api] failed to generate presigned upload URL: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to generate presigned upload URL")
		return
	}

	respondJSON(w, http.StatusOK, res)
}

// MockUpload handles PUT /api/media/mock-upload/{key:.+} for local dev simulation
func (h *Handler) MockUpload(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	rawKey := vars["key"]
	cleanName := filepath.Base(rawKey)
	if cleanName == "." || cleanName == "/" || cleanName == "" {
		cleanName = fmt.Sprintf("upload-%d.mp4", time.Now().UnixNano())
	}

	uploadDir := filepath.Join("frontend", "assets", "uploads")
	if _, err := os.Stat(uploadDir); os.IsNotExist(err) {
		uploadDir = filepath.Join("..", "frontend", "assets", "uploads")
	}
	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		log.Printf("[upload] failed to create upload directory %s: %v", uploadDir, err)
		respondError(w, http.StatusInternalServerError, "Failed to create upload directory")
		return
	}

	targetPath := filepath.Join(uploadDir, cleanName)
	outFile, err := os.Create(targetPath)
	if err != nil {
		log.Printf("[upload] failed to create file %s: %v", targetPath, err)
		respondError(w, http.StatusInternalServerError, "Failed to create destination file")
		return
	}
	defer outFile.Close()

	if _, err := io.Copy(outFile, r.Body); err != nil {
		log.Printf("[upload] failed to save video payload to %s: %v", targetPath, err)
		respondError(w, http.StatusInternalServerError, "Failed to save uploaded video")
		return
	}

	log.Printf("[upload] local dev simulated upload saved successfully: %s", targetPath)
	w.WriteHeader(http.StatusOK)
}

