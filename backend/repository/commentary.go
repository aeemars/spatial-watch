package repository

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"spatialwatch/models"
)

// CommentaryRepo handles commentary cue persistence
type CommentaryRepo struct {
	col  *mongo.Collection
	mu   sync.RWMutex
	cues []models.CommentaryCue
}

// NewCommentaryRepo creates a new commentary repository
func NewCommentaryRepo(db *mongo.Database) *CommentaryRepo {
	repo := &CommentaryRepo{
		cues: make([]models.CommentaryCue, 0),
	}
	if db != nil {
		col := db.Collection("commentaryCues")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		// Index on roomCode + timestampSeconds for ordered retrieval
		col.Indexes().CreateOne(ctx, mongo.IndexModel{
			Keys: bson.D{
				{Key: "roomCode", Value: 1},
				{Key: "timestampSeconds", Value: 1},
			},
		})
		// Index on templateRef for seed data
		col.Indexes().CreateOne(ctx, mongo.IndexModel{
			Keys: bson.D{{Key: "templateRef", Value: 1}},
		})
		repo.col = col
	}
	return repo
}

// FindByRoom retrieves commentary cues for a room, ordered by timestamp
func (r *CommentaryRepo) FindByRoom(ctx context.Context, roomCode string) ([]models.CommentaryCue, error) {
	if r.col != nil {
		opts := options.Find().SetSort(bson.D{{Key: "timestampSeconds", Value: 1}})
		cursor, err := r.col.Find(ctx, bson.M{
			"$or": []bson.M{
				{"roomCode": roomCode},
				{"templateRef": "default"},
			},
		}, opts)
		if err != nil {
			return nil, err
		}
		defer cursor.Close(ctx)

		var cues []models.CommentaryCue
		if err := cursor.All(ctx, &cues); err != nil {
			return nil, err
		}
		return cues, nil
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	var matching []models.CommentaryCue
	for _, c := range r.cues {
		if strings.EqualFold(c.RoomCode, roomCode) || c.TemplateRef == "default" {
			matching = append(matching, c)
		}
	}
	sort.Slice(matching, func(i, j int) bool {
		return matching[i].TimestampSeconds < matching[j].TimestampSeconds
	})
	return matching, nil
}

// InsertMany adds multiple commentary cues
func (r *CommentaryRepo) InsertMany(ctx context.Context, cues []models.CommentaryCue) error {
	if r.col != nil {
		docs := make([]interface{}, len(cues))
		for i, c := range cues {
			docs[i] = c
		}
		_, err := r.col.InsertMany(ctx, docs)
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	r.cues = append(r.cues, cues...)
	return nil
}

// Count returns the number of cues matching a filter
func (r *CommentaryRepo) Count(ctx context.Context, filter bson.M) (int64, error) {
	if r.col != nil {
		return r.col.CountDocuments(ctx, filter)
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	if tmpl, ok := filter["templateRef"].(string); ok {
		var cnt int64
		for _, c := range r.cues {
			if c.TemplateRef == tmpl {
				cnt++
			}
		}
		return cnt, nil
	}
	return int64(len(r.cues)), nil
}
