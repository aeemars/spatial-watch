package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/mux"
	gorillaWs "github.com/gorilla/websocket"
	"spatialwatch/models"
	"spatialwatch/repository"
	ws "spatialwatch/websocket"
)

// Handler holds all HTTP handler dependencies
type Handler struct {
	RoomRepo     *repository.RoomRepo
	PartRepo     *repository.ParticipantRepo
	CommentRepo  *repository.CommentaryRepo
	ReactionRepo *repository.ReactionRepo
	Hub          *ws.Hub
	upgrader     gorillaWs.Upgrader
}

// NewHandler creates a new handler with all dependencies
func NewHandler(
	roomRepo *repository.RoomRepo,
	partRepo *repository.ParticipantRepo,
	commentRepo *repository.CommentaryRepo,
	reactionRepo *repository.ReactionRepo,
	hub *ws.Hub,
) *Handler {
	return &Handler{
		RoomRepo:     roomRepo,
		PartRepo:     partRepo,
		CommentRepo:  commentRepo,
		ReactionRepo: reactionRepo,
		Hub:          hub,
		upgrader: gorillaWs.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				return true // Allow all origins for development
			},
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

// CreateRoom handles POST /api/rooms
func (h *Handler) CreateRoom(w http.ResponseWriter, r *http.Request) {
	var req models.CreateRoomRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate display name
	displayName := strings.TrimSpace(req.DisplayName)
	if len(displayName) < 1 || len(displayName) > 30 {
		respondError(w, http.StatusBadRequest, "Display name must be 1-30 characters")
		return
	}

	// Generate room code
	roomCode, err := repository.GenerateRoomCode()
	if err != nil {
		log.Printf("[api] failed to generate room code: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to create room")
		return
	}

	// Generate participant ID
	participantID := generateParticipantID()

	// Set default media URL if not provided
	mediaURL := req.MediaURL
	if mediaURL == "" {
		mediaURL = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	// Create the room
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

	// Create the host participant
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

// JoinRoom handles POST /api/rooms/join
func (h *Handler) JoinRoom(w http.ResponseWriter, r *http.Request) {
	var req models.JoinRoomRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate
	roomCode := strings.TrimSpace(strings.ToUpper(req.RoomCode))
	displayName := strings.TrimSpace(req.DisplayName)

	if len(roomCode) < 4 {
		respondError(w, http.StatusBadRequest, "Invalid room code")
		return
	}
	if len(displayName) < 1 || len(displayName) > 30 {
		respondError(w, http.StatusBadRequest, "Display name must be 1-30 characters")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	// Verify room exists
	room, err := h.RoomRepo.FindByCode(ctx, roomCode)
	if err != nil {
		respondError(w, http.StatusNotFound, "Room not found")
		return
	}

	// Create participant
	participantID := generateParticipantID()
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

// HandleWebSocket handles GET /ws
func (h *Handler) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	roomCode := strings.ToUpper(r.URL.Query().Get("roomCode"))
	participantID := r.URL.Query().Get("participantId")

	if roomCode == "" || participantID == "" {
		http.Error(w, "Missing roomCode or participantId", http.StatusBadRequest)
		return
	}

	// Verify room exists
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	_, err := h.RoomRepo.FindByCode(ctx, roomCode)
	if err != nil {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}

	// Look up participant display name
	participants, _ := h.PartRepo.FindByRoom(ctx, roomCode)
	displayName := "Unknown"
	for _, p := range participants {
		if p.ParticipantID == participantID {
			displayName = p.DisplayName
			break
		}
	}

	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[ws] upgrade error: %v", err)
		return
	}

	client := &ws.Client{
		Hub:           h.Hub,
		Conn:          conn,
		Send:          make(chan []byte, 256),
		RoomCode:      roomCode,
		ParticipantID: participantID,
		DisplayName:   displayName,
	}

	h.Hub.Register(client)

	go client.WritePump()
	go client.ReadPump()
}

// Utility functions

func generateParticipantID() string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 16)
	for i := range b {
		n := time.Now().UnixNano() % int64(len(chars))
		b[i] = chars[n]
		// Add entropy through nanosecond timing variation
		time.Sleep(time.Nanosecond)
	}
	return "p_" + string(b)
}

func respondJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func respondError(w http.ResponseWriter, status int, message string) {
	respondJSON(w, status, map[string]string{"error": message})
}
