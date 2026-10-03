package repository

import (
	"context"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
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

		// Index on roomCode for quick lookup
		col.Indexes().CreateOne(ctx, mongo.IndexModel{
			Keys: bson.D{{Key: "roomCode", Value: 1}},
		})
		// Unique index on participantId
		col.Indexes().CreateOne(ctx, mongo.IndexModel{
			Keys:    bson.D{{Key: "participantId", Value: 1}},
			Options: options.Index().SetUnique(true),
		})
		repo.col = col
	}
	return repo
}

// Create inserts a new participant
func (r *ParticipantRepo) Create(ctx context.Context, p *models.Participant) error {
	p.JoinedAt = time.Now()
	p.LastSeenAt = time.Now()
	if r.col != nil {
		_, err := r.col.InsertOne(ctx, p)
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	copy := *p
	r.participants[p.ParticipantID] = &copy
	return nil
}

// FindByRoom retrieves all participants for a room
func (r *ParticipantRepo) FindByRoom(ctx context.Context, roomCode string) ([]models.Participant, error) {
	if r.col != nil {
		cursor, err := r.col.Find(ctx, bson.M{"roomCode": roomCode})
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
		if strings.EqualFold(p.RoomCode, roomCode) {
			participants = append(participants, *p)
		}
	}
	return participants, nil
}

// UpdateLastSeen refreshes the last seen timestamp
func (r *ParticipantRepo) UpdateLastSeen(ctx context.Context, participantID string) error {
	if r.col != nil {
		_, err := r.col.UpdateOne(ctx,
			bson.M{"participantId": participantID},
			bson.M{"$set": bson.M{"lastSeenAt": time.Now()}},
		)
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.participants[participantID]; ok {
		p.LastSeenAt = time.Now()
	}
	return nil
}

// Remove deletes a participant
func (r *ParticipantRepo) Remove(ctx context.Context, participantID string) error {
	if r.col != nil {
		_, err := r.col.DeleteOne(ctx, bson.M{"participantId": participantID})
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.participants, participantID)
	return nil
}
