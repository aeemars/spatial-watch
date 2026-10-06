package repository

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"spatialwatch/models"
)

var (
	ErrMediaAssetNotFound = errors.New("media asset not found")
)

// MediaAssetRepo handles media catalog persistence
type MediaAssetRepo struct {
	col    *mongo.Collection
	mu     sync.RWMutex
	assets map[string]*models.MediaAsset
}

// NewMediaAssetRepo creates a new media asset repository
func NewMediaAssetRepo(db *mongo.Database) *MediaAssetRepo {
	repo := &MediaAssetRepo{
		assets: make(map[string]*models.MediaAsset),
	}
	if db != nil {
		col := db.Collection("mediaAssets")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		// Unique index on assetId
		col.Indexes().CreateOne(ctx, mongo.IndexModel{
			Keys:    bson.D{{Key: "assetId", Value: 1}},
			Options: options.Index().SetUnique(true),
		})
		repo.col = col
	}
	return repo
}

// FindAll returns all catalog assets, ordered by title
func (r *MediaAssetRepo) FindAll(ctx context.Context) ([]models.MediaAsset, error) {
	if r.col != nil {
		opts := options.Find().SetSort(bson.D{{Key: "title", Value: 1}})
		cursor, err := r.col.Find(ctx, bson.M{}, opts)
		if err != nil {
			return nil, err
		}
		defer cursor.Close(ctx)

		var assets []models.MediaAsset
		if err := cursor.All(ctx, &assets); err != nil {
			return nil, err
		}
		return assets, nil
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	assets := make([]models.MediaAsset, 0, len(r.assets))
	for _, a := range r.assets {
		assets = append(assets, *a)
	}
	sort.Slice(assets, func(i, j int) bool {
		return assets[i].Title < assets[j].Title
	})
	return assets, nil
}

// FindByAssetID retrieves a media asset by its stable assetId
func (r *MediaAssetRepo) FindByAssetID(ctx context.Context, assetID string) (*models.MediaAsset, error) {
	cleanID := strings.TrimSpace(strings.ToLower(assetID))
	if cleanID == "" {
		return nil, ErrMediaAssetNotFound
	}

	if r.col != nil {
		var asset models.MediaAsset
		err := r.col.FindOne(ctx, bson.M{"assetId": cleanID}).Decode(&asset)
		if err != nil {
			if errors.Is(err, mongo.ErrNoDocuments) {
				return nil, ErrMediaAssetNotFound
			}
			return nil, err
		}
		return &asset, nil
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, a := range r.assets {
		if strings.EqualFold(a.AssetID, cleanID) {
			copy := *a
			return &copy, nil
		}
	}
	return nil, ErrMediaAssetNotFound
}

// InsertMany inserts multiple media assets (used for idempotent seeding)
func (r *MediaAssetRepo) InsertMany(ctx context.Context, assets []models.MediaAsset) error {
	now := time.Now()
	if r.col != nil {
		docs := make([]interface{}, len(assets))
		for i, a := range assets {
			if a.CreatedAt.IsZero() {
				a.CreatedAt = now
			}
			docs[i] = a
		}
		_, err := r.col.InsertMany(ctx, docs)
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	for _, a := range assets {
		if a.CreatedAt.IsZero() {
			a.CreatedAt = now
		}
		copy := a
		r.assets[strings.ToLower(a.AssetID)] = &copy
	}
	return nil
}

// Count returns the number of media assets matching a filter
func (r *MediaAssetRepo) Count(ctx context.Context, filter bson.M) (int64, error) {
	if r.col != nil {
		return r.col.CountDocuments(ctx, filter)
	}

	r.mu.RLock()
	defer r.mu.RUnlock()
	return int64(len(r.assets)), nil
}

// Upsert inserts or updates a media asset matching its assetId
func (r *MediaAssetRepo) Upsert(ctx context.Context, asset *models.MediaAsset) error {
	cleanID := strings.TrimSpace(strings.ToLower(asset.AssetID))
	if cleanID == "" {
		return errors.New("empty asset ID")
	}
	now := time.Now()
	if asset.CreatedAt.IsZero() {
		asset.CreatedAt = now
	}

	if r.col != nil {
		opts := options.UpdateOne().SetUpsert(true)
		update := bson.M{
			"$set": bson.M{
				"title":                 asset.Title,
				"description":           asset.Description,
				"durationSeconds":       asset.DurationSeconds,
				"posterUrl":             asset.PosterURL,
				"gradient":              asset.Gradient,
				"mediaUrl":              asset.MediaURL,
				"corsReady":             asset.CORSReady,
				"directorCutAvailable":  asset.DirectorCutAvailable,
				"commentaryTemplateRef": asset.CommentaryTemplateRef,
			},
			"$setOnInsert": bson.M{
				"assetId":   cleanID,
				"createdAt": asset.CreatedAt,
			},
		}
		_, err := r.col.UpdateOne(ctx, bson.M{"assetId": cleanID}, update, opts)
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	copy := *asset
	r.assets[cleanID] = &copy
	return nil
}

