package repository

import (
	"context"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"spatialwatch/models"
)

// ReactionRepo handles reaction event persistence
type ReactionRepo struct {
	col       *mongo.Collection
	mu        sync.RWMutex
	reactions []models.Reaction
}

// NewReactionRepo creates a new reaction repository
func NewReactionRepo(db *mongo.Database) *ReactionRepo {
	repo := &ReactionRepo{
		reactions: make([]models.Reaction, 0),
	}
	if db != nil {
		col := db.Collection("reactions")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		// Index on roomCode for analytics queries
		col.Indexes().CreateOne(ctx, mongo.IndexModel{
			Keys: bson.D{{Key: "roomCode", Value: 1}},
		})
		repo.col = col
	}
	return repo
}

// Create inserts a new reaction event
func (r *ReactionRepo) Create(ctx context.Context, reaction *models.Reaction) error {
	reaction.CreatedAt = time.Now()
	if r.col != nil {
		_, err := r.col.InsertOne(ctx, reaction)
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	r.reactions = append(r.reactions, *reaction)
	return nil
}

// FindByRoom retrieves reactions for a room
func (r *ReactionRepo) FindByRoom(ctx context.Context, roomCode string) ([]models.Reaction, error) {
	if r.col != nil {
		cursor, err := r.col.Find(ctx, bson.M{"roomCode": roomCode})
		if err != nil {
			return nil, err
		}
		defer cursor.Close(ctx)

		var reactions []models.Reaction
		if err := cursor.All(ctx, &reactions); err != nil {
			return nil, err
		}
		return reactions, nil
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	var matching []models.Reaction
	for _, reaction := range r.reactions {
		if strings.EqualFold(reaction.RoomCode, roomCode) {
			matching = append(matching, reaction)
		}
	}
	return matching, nil
}
