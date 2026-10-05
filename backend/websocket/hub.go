package websocket

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"

	"spatialwatch/models"
	"spatialwatch/repository"
)

// Hub manages all active rooms and their WebSocket connections
type Hub struct {
	mu           sync.RWMutex
	rooms        map[string]map[*Client]bool
	roomRepo     *repository.RoomRepo
	partRepo     *repository.ParticipantRepo
	reactionRepo *repository.ReactionRepo
	rateLimiter  *RateLimiter
}

// NewHub creates a new WebSocket hub
func NewHub(roomRepo *repository.RoomRepo, partRepo *repository.ParticipantRepo, reactionRepo *repository.ReactionRepo) *Hub {
	return &Hub{
		rooms:        make(map[string]map[*Client]bool),
		roomRepo:     roomRepo,
		partRepo:     partRepo,
		reactionRepo: reactionRepo,
		rateLimiter:  NewRateLimiter(),
	}
}

// Register adds a client to a room
func (h *Hub) Register(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.rooms[client.RoomCode] == nil {
		h.rooms[client.RoomCode] = make(map[*Client]bool)
	}
	h.rooms[client.RoomCode][client] = true

	log.Printf("[ws] participant %s joined room %s", client.ParticipantID, client.RoomCode)

	// Broadcast join to other participants
	h.broadcastToRoomLocked(client.RoomCode, &models.WSEvent{
		Type:          "participant_joined",
		ParticipantID: client.ParticipantID,
		DisplayName:   client.DisplayName,
		ServerTime:    time.Now().UnixMilli(),
	}, nil)
}

// Unregister removes a client from a room
func (h *Hub) Unregister(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if clients, ok := h.rooms[client.RoomCode]; ok {
		if _, exists := clients[client]; exists {
			delete(clients, client)
			close(client.Send)

			log.Printf("[ws] participant %s left room %s", client.ParticipantID, client.RoomCode)

			// Broadcast leave
			h.broadcastToRoomLocked(client.RoomCode, &models.WSEvent{
				Type:          "participant_left",
				ParticipantID: client.ParticipantID,
				DisplayName:   client.DisplayName,
				ServerTime:    time.Now().UnixMilli(),
			}, nil)

			// Clean up empty room
			if len(clients) == 0 {
				delete(h.rooms, client.RoomCode)
			}
		}
	}
}

// HandleMessage processes incoming WebSocket messages
func (h *Hub) HandleMessage(client *Client, raw []byte) {
	var event models.WSEvent
	if err := json.Unmarshal(raw, &event); err != nil {
		log.Printf("[ws] invalid message from %s: %v", client.ParticipantID, err)
		return
	}

	event.ParticipantID = client.ParticipantID
	event.DisplayName = client.DisplayName
	event.ServerTime = time.Now().UnixMilli()

	switch event.Type {
	case "playback":
		h.handlePlayback(client, &event)
	case "reaction":
		h.handleReaction(client, &event)
	case "director_cut":
		h.handleDirectorCut(client, &event)
	case "request_sync":
		h.handleRequestSync(client)
	case "ping":
		// Respond with pong
		client.Send <- mustJSON(&models.WSEvent{
			Type:       "pong",
			ServerTime: time.Now().UnixMilli(),
		})
	default:
		log.Printf("[ws] unknown event type: %s from %s", event.Type, client.ParticipantID)
	}
}

func (h *Hub) handlePlayback(client *Client, event *models.WSEvent) {
	// Rate limit playback events
	if !h.rateLimiter.Allow(client.ParticipantID, "playback", 10, time.Second) {
		return
	}

	// Only host can control playback
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	room, err := h.roomRepo.FindByCode(ctx, client.RoomCode)
	if err != nil {
		log.Printf("[ws] failed to find room %s: %v", client.RoomCode, err)
		return
	}

	if room.HostParticipantID != client.ParticipantID {
		client.Send <- mustJSON(&models.WSEvent{
			Type:    "error",
			Payload: map[string]string{"message": "Only the host can control playback"},
		})
		return
	}

	// Parse playback payload
	payloadBytes, _ := json.Marshal(event.Payload)
	var payload models.PlaybackPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		log.Printf("[ws] invalid playback payload: %v", err)
		return
	}

	payload.ServerTime = time.Now().UnixMilli()

	// Persist meaningful state changes to MongoDB
	isPaused := payload.Action == "pause"
	if payload.Action == "play" || payload.Action == "pause" || payload.Action == "seek" {
		if err := h.roomRepo.UpdatePlaybackState(ctx, client.RoomCode, payload.Position, isPaused); err != nil {
			log.Printf("[ws] failed to update playback state: %v", err)
		}
	}

	// Broadcast to all clients
	event.Payload = payload
	h.BroadcastToRoom(client.RoomCode, event, nil)
}

func (h *Hub) handleReaction(client *Client, event *models.WSEvent) {
	// Rate limit reactions: 5 per second
	if !h.rateLimiter.Allow(client.ParticipantID, "reaction", 5, time.Second) {
		return
	}

	payloadBytes, _ := json.Marshal(event.Payload)
	var payload models.ReactionPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return
	}

	if !models.ValidReactionTypes[payload.ReactionType] {
		return
	}

	// Store reaction in MongoDB
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	h.reactionRepo.Create(ctx, &models.Reaction{
		RoomCode:      client.RoomCode,
		ParticipantID: client.ParticipantID,
		ReactionType:  payload.ReactionType,
	})

	// Broadcast to all
	h.BroadcastToRoom(client.RoomCode, event, nil)
}

func (h *Hub) handleDirectorCut(client *Client, event *models.WSEvent) {
	// Only host can toggle Director's Cut
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	room, err := h.roomRepo.FindByCode(ctx, client.RoomCode)
	if err != nil {
		return
	}

	if room.HostParticipantID != client.ParticipantID {
		client.Send <- mustJSON(&models.WSEvent{
			Type:    "error",
			Payload: map[string]string{"message": "Only the host can toggle Director's Cut"},
		})
		return
	}

	payloadBytes, _ := json.Marshal(event.Payload)
	var payload models.DirectorCutPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return
	}

	if err := h.roomRepo.UpdateDirectorCut(ctx, client.RoomCode, payload.Enabled); err != nil {
		log.Printf("[ws] failed to update director cut: %v", err)
	}

	// Broadcast to all
	h.BroadcastToRoom(client.RoomCode, event, nil)
}

func (h *Hub) handleRequestSync(client *Client) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	room, err := h.roomRepo.FindByCode(ctx, client.RoomCode)
	if err != nil {
		return
	}

	participants, _ := h.partRepo.FindByRoom(ctx, client.RoomCode)

	syncPayload := models.RoomStatePayload{
		RoomCode:           room.RoomCode,
		Name:               room.Name,
		MediaURL:           room.MediaURL,
		IsPaused:           room.IsPaused,
		Position:           room.PlaybackPositionSeconds,
		DirectorCutEnabled: room.DirectorCutEnabled,
		HostParticipantID:  room.HostParticipantID,
		Participants:       participants,
		ServerTime:         time.Now().UnixMilli(),
	}

	client.Send <- mustJSON(&models.WSEvent{
		Type:       "room_state",
		Payload:    syncPayload,
		ServerTime: time.Now().UnixMilli(),
	})
}

// CloseRoom terminates all connections in a room with a shutdown event
func (h *Hub) CloseRoom(roomCode string, reason string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	upper := strings.ToUpper(roomCode)
	clients, ok := h.rooms[upper]
	if !ok {
		return
	}

	event := &models.WSEvent{
		Type:       "room_shutdown",
		Payload:    map[string]string{"reason": reason, "roomCode": upper},
		ServerTime: time.Now().UnixMilli(),
	}
	msg := mustJSON(event)

	for client := range clients {
		select {
		case client.Send <- msg:
		default:
		}
		close(client.Send)
	}
	delete(h.rooms, upper)
	log.Printf("[ws] room %s shut down: %s", upper, reason)
}

// BroadcastToRoom sends a message to all clients in a room
func (h *Hub) BroadcastToRoom(roomCode string, event *models.WSEvent, exclude *Client) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	h.broadcastToRoomLocked(roomCode, event, exclude)
}

func (h *Hub) broadcastToRoomLocked(roomCode string, event *models.WSEvent, exclude *Client) {
	clients, ok := h.rooms[roomCode]
	if !ok {
		return
	}

	msg := mustJSON(event)
	for client := range clients {
		if client == exclude {
			continue
		}
		select {
		case client.Send <- msg:
		default:
			// Client buffer full, close connection
			close(client.Send)
			delete(clients, client)
		}
	}
}

// GetRoomParticipantCount returns the number of active WS connections in a room
func (h *Hub) GetRoomParticipantCount(roomCode string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.rooms[roomCode])
}

func mustJSON(v interface{}) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("[ws] json marshal error: %v", err)
		return []byte("{}")
	}
	return b
}
