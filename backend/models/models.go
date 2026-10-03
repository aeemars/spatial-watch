package models

import (
	"time"

	"go.mongodb.org/mongo-driver/bson/primitive"
)

// Room represents a watch room
type Room struct {
	ID                      primitive.ObjectID `bson:"_id,omitempty" json:"id"`
	RoomCode                string             `bson:"roomCode" json:"roomCode"`
	HostParticipantID       string             `bson:"hostParticipantId" json:"hostParticipantId"`
	MediaURL                string             `bson:"mediaUrl" json:"mediaUrl"`
	PlaybackPositionSeconds float64            `bson:"playbackPositionSeconds" json:"playbackPositionSeconds"`
	IsPaused                bool               `bson:"isPaused" json:"isPaused"`
	DirectorCutEnabled      bool               `bson:"directorCutEnabled" json:"directorCutEnabled"`
	CreatedAt               time.Time          `bson:"createdAt" json:"createdAt"`
	UpdatedAt               time.Time          `bson:"updatedAt" json:"updatedAt"`
}

// Participant represents a user in a room
type Participant struct {
	ID            primitive.ObjectID `bson:"_id,omitempty" json:"id"`
	ParticipantID string             `bson:"participantId" json:"participantId"`
	RoomCode      string             `bson:"roomCode" json:"roomCode"`
	DisplayName   string             `bson:"displayName" json:"displayName"`
	JoinedAt      time.Time          `bson:"joinedAt" json:"joinedAt"`
	LastSeenAt    time.Time          `bson:"lastSeenAt" json:"lastSeenAt"`
}

// CommentaryCue represents a Director's Cut commentary entry
type CommentaryCue struct {
	ID               primitive.ObjectID `bson:"_id,omitempty" json:"id"`
	RoomCode         string             `bson:"roomCode" json:"roomCode"`
	TemplateRef      string             `bson:"templateRef" json:"templateRef"`
	TimestampSeconds float64            `bson:"timestampSeconds" json:"timestampSeconds"`
	Title            string             `bson:"title" json:"title"`
	Body             string             `bson:"body" json:"body"`
	Category         string             `bson:"category" json:"category"`
}

// Reaction represents a user reaction event
type Reaction struct {
	ID            primitive.ObjectID `bson:"_id,omitempty" json:"id"`
	RoomCode      string             `bson:"roomCode" json:"roomCode"`
	ParticipantID string             `bson:"participantId" json:"participantId"`
	ReactionType  string             `bson:"reactionType" json:"reactionType"`
	CreatedAt     time.Time          `bson:"createdAt" json:"createdAt"`
}

// CreateRoomRequest is the request body for creating a room
type CreateRoomRequest struct {
	DisplayName string `json:"displayName"`
	MediaURL    string `json:"mediaUrl,omitempty"`
}

// CreateRoomResponse is returned after creating a room
type CreateRoomResponse struct {
	RoomCode      string `json:"roomCode"`
	ParticipantID string `json:"participantId"`
	IsHost        bool   `json:"isHost"`
}

// JoinRoomRequest is the request body for joining a room
type JoinRoomRequest struct {
	RoomCode    string `json:"roomCode"`
	DisplayName string `json:"displayName"`
}

// JoinRoomResponse is returned after joining a room
type JoinRoomResponse struct {
	RoomCode      string `json:"roomCode"`
	ParticipantID string `json:"participantId"`
	IsHost        bool   `json:"isHost"`
}

// WSEvent represents a WebSocket message
type WSEvent struct {
	Type          string      `json:"type"`
	ParticipantID string      `json:"participantId,omitempty"`
	DisplayName   string      `json:"displayName,omitempty"`
	Payload       interface{} `json:"payload,omitempty"`
	ServerTime    int64       `json:"serverTime,omitempty"`
}

// PlaybackPayload carries play/pause/seek data
type PlaybackPayload struct {
	Action     string  `json:"action"`
	Position   float64 `json:"position"`
	ServerTime int64   `json:"serverTime"`
}

// ReactionPayload carries reaction data
type ReactionPayload struct {
	ReactionType string `json:"reactionType"`
}

// DirectorCutPayload carries director-cut toggle data
type DirectorCutPayload struct {
	Enabled bool `json:"enabled"`
}

// RoomStatePayload carries the full room state for sync
type RoomStatePayload struct {
	RoomCode           string        `json:"roomCode"`
	MediaURL           string        `json:"mediaUrl"`
	IsPaused           bool          `json:"isPaused"`
	Position           float64       `json:"position"`
	DirectorCutEnabled bool          `json:"directorCutEnabled"`
	HostParticipantID  string        `json:"hostParticipantId"`
	Participants       []Participant `json:"participants"`
	ServerTime         int64         `json:"serverTime"`
}

// Valid reaction types
var ValidReactionTypes = map[string]bool{
	"applause":  true,
	"laugh":     true,
	"heart":     true,
	"surprised": true,
	"wow":       true,
	"popcorn":   true,
}
