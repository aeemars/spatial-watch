package repository

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"spatialwatch/models"
)

// ParticipantRepo handles participant persistence
type ParticipantRepo struct {
	col          *mongo.Collection
	mu           sync.RWMutex
	participants map[string]*models.Participant
}

// NewParticipantRepo creates a new participant repository
func NewParticipantRepo(db *mongo.Database) *ParticipantRepo {
	repo := &ParticipantRepo{
		participants: make(map[string]*models.Participant),
	}
	if db != nil {
		col := db.Collection("participants")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		// Drop old restrictive participantId_1 unique index if present
		_ = col.Indexes().DropOne(ctx, "participantId_1")

		// Index on roomCode for quick lookup
		col.Indexes().CreateOne(ctx, mongo.IndexModel{
			Keys: bson.D{{Key: "roomCode", Value: 1}},
		})
		// Index on participantId + joinedAt for fast GetUserRooms sorting
		col.Indexes().CreateOne(ctx, mongo.IndexModel{
			Keys: bson.D{{Key: "participantId", Value: 1}, {Key: "joinedAt", Value: -1}},
		})
		// Compound index for user in room
		col.Indexes().CreateOne(ctx, mongo.IndexModel{
			Keys: bson.D{
				{Key: "participantId", Value: 1},
				{Key: "roomCode", Value: 1},
			},
		})
		repo.col = col
	}
	return repo
}

// Create inserts or updates an active participant record
func (r *ParticipantRepo) Create(ctx context.Context, p *models.Participant) error {
	p.JoinedAt = time.Now()
	p.LastSeenAt = time.Now()
	p.RoomCode = strings.ToUpper(p.RoomCode)
	p.HasLeft = false
	if r.col != nil {
		opts := options.UpdateOne().SetUpsert(true)
		_, err := r.col.UpdateOne(ctx,
			bson.M{
				"participantId": p.ParticipantID,
				"roomCode":      p.RoomCode,
			},
			bson.M{
				"$set": bson.M{
					"roomCode":    p.RoomCode,
					"displayName": p.DisplayName,
					"joinedAt":    p.JoinedAt,
					"lastSeenAt":  p.LastSeenAt,
					"hasLeft":     false,
				},
			},
			opts,
		)
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	copy := *p
	key := fmt.Sprintf("%s:%s", p.ParticipantID, p.RoomCode)
	r.participants[key] = &copy
	return nil
}

// FindByRoom retrieves all active participants for a room
func (r *ParticipantRepo) FindByRoom(ctx context.Context, roomCode string) ([]models.Participant, error) {
	upper := strings.ToUpper(roomCode)
	if r.col != nil {
		cursor, err := r.col.Find(ctx, bson.M{
			"roomCode": upper,
			"hasLeft":  bson.M{"$ne": true},
		})
		if err != nil {
			return nil, err
		}
		defer cursor.Close(ctx)

		var participants []models.Participant
		if err := cursor.All(ctx, &participants); err != nil {
			return nil, err
		}
		return participants, nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	var participants []models.Participant
	for _, p := range r.participants {
		if strings.EqualFold(p.RoomCode, upper) && !p.HasLeft {
			participants = append(participants, *p)
		}
	}
	return participants, nil
}

// FindParticipantsByRooms retrieves active participants for multiple rooms and groups them by room code
func (r *ParticipantRepo) FindParticipantsByRooms(ctx context.Context, roomCodes []string) (map[string][]models.Participant, error) {
	result := make(map[string][]models.Participant)
	if len(roomCodes) == 0 {
		return result, nil
	}

	upperCodes := make([]string, len(roomCodes))
	for i, code := range roomCodes {
		upperCodes[i] = strings.ToUpper(code)
	}

	if r.col != nil {
		cursor, err := r.col.Find(ctx, bson.M{
			"roomCode": bson.M{"$in": upperCodes},
			"hasLeft":  bson.M{"$ne": true},
		})
		if err != nil {
			return nil, err
		}
		defer cursor.Close(ctx)

		var participants []models.Participant
		if err := cursor.All(ctx, &participants); err != nil {
			return nil, err
		}
		
		for _, p := range participants {
			result[p.RoomCode] = append(result[p.RoomCode], p)
		}
		return result, nil
	}

	r.mu.RLock()
	defer r.mu.RUnlock()
	
	codeMap := make(map[string]bool)
	for _, code := range upperCodes {
		codeMap[code] = true
	}

	for _, p := range r.participants {
		if codeMap[strings.ToUpper(p.RoomCode)] && !p.HasLeft {
			result[strings.ToUpper(p.RoomCode)] = append(result[strings.ToUpper(p.RoomCode)], *p)
		}
	}
	return result, nil
}

// FindByParticipantID retrieves all active room participation records for a user
func (r *ParticipantRepo) FindByParticipantID(ctx context.Context, participantID string) ([]models.Participant, error) {
	if r.col != nil {
		opts := options.Find().SetSort(bson.D{{Key: "joinedAt", Value: -1}})
		cursor, err := r.col.Find(ctx, bson.M{
			"participantId": participantID,
			"hasLeft":       bson.M{"$ne": true},
		}, opts)
		if err != nil {
			return nil, err
		}
		defer cursor.Close(ctx)

		var participants []models.Participant
		if err := cursor.All(ctx, &participants); err != nil {
			return nil, err
		}
		return participants, nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	var participants []models.Participant
	for _, p := range r.participants {
		if p.ParticipantID == participantID && !p.HasLeft {
			participants = append(participants, *p)
		}
	}
	return participants, nil
}

// Leave marks a participant as having left a room
func (r *ParticipantRepo) Leave(ctx context.Context, roomCode string, participantID string) error {
	upper := strings.ToUpper(roomCode)
	now := time.Now()
	if r.col != nil {
		_, err := r.col.UpdateOne(ctx,
			bson.M{
				"participantId": participantID,
				"roomCode":      upper,
			},
			bson.M{
				"$set": bson.M{
					"hasLeft":    true,
					"lastSeenAt": now,
				},
			},
		)
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	key := fmt.Sprintf("%s:%s", participantID, upper)
	if p, ok := r.participants[key]; ok {
		p.HasLeft = true
		p.LastSeenAt = now
	}
	return nil
}

// UpdateLastSeen refreshes the last seen timestamp
func (r *ParticipantRepo) UpdateLastSeen(ctx context.Context, participantID string) error {
	now := time.Now()
	if r.col != nil {
		_, err := r.col.UpdateMany(ctx,
			bson.M{"participantId": participantID},
			bson.M{"$set": bson.M{"lastSeenAt": now}},
		)
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.participants {
		if p.ParticipantID == participantID {
			p.LastSeenAt = now
		}
	}
	return nil
}

// Remove deletes participant records by participantID
func (r *ParticipantRepo) Remove(ctx context.Context, participantID string) error {
	if r.col != nil {
		_, err := r.col.DeleteMany(ctx, bson.M{"participantId": participantID})
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for k, p := range r.participants {
		if p.ParticipantID == participantID {
			delete(r.participants, k)
		}
	}
	return nil
}
