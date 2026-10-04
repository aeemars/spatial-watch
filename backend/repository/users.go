package repository

import (
	"context"
	"errors"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"spatialwatch/models"
)

var (
	ErrUserNotFound = errors.New("user not found")
)

// UserRepository defines persistence operations for users
type UserRepository interface {
	Create(ctx context.Context, user models.User) error
	FindByID(ctx context.Context, id string) (*models.User, error)
	UpdateDisplayName(ctx context.Context, id, displayName string) (*models.User, error)
	TouchLastSeen(ctx context.Context, id string, now time.Time) error
}

// NewUserRepo returns a UserRepository backed by MongoDB if db is non-nil, or in-memory otherwise
func NewUserRepo(db *mongo.Database) UserRepository {
	if db != nil {
		col := db.Collection("users")
		return &MongoUserRepo{col: col}
	}
	return &MemoryUserRepo{
		users: make(map[string]*models.User),
	}
}

// ─── MongoDB Implementation ──────────────────────────────────────

type MongoUserRepo struct {
	col *mongo.Collection
}

func (r *MongoUserRepo) Create(ctx context.Context, user models.User) error {
	_, err := r.col.InsertOne(ctx, user)
	return err
}

func (r *MongoUserRepo) FindByID(ctx context.Context, id string) (*models.User, error) {
	var user models.User
	err := r.col.FindOne(ctx, bson.M{"_id": id}).Decode(&user)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrUserNotFound
		}
		return nil, err
	}
	return &user, nil
}

func (r *MongoUserRepo) UpdateDisplayName(ctx context.Context, id, displayName string) (*models.User, error) {
	now := time.Now()
	_, err := r.col.UpdateOne(ctx,
		bson.M{"_id": id},
		bson.M{"$set": bson.M{
			"displayName": displayName,
			"lastSeenAt":  now,
		}},
	)
	if err != nil {
		return nil, err
	}
	return r.FindByID(ctx, id)
}

func (r *MongoUserRepo) TouchLastSeen(ctx context.Context, id string, now time.Time) error {
	_, err := r.col.UpdateOne(ctx,
		bson.M{"_id": id},
		bson.M{"$set": bson.M{
			"lastSeenAt": now,
		}},
	)
	return err
}

// ─── In-Memory Implementation ────────────────────────────────────

type MemoryUserRepo struct {
	mu    sync.RWMutex
	users map[string]*models.User
}

func (r *MemoryUserRepo) Create(ctx context.Context, user models.User) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	copy := user
	r.users[user.ID] = &copy
	return nil
}

func (r *MemoryUserRepo) FindByID(ctx context.Context, id string) (*models.User, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	user, ok := r.users[id]
	if !ok {
		return nil, ErrUserNotFound
	}
	copy := *user
	return &copy, nil
}

func (r *MemoryUserRepo) UpdateDisplayName(ctx context.Context, id, displayName string) (*models.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	user, ok := r.users[id]
	if !ok {
		return nil, ErrUserNotFound
	}
	user.DisplayName = displayName
	user.LastSeenAt = time.Now()
	copy := *user
	return &copy, nil
}

func (r *MemoryUserRepo) TouchLastSeen(ctx context.Context, id string, now time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if user, ok := r.users[id]; ok {
		user.LastSeenAt = now
	}
	return nil
}
