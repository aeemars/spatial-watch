package repository

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"spatialwatch/models"
)

// RoomRepo handles room persistence
type RoomRepo struct {
	col         *mongo.Collection
	mu          sync.RWMutex
	memoryRooms map[string]*models.Room
}

// NewRoomRepo creates a new room repository
func NewRoomRepo(db *mongo.Database) *RoomRepo {
	repo := &RoomRepo{
		memoryRooms: make(map[string]*models.Room),
	}
	if db != nil {
		col := db.Collection("rooms")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		// Create unique index on roomCode
		col.Indexes().CreateOne(ctx, mongo.IndexModel{
			Keys:    bson.D{{Key: "roomCode", Value: 1}},
			Options: options.Index().SetUnique(true),
		})
		repo.col = col
	}
	return repo
}

// GenerateRoomCode creates a short human-readable code like SW-AB12
func GenerateRoomCode() (string, error) {
	const letters = "ABCDEFGHJKMNPQRSTUVWXYZ"
	const digits = "23456789"

	code := make([]byte, 4)
	for i := 0; i < 2; i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(letters))))
		if err != nil {
			return "", err
		}
		code[i] = letters[n.Int64()]
	}
	for i := 2; i < 4; i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(digits))))
		if err != nil {
			return "", err
		}
		code[i] = digits[n.Int64()]
	}

	return fmt.Sprintf("SW-%s", string(code)), nil
}

// Create inserts a new room
func (r *RoomRepo) Create(ctx context.Context, room *models.Room) error {
	room.CreatedAt = time.Now()
	room.UpdatedAt = time.Now()
	room.IsPaused = true
	if r.col != nil {
		_, err := r.col.InsertOne(ctx, room)
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	copy := *room
	r.memoryRooms[strings.ToUpper(room.RoomCode)] = &copy
	return nil
}

// FindByCode retrieves a room by its code
func (r *RoomRepo) FindByCode(ctx context.Context, code string) (*models.Room, error) {
	upper := strings.ToUpper(code)
	if r.col != nil {
		var room models.Room
		err := r.col.FindOne(ctx, bson.M{"roomCode": upper}).Decode(&room)
		if err != nil {
			return nil, err
		}
		return &room, nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	room, ok := r.memoryRooms[upper]
	if !ok {
		return nil, mongo.ErrNoDocuments
	}
	copy := *room
	return &copy, nil
}

// UpdatePlaybackState updates playback position and pause state
func (r *RoomRepo) UpdatePlaybackState(ctx context.Context, code string, position float64, isPaused bool) error {
	if r.col != nil {
		_, err := r.col.UpdateOne(ctx,
			bson.M{"roomCode": code},
			bson.M{"$set": bson.M{
				"playbackPositionSeconds": position,
				"isPaused":                isPaused,
				"updatedAt":               time.Now(),
			}},
		)
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if room, ok := r.memoryRooms[strings.ToUpper(code)]; ok {
		room.PlaybackPositionSeconds = position
		room.IsPaused = isPaused
		room.UpdatedAt = time.Now()
	}
	return nil
}

// UpdateDirectorCut toggles Director's Cut mode
func (r *RoomRepo) UpdateDirectorCut(ctx context.Context, code string, enabled bool) error {
	if r.col != nil {
		_, err := r.col.UpdateOne(ctx,
			bson.M{"roomCode": code},
			bson.M{"$set": bson.M{
				"directorCutEnabled": enabled,
				"updatedAt":          time.Now(),
			}},
		)
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if room, ok := r.memoryRooms[strings.ToUpper(code)]; ok {
		room.DirectorCutEnabled = enabled
		room.UpdatedAt = time.Now()
	}
	return nil
}

// UpdateMediaURL sets the media source
func (r *RoomRepo) UpdateMediaURL(ctx context.Context, code string, url string) error {
	if r.col != nil {
		_, err := r.col.UpdateOne(ctx,
			bson.M{"roomCode": code},
			bson.M{"$set": bson.M{
				"mediaUrl":  url,
				"updatedAt": time.Now(),
			}},
		)
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if room, ok := r.memoryRooms[strings.ToUpper(code)]; ok {
		room.MediaURL = url
		room.UpdatedAt = time.Now()
	}
	return nil
}
