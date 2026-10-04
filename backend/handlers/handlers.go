package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/mux"
	gorillaWs "github.com/gorilla/websocket"
	"spatialwatch/internal/auth"
	"spatialwatch/models"
	"spatialwatch/repository"
	ws "spatialwatch/websocket"
)

// Handler holds all HTTP and WebSocket handler dependencies
type Handler struct {
	RoomRepo     *repository.RoomRepo
	PartRepo     *repository.ParticipantRepo
	CommentRepo  *repository.CommentaryRepo
	ReactionRepo *repository.ReactionRepo
	Hub          *ws.Hub
	AuthService  *auth.AuthService
	upgrader     gorillaWs.Upgrader
}

// NewHandler creates a new handler with all dependencies
func NewHandler(
	roomRepo *repository.RoomRepo,
	partRepo *repository.ParticipantRepo,
	commentRepo *repository.CommentaryRepo,
	reactionRepo *repository.ReactionRepo,
	hub *ws.Hub,
	authService *auth.AuthService,
	corsOrigins []string,
) *Handler {
	return &Handler{
		RoomRepo:     roomRepo,
		PartRepo:     partRepo,
		CommentRepo:  commentRepo,
		ReactionRepo: reactionRepo,
		Hub:          hub,
		AuthService:  authService,
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

	roomCode, err := repository.GenerateRoomCode()
	if err != nil {
		log.Printf("[api] failed to generate room code: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to create room")
		return
	}

	// Host ID is always the authenticated session user ID
	participantID := authUser.ID

	mediaURL := req.MediaURL
	if mediaURL == "" {
		mediaURL = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	room := &models.Room{
		RoomCode:                roomCode,
		HostParticipantID:       participantID,
		MediaURL:                mediaURL,
		PlaybackPositionSeconds: 0,
		IsPaused:                true,
		DirectorCutEnabled:      false,
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

	log.Printf("[api] room %s created by %s (%s)", roomCode, displayName, participantID)

	respondJSON(w, http.StatusCreated, models.CreateRoomResponse{
		RoomCode:      roomCode,
		ParticipantID: participantID,
		IsHost:        true,
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
	if err != nil {
		respondError(w, http.StatusNotFound, "Room not found")
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

	log.Printf("[api] %s (%s) joined room %s", displayName, participantID, roomCode)

	respondJSON(w, http.StatusOK, models.JoinRoomResponse{
		RoomCode:      roomCode,
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
	if err != nil {
		respondError(w, http.StatusNotFound, "Room not found")
		return
	}

	participants, _ := h.PartRepo.FindByRoom(ctx, roomCode)

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"room":         room,
		"participants": participants,
		"activeCount":  h.Hub.GetRoomParticipantCount(roomCode),
	})
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

	_, err = h.RoomRepo.FindByCode(ctx, roomCode)
	if err != nil {
		http.Error(w, "Room not found", http.StatusNotFound)
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
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func respondError(w http.ResponseWriter, status int, message string) {
	respondJSON(w, status, map[string]string{"error": message})
}
