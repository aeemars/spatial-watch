package repository

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
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
	room.IsActive = true
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

// ExistsActiveByName checks if an active room already exists with the given name (case-insensitive)
func (r *RoomRepo) ExistsActiveByName(ctx context.Context, name string) (bool, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return false, nil
	}

	if r.col != nil {
		pattern := fmt.Sprintf("^%s$", regexp.QuoteMeta(trimmed))
		filter := bson.M{
			"name": bson.M{
				"$regex":   pattern,
				"$options": "i",
			},
			"isActive": bson.M{"$ne": false},
		}
		count, err := r.col.CountDocuments(ctx, filter)
		if err != nil {
			return false, err
		}
		return count > 0, nil
	}

	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, room := range r.memoryRooms {
		if room.IsActive && strings.EqualFold(strings.TrimSpace(room.Name), trimmed) {
			return true, nil
		}
	}
	return false, nil
}

// FindByHost returns all rooms (active and inactive) created by the host, ordered newest first
func (r *RoomRepo) FindByHost(ctx context.Context, hostParticipantID string) ([]models.Room, error) {
	if r.col != nil {
		opts := options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}})
		filter := bson.M{
			"hostParticipantId": hostParticipantID,
		}
		cursor, err := r.col.Find(ctx, filter, opts)
		if err != nil {
			return nil, err
		}
		defer cursor.Close(ctx)

		var rooms []models.Room
		if err := cursor.All(ctx, &rooms); err != nil {
			return nil, err
		}
		return rooms, nil
	}

	r.mu.RLock()
	defer r.mu.RUnlock()
	var rooms []models.Room
	for _, room := range r.memoryRooms {
		if room.HostParticipantID == hostParticipantID {
			rooms = append(rooms, *room)
		}
	}
	sort.Slice(rooms, func(i, j int) bool {
		return rooms[i].CreatedAt.After(rooms[j].CreatedAt)
	})
	return rooms, nil
}

// FindByCodes returns all rooms matching the given room codes
func (r *RoomRepo) FindByCodes(ctx context.Context, codes []string) ([]models.Room, error) {
	if len(codes) == 0 {
		return []models.Room{}, nil
	}

	upperCodes := make([]string, len(codes))
	for i, c := range codes {
		upperCodes[i] = strings.ToUpper(c)
	}

	if r.col != nil {
		opts := options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}})
		filter := bson.M{
			"roomCode": bson.M{"$in": upperCodes},
		}
		cursor, err := r.col.Find(ctx, filter, opts)
		if err != nil {
			return nil, err
		}
		defer cursor.Close(ctx)

		var rooms []models.Room
		if err := cursor.All(ctx, &rooms); err != nil {
			return nil, err
		}
		return rooms, nil
	}

	r.mu.RLock()
	defer r.mu.RUnlock()
	codeSet := make(map[string]bool, len(upperCodes))
	for _, c := range upperCodes {
		codeSet[c] = true
	}

	var rooms []models.Room
	for _, room := range r.memoryRooms {
		if codeSet[strings.ToUpper(room.RoomCode)] {
			rooms = append(rooms, *room)
		}
	}
	sort.Slice(rooms, func(i, j int) bool {
		return rooms[i].CreatedAt.After(rooms[j].CreatedAt)
	})
	return rooms, nil
}

// Shutdown sets isActive to false for the given room
func (r *RoomRepo) Shutdown(ctx context.Context, code string) error {
	upper := strings.ToUpper(code)
	now := time.Now()
	if r.col != nil {
		_, err := r.col.UpdateOne(ctx,
			bson.M{"roomCode": upper},
			bson.M{"$set": bson.M{
				"isActive":  false,
				"updatedAt": now,
			}},
		)
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if room, ok := r.memoryRooms[upper]; ok {
		room.IsActive = false
		room.UpdatedAt = now
		return nil
	}
	return mongo.ErrNoDocuments
}

// FindExpiredActive returns all active rooms whose ExpiresAt is non-zero and <= now
func (r *RoomRepo) FindExpiredActive(ctx context.Context, now time.Time) ([]models.Room, error) {
	if r.col != nil {
		filter := bson.M{
			"isActive":  bson.M{"$ne": false},
			"expiresAt": bson.M{"$gt": time.Time{}, "$lte": now},
		}
		cursor, err := r.col.Find(ctx, filter)
		if err != nil {
			return nil, err
		}
		defer cursor.Close(ctx)

		var rooms []models.Room
		if err := cursor.All(ctx, &rooms); err != nil {
			return nil, err
		}
		return rooms, nil
	}

	r.mu.RLock()
	defer r.mu.RUnlock()
	var rooms []models.Room
	for _, room := range r.memoryRooms {
		if room.IsActive && !room.ExpiresAt.IsZero() && !room.ExpiresAt.After(now) {
			rooms = append(rooms, *room)
		}
	}
	return rooms, nil
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
