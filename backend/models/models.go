package models

import (
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// User represents a guest or authenticated user
type User struct {
	ID          string    `bson:"_id" json:"id"` // UUID v4
	DisplayName string    `bson:"displayName" json:"displayName"`
	IsGuest     bool      `bson:"isGuest" json:"isGuest"`
	CreatedAt   time.Time `bson:"createdAt" json:"createdAt"`
	LastSeenAt  time.Time `bson:"lastSeenAt" json:"lastSeenAt"`
}

// Session represents an authenticated user session
type Session struct {
	ID         bson.ObjectID `bson:"_id,omitempty" json:"id,omitempty"`
	TokenHash  string        `bson:"tokenHash" json:"-"`
	UserID     string        `bson:"userId" json:"userId"`
	CreatedAt  time.Time     `bson:"createdAt" json:"createdAt"`
	ExpiresAt  time.Time     `bson:"expiresAt" json:"expiresAt"`
	LastSeenAt time.Time     `bson:"lastSeenAt" json:"lastSeenAt"`
}

// SanitizedUser contains safe user fields for API responses
type SanitizedUser struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	IsGuest     bool   `json:"isGuest"`
}

// ToSanitized returns safe user fields
func (u *User) ToSanitized() SanitizedUser {
	return SanitizedUser{
		ID:          u.ID,
		DisplayName: u.DisplayName,
		IsGuest:     u.IsGuest,
	}
}

// AuthSessionResponse is returned by GET /api/auth/session
type AuthSessionResponse struct {
	User SanitizedUser `json:"user"`
}

// UpdateProfileRequest is the body for PATCH /api/auth/profile
type UpdateProfileRequest struct {
	DisplayName string `json:"displayName"`
}

// UpdateProfileResponse is returned by PATCH /api/auth/profile
type UpdateProfileResponse struct {
	User SanitizedUser `json:"user"`
}

// Room represents a watch room
type Room struct {
	ID                      bson.ObjectID `bson:"_id,omitempty" json:"id"`
	RoomCode                string        `bson:"roomCode" json:"roomCode"`
	Name                    string        `bson:"name" json:"name"`
	IsActive                bool          `bson:"isActive" json:"isActive"`
	HostParticipantID       string        `bson:"hostParticipantId" json:"hostParticipantId"`
	MediaURL                string        `bson:"mediaUrl" json:"mediaUrl"`
	PlaybackPositionSeconds float64       `bson:"playbackPositionSeconds" json:"playbackPositionSeconds"`
	IsPaused                bool          `bson:"isPaused" json:"isPaused"`
	DirectorCutEnabled      bool          `bson:"directorCutEnabled" json:"directorCutEnabled"`
	CreatedAt               time.Time     `bson:"createdAt" json:"createdAt"`
	UpdatedAt               time.Time     `bson:"updatedAt" json:"updatedAt"`
}

// Participant represents a user in a room
type Participant struct {
	ID            bson.ObjectID `bson:"_id,omitempty" json:"id"`
	ParticipantID string        `bson:"participantId" json:"participantId"`
	RoomCode      string        `bson:"roomCode" json:"roomCode"`
	DisplayName   string        `bson:"displayName" json:"displayName"`
	JoinedAt      time.Time     `bson:"joinedAt" json:"joinedAt"`
	LastSeenAt    time.Time     `bson:"lastSeenAt" json:"lastSeenAt"`
	HasLeft       bool          `bson:"hasLeft" json:"hasLeft"`
}

// CommentaryCue represents a Director's Cut commentary entry
type CommentaryCue struct {
	ID               bson.ObjectID `bson:"_id,omitempty" json:"id"`
	RoomCode         string        `bson:"roomCode" json:"roomCode"`
	TemplateRef      string        `bson:"templateRef" json:"templateRef"`
	TimestampSeconds float64       `bson:"timestampSeconds" json:"timestampSeconds"`
	Title            string        `bson:"title" json:"title"`
	Body             string        `bson:"body" json:"body"`
	Category         string        `bson:"category" json:"category"`
}

// Reaction represents a user reaction event
type Reaction struct {
	ID            bson.ObjectID `bson:"_id,omitempty" json:"id"`
	RoomCode      string        `bson:"roomCode" json:"roomCode"`
	ParticipantID string        `bson:"participantId" json:"participantId"`
	ReactionType  string        `bson:"reactionType" json:"reactionType"`
	CreatedAt     time.Time     `bson:"createdAt" json:"createdAt"`
}

// CreateRoomRequest is the request body for creating a room
type CreateRoomRequest struct {
	RoomName    string `json:"roomName"`
	DisplayName string `json:"displayName"`
	MediaURL    string `json:"mediaUrl,omitempty"`
}

// CreateRoomResponse is returned after creating a room
type CreateRoomResponse struct {
	RoomCode      string `json:"roomCode"`
	Name          string `json:"name"`
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
	Name          string `json:"name"`
	ParticipantID string `json:"participantId"`
	IsHost        bool   `json:"isHost"`
}

// UserRoomRecord represents an active room for continued access
type UserRoomRecord struct {
	RoomCode          string    `json:"roomCode"`
	Name              string    `json:"name"`
	HostDisplayName   string    `json:"hostDisplayName,omitempty"`
	HostParticipantID string    `json:"hostParticipantId"`
	MediaURL          string    `json:"mediaUrl"`
	MediaTitle        string    `json:"mediaTitle"`
	ParticipantCount  int       `json:"participantCount"`
	CreatedAt         time.Time `json:"createdAt"`
	JoinedAt          time.Time `json:"joinedAt,omitempty"`
	IsHost            bool      `json:"isHost"`
	IsActive          bool      `json:"isActive"`
}

// UserRoomsResponse is returned by GET /api/user/rooms
type UserRoomsResponse struct {
	CreatedRooms []UserRoomRecord `json:"createdRooms"`
	JoinedRooms  []UserRoomRecord `json:"joinedRooms"`
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
	Name               string        `json:"name"`
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
