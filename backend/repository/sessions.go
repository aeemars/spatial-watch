package repository

import (
	"context"
	"errors"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"spatialwatch/models"
)

var (
	ErrSessionNotFound = errors.New("session not found")
	ErrSessionExpired  = errors.New("session expired")
)

// SessionRepository defines persistence operations for authenticated sessions
type SessionRepository interface {
	Create(ctx context.Context, session models.Session) error
	FindByTokenHash(ctx context.Context, tokenHash string) (*models.Session, error)
	Refresh(ctx context.Context, tokenHash string, expiresAt, lastSeenAt time.Time) error
	DeleteByTokenHash(ctx context.Context, tokenHash string) error
}

// NewSessionRepo returns a SessionRepository backed by MongoDB if db is non-nil, or in-memory otherwise
func NewSessionRepo(db *mongo.Database) SessionRepository {
	if db != nil {
		col := db.Collection("sessions")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		// Unique index on tokenHash
		col.Indexes().CreateOne(ctx, mongo.IndexModel{
			Keys:    bson.D{{Key: "tokenHash", Value: 1}},
			Options: options.Index().SetUnique(true),
		})
		// Index on userId for user session lookups
		col.Indexes().CreateOne(ctx, mongo.IndexModel{
			Keys: bson.D{{Key: "userId", Value: 1}},
		})
		// TTL index on expiresAt (automatic MongoDB expiration)
		col.Indexes().CreateOne(ctx, mongo.IndexModel{
			Keys:    bson.D{{Key: "expiresAt", Value: 1}},
			Options: options.Index().SetExpireAfterSeconds(0),
		})

		return &MongoSessionRepo{col: col}
	}
	return &MemorySessionRepo{
		sessions: make(map[string]*models.Session),
	}
}

// ─── MongoDB Implementation ──────────────────────────────────────

type MongoSessionRepo struct {
	col *mongo.Collection
}

func (r *MongoSessionRepo) Create(ctx context.Context, session models.Session) error {
	_, err := r.col.InsertOne(ctx, session)
	return err
}

func (r *MongoSessionRepo) FindByTokenHash(ctx context.Context, tokenHash string) (*models.Session, error) {
	var session models.Session
	err := r.col.FindOne(ctx, bson.M{"tokenHash": tokenHash}).Decode(&session)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, ErrSessionNotFound
		}
		return nil, err
	}
	if time.Now().After(session.ExpiresAt) {
		return nil, ErrSessionExpired
	}
	return &session, nil
}

func (r *MongoSessionRepo) Refresh(ctx context.Context, tokenHash string, expiresAt, lastSeenAt time.Time) error {
	_, err := r.col.UpdateOne(ctx,
		bson.M{"tokenHash": tokenHash},
		bson.M{"$set": bson.M{
			"expiresAt":  expiresAt,
			"lastSeenAt": lastSeenAt,
		}},
	)
	return err
}

func (r *MongoSessionRepo) DeleteByTokenHash(ctx context.Context, tokenHash string) error {
	_, err := r.col.DeleteOne(ctx, bson.M{"tokenHash": tokenHash})
	return err
}

// ─── In-Memory Implementation ────────────────────────────────────

type MemorySessionRepo struct {
	mu       sync.RWMutex
	sessions map[string]*models.Session
}

func (r *MemorySessionRepo) Create(ctx context.Context, session models.Session) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	copy := session
	r.sessions[session.TokenHash] = &copy
	return nil
}

func (r *MemorySessionRepo) FindByTokenHash(ctx context.Context, tokenHash string) (*models.Session, error) {
	r.mu.RLock()
	session, ok := r.sessions[tokenHash]
	r.mu.RUnlock()

	if !ok {
		return nil, ErrSessionNotFound
	}

	if time.Now().After(session.ExpiresAt) {
		// Clean up expired session
		r.mu.Lock()
		delete(r.sessions, tokenHash)
		r.mu.Unlock()
		return nil, ErrSessionExpired
	}

	copy := *session
	return &copy, nil
}

func (r *MemorySessionRepo) Refresh(ctx context.Context, tokenHash string, expiresAt, lastSeenAt time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if session, ok := r.sessions[tokenHash]; ok {
		session.ExpiresAt = expiresAt
		session.LastSeenAt = lastSeenAt
	}
	return nil
}

func (r *MemorySessionRepo) DeleteByTokenHash(ctx context.Context, tokenHash string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessions, tokenHash)
	return nil
}
