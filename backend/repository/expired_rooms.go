package repository

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"spatialwatch/models"
)

// ExpiredRoomRepo handles persistence for concluded / expired room archives
type ExpiredRoomRepo struct {
	col    *mongo.Collection
	mu     sync.RWMutex
	memory map[string]*models.ExpiredRoom
}

// NewExpiredRoomRepo creates a repository for expired room archives
func NewExpiredRoomRepo(db *mongo.Database) *ExpiredRoomRepo {
	repo := &ExpiredRoomRepo{
		memory: make(map[string]*models.ExpiredRoom),
	}
	if db != nil {
		col := db.Collection("expiredRooms")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		// Index on roomCode
		col.Indexes().CreateOne(ctx, mongo.IndexModel{
			Keys: bson.D{{Key: "roomCode", Value: 1}},
		})
		// Compound index for host lookup sorted by conclusion time
		col.Indexes().CreateOne(ctx, mongo.IndexModel{
			Keys: bson.D{{Key: "hostParticipantId", Value: 1}, {Key: "concludedAt", Value: -1}},
		})
		repo.col = col
	}
	return repo
}

// Archive inserts a concluded/expired room record
func (r *ExpiredRoomRepo) Archive(ctx context.Context, expired *models.ExpiredRoom) error {
	if expired.ConcludedAt.IsZero() {
		expired.ConcludedAt = time.Now()
	}
	upperCode := strings.ToUpper(strings.TrimSpace(expired.RoomCode))

	if r.col != nil {
		opts := options.UpdateOne().SetUpsert(true)
		_, err := r.col.UpdateOne(ctx, bson.M{"roomCode": upperCode}, bson.M{"$set": expired}, opts)
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	copy := *expired
	copy.RoomCode = upperCode
	r.memory[upperCode] = &copy
	return nil
}

// FindByHost returns all archived rooms hosted by the participant, ordered newest first
func (r *ExpiredRoomRepo) FindByHost(ctx context.Context, hostParticipantID string) ([]models.ExpiredRoom, error) {
	if r.col != nil {
		opts := options.Find().SetSort(bson.D{{Key: "concludedAt", Value: -1}})
		filter := bson.M{"hostParticipantId": hostParticipantID}
		cursor, err := r.col.Find(ctx, filter, opts)
		if err != nil {
			return nil, err
		}
		defer cursor.Close(ctx)

		var rooms []models.ExpiredRoom
		if err := cursor.All(ctx, &rooms); err != nil {
			return nil, err
		}
		return rooms, nil
	}

	r.mu.RLock()
	defer r.mu.RUnlock()
	var rooms []models.ExpiredRoom
	for _, room := range r.memory {
		if room.HostParticipantID == hostParticipantID {
			rooms = append(rooms, *room)
		}
	}
	sort.Slice(rooms, func(i, j int) bool {
		return rooms[i].ConcludedAt.After(rooms[j].ConcludedAt)
	})
	return rooms, nil
}

// FindByCodes returns archived rooms matching the provided codes
func (r *ExpiredRoomRepo) FindByCodes(ctx context.Context, codes []string) ([]models.ExpiredRoom, error) {
	if len(codes) == 0 {
		return []models.ExpiredRoom{}, nil
	}

	upperCodes := make([]string, len(codes))
	for i, c := range codes {
		upperCodes[i] = strings.ToUpper(c)
	}

	if r.col != nil {
		opts := options.Find().SetSort(bson.D{{Key: "concludedAt", Value: -1}})
		filter := bson.M{"roomCode": bson.M{"$in": upperCodes}}
		cursor, err := r.col.Find(ctx, filter, opts)
		if err != nil {
			return nil, err
		}
		defer cursor.Close(ctx)

		var rooms []models.ExpiredRoom
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

	var rooms []models.ExpiredRoom
	for _, room := range r.memory {
		if codeSet[strings.ToUpper(room.RoomCode)] {
			rooms = append(rooms, *room)
		}
	}
	sort.Slice(rooms, func(i, j int) bool {
		return rooms[i].ConcludedAt.After(rooms[j].ConcludedAt)
	})
	return rooms, nil
}
