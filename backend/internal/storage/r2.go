package storage

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"spatialwatch/config"
)

// PresignResult contains the pre-signed direct upload and public streaming URLs
type PresignResult struct {
	UploadURL        string `json:"uploadUrl"`
	StreamURL        string `json:"streamUrl"`
	Key              string `json:"key"`
	ExpiresInSeconds int64  `json:"expiresInSeconds"`
}

// StorageService defines the interface for object storage operations
type StorageService interface {
	PresignPut(ctx context.Context, key string, contentType string, contentLength int64, lifetime time.Duration) (*PresignResult, error)
	GetStreamURL(key string) string
	IsConfigured() bool
}

// R2Storage implements StorageService using Cloudflare R2 via AWS S3 SDK v2
type R2Storage struct {
	presignClient *s3.PresignClient
	bucket        string
	accountID     string
	publicURL     string
	publicBaseURL string
	isConfigured  bool
}

// NewR2Storage creates a new Cloudflare R2 storage service. If R2 credentials are not
// provided, it falls back to a development simulation mode.
func NewR2Storage(appCfg *config.Config) (*R2Storage, error) {
	if !appCfg.IsR2Configured() {
		return &R2Storage{
			bucket:        appCfg.R2BucketName,
			publicURL:     appCfg.R2PublicURL,
			publicBaseURL: appCfg.PublicBaseURL,
			isConfigured:  false,
		}, nil
	}

	endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com", appCfg.R2AccountID)

	customResolver := aws.EndpointResolverWithOptionsFunc(func(service, region string, options ...interface{}) (aws.Endpoint, error) {
		return aws.Endpoint{
			URL:               endpoint,
			SigningRegion:     "auto",
			HostnameImmutable: true,
		}, nil
	})

	cfg, err := awsconfig.LoadDefaultConfig(
		context.Background(),
		awsconfig.WithRegion("auto"),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			appCfg.R2AccessKeyID,
			appCfg.R2SecretAccessKey,
			"",
		)),
		awsconfig.WithEndpointResolverWithOptions(customResolver),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config for R2: %w", err)
	}

	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(endpoint)
		o.Region = "auto"
	})

	presignClient := s3.NewPresignClient(s3Client)

	return &R2Storage{
		presignClient: presignClient,
		bucket:        appCfg.R2BucketName,
		accountID:     appCfg.R2AccountID,
		publicURL:     appCfg.R2PublicURL,
		publicBaseURL: appCfg.PublicBaseURL,
		isConfigured:  true,
	}, nil
}

// IsConfigured returns true if live Cloudflare R2 credentials are active
func (s *R2Storage) IsConfigured() bool {
	return s.isConfigured
}

// GetStreamURL constructs the public, CORS-enabled streaming URL for the uploaded key
func (s *R2Storage) GetStreamURL(key string) string {
	if s.publicURL != "" {
		return fmt.Sprintf("%s/%s", strings.TrimRight(s.publicURL, "/"), key)
	}
	if s.isConfigured {
		return fmt.Sprintf("https://%s.r2.cloudflarestorage.com/%s/%s", s.accountID, s.bucket, key)
	}
	// Dev fallback
	return fmt.Sprintf("%s/assets/uploads/%s", strings.TrimRight(s.publicBaseURL, "/"), key)
}

// PresignPut generates a presigned URL allowing the browser to directly PUT the file into R2
func (s *R2Storage) PresignPut(ctx context.Context, key string, contentType string, contentLength int64, lifetime time.Duration) (*PresignResult, error) {
	if lifetime <= 0 {
		lifetime = 15 * time.Minute
	}

	streamURL := s.GetStreamURL(key)
	expiresSeconds := int64(lifetime.Seconds())

	// In dev/mock mode without active R2 credentials, produce a valid simulated presign payload
	if !s.isConfigured || s.presignClient == nil {
		mockUploadURL := fmt.Sprintf("%s/api/media/mock-upload/%s?expires=%d", strings.TrimRight(s.publicBaseURL, "/"), key, time.Now().Add(lifetime).Unix())
		return &PresignResult{
			UploadURL:        mockUploadURL,
			StreamURL:        streamURL,
			Key:              key,
			ExpiresInSeconds: expiresSeconds,
		}, nil
	}

	putInput := &s3.PutObjectInput{
		Bucket:        aws.String(s.bucket),
		Key:           aws.String(key),
		ContentType:   aws.String(contentType),
		ContentLength: aws.Int64(contentLength),
	}

	presignedReq, err := s.presignClient.PresignPutObject(ctx, putInput, s3.WithPresignExpires(lifetime))
	if err != nil {
		return nil, fmt.Errorf("failed to presign R2 PUT request: %w", err)
	}

	return &PresignResult{
		UploadURL:        presignedReq.URL,
		StreamURL:        streamURL,
		Key:              key,
		ExpiresInSeconds: expiresSeconds,
	}, nil
}
