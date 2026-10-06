package config

import (
	"log"
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

// Config holds all application configuration
type Config struct {
	Port                int
	MongoURI            string
	DatabaseName        string
	PublicBaseURL       string
	CookieSecure        bool
	CookieDomain        string
	CORSAllowedOrigins  []string
	SessionDurationDays int
	// Cloudflare R2 Object Storage
	R2AccountID       string
	R2AccessKeyID     string
	R2SecretAccessKey string
	R2BucketName      string
	R2PublicURL       string
}

// IsR2Configured returns true if all necessary credentials for R2 are present
func (c *Config) IsR2Configured() bool {
	return c.R2AccountID != "" && c.R2AccessKeyID != "" && c.R2SecretAccessKey != "" && c.R2BucketName != ""
}

// Load reads configuration from environment variables
func Load() *Config {
	// Attempt to load .env file (non-fatal if missing)
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, using environment variables")
	}

	port, err := strconv.Atoi(getEnv("PORT", "8080"))
	if err != nil {
		port = 8080
	}

	sessionDuration, err := strconv.Atoi(getEnv("SESSION_DURATION_DAYS", "30"))
	if err != nil || sessionDuration <= 0 {
		sessionDuration = 30
	}

	cookieSecure := false
	if val, ok := os.LookupEnv("COOKIE_SECURE"); ok {
		cookieSecure = strings.EqualFold(val, "true") || val == "1"
	} else {
		// By default in dev (plain HTTP on localhost), Secure is false so cookies work locally.
		// If PUBLIC_BASE_URL starts with https://, default to true.
		publicURL := getEnv("PUBLIC_BASE_URL", "")
		if strings.HasPrefix(strings.ToLower(publicURL), "https://") {
			cookieSecure = true
		}
	}

	// Safety safeguard for local development: if PUBLIC_BASE_URL is plain http://localhost or http://127.0.0.1,
	// do not force Secure=true as local browsers will discard the cookie over non-TLS connections.
	publicURL := getEnv("PUBLIC_BASE_URL", "")
	if strings.HasPrefix(strings.ToLower(publicURL), "http://localhost") || strings.HasPrefix(strings.ToLower(publicURL), "http://127.0.0.1") {
		cookieSecure = false
	}

	var corsOrigins []string
	if rawCORS := getEnv("CORS_ALLOWED_ORIGINS", ""); rawCORS != "" {
		for _, o := range strings.Split(rawCORS, ",") {
			trimmed := strings.TrimSpace(o)
			if trimmed != "" {
				corsOrigins = append(corsOrigins, trimmed)
			}
		}
	}

	return &Config{
		Port:                port,
		MongoURI:            getEnv("MONGODB_URI", "mongodb://localhost:27017"),
		DatabaseName:        getEnv("DATABASE_NAME", "spatialwatch"),
		PublicBaseURL:       getEnv("PUBLIC_BASE_URL", "http://localhost:8080"),
		CookieSecure:        cookieSecure,
		CookieDomain:        getEnv("COOKIE_DOMAIN", ""),
		CORSAllowedOrigins:  corsOrigins,
		SessionDurationDays: sessionDuration,
		R2AccountID:         getEnv("R2_ACCOUNT_ID", ""),
		R2AccessKeyID:       getEnv("R2_ACCESS_KEY_ID", ""),
		R2SecretAccessKey:   getEnv("R2_SECRET_ACCESS_KEY", ""),
		R2BucketName:        getEnv("R2_BUCKET_NAME", "spatialwatch-media"),
		R2PublicURL:         getEnv("R2_PUBLIC_URL", ""),
	}
}

func getEnv(key, fallback string) string {
	if val, ok := os.LookupEnv(key); ok {
		return val
	}
	return fallback
}
