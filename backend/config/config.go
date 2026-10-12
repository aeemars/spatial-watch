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
	CookieSameSite      string
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
	// Attempt to load .env file from current dir or parent dir (non-fatal if missing)
	if err := godotenv.Load(".env"); err != nil {
		if err2 := godotenv.Load("../.env"); err2 != nil {
			log.Println("No .env file found, using environment variables")
		}
	}

	port, err := strconv.Atoi(getEnv("PORT", "8080"))
	if err != nil {
		port = 8080
	}

	sessionDuration, err := strconv.Atoi(getEnv("SESSION_DURATION_DAYS", "30"))
	if err != nil || sessionDuration <= 0 {
		sessionDuration = 30
	}

	cookieSameSite := strings.ToLower(strings.TrimSpace(getEnv("COOKIE_SAMESITE", "")))
	if cookieSameSite == "" {
		// When PUBLIC_BASE_URL is HTTPS (e.g. cloud deployment like Pxxl), default to "none"
		// so cross-site requests from Cloudflare Workers/Pages retain authenticated session cookies.
		publicURL := getEnv("PUBLIC_BASE_URL", "")
		if strings.HasPrefix(strings.ToLower(publicURL), "https://") {
			cookieSameSite = "none"
		} else {
			cookieSameSite = "lax"
		}
	} else if cookieSameSite != "none" && cookieSameSite != "strict" && cookieSameSite != "lax" {
		cookieSameSite = "lax"
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

	// RFC 6265bis mandates that SameSite=None cookies must be Secure
	if cookieSameSite == "none" {
		cookieSecure = true
	}

	// Safety safeguard for local development: if PUBLIC_BASE_URL is plain http://localhost or http://127.0.0.1,
	// and cookieSameSite is not "none", do not force Secure=true as local browsers will discard the cookie over non-TLS connections.
	publicURL := getEnv("PUBLIC_BASE_URL", "")
	if cookieSameSite != "none" && (strings.HasPrefix(strings.ToLower(publicURL), "http://localhost") || strings.HasPrefix(strings.ToLower(publicURL), "http://127.0.0.1")) {
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
	} else {
		// Cloudflare Workers and Pages defaults for frontend deployments
		corsOrigins = []string{
			"https://*.workers.dev",
			"https://*.pages.dev",
			"https://spatial-watch.aeemarrs.workers.dev",
		}
	}

	mongoURI := CleanMongoURI(getEnv("MONGODB_URI", ""))
	if mongoURI == "" {
		mongoURI = CleanMongoURI(getEnv("MONGO_URI", ""))
	}
	if mongoURI == "" {
		mongoURI = CleanMongoURI(getEnv("DATABASE_URL", ""))
	}
	if mongoURI == "" {
		mongoURI = "mongodb://localhost:27017"
	}

	return &Config{
		Port:                port,
		MongoURI:            mongoURI,
		DatabaseName:        getEnv("DATABASE_NAME", "spatialwatch"),
		PublicBaseURL:       getEnv("PUBLIC_BASE_URL", "http://localhost:8080"),
		CookieSecure:        cookieSecure,
		CookieDomain:        getEnv("COOKIE_DOMAIN", ""),
		CookieSameSite:      cookieSameSite,
		CORSAllowedOrigins:  corsOrigins,
		SessionDurationDays: sessionDuration,
		R2AccountID:         getEnv("R2_ACCOUNT_ID", ""),
		R2AccessKeyID:       getEnv("R2_ACCESS_KEY_ID", ""),
		R2SecretAccessKey:   getEnv("R2_SECRET_ACCESS_KEY", ""),
		R2BucketName:        getEnv("R2_BUCKET_NAME", "spatialwatch-media"),
		R2PublicURL:         getEnv("R2_PUBLIC_URL", ""),
	}
}

// CleanMongoURI strips accidental quotes, whitespace, and variable assignment prefixes from MongoDB connection strings
func CleanMongoURI(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = strings.Trim(raw, `"'`+"`")
	raw = strings.TrimSpace(raw)

	// If user accidentally pasted the whole variable line into their dashboard e.g. "MONGODB_URI=mongodb+srv://..."
	if idx := strings.Index(raw, "="); idx != -1 {
		prefix := strings.ToUpper(strings.TrimSpace(raw[:idx]))
		if strings.Contains(prefix, "MONGO") || strings.Contains(prefix, "URI") || strings.Contains(prefix, "URL") {
			raw = strings.TrimSpace(raw[idx+1:])
			raw = strings.Trim(raw, `"'`+"`")
			raw = strings.TrimSpace(raw)
		}
	}

	// Fix common missing colon typo e.g. "mongodb+srv//..." or "mongodb//"
	if strings.HasPrefix(raw, "mongodb+srv//") {
		raw = "mongodb+srv://" + raw[13:]
	} else if strings.HasPrefix(raw, "mongodb//") {
		raw = "mongodb://" + raw[9:]
	}

	return raw
}

// MaskMongoURI masks user credentials in a MongoDB URI for safe logging without leaking passwords
func MaskMongoURI(raw string) string {
	if raw == "" {
		return "(empty)"
	}
	schemeIdx := strings.Index(raw, "://")
	if schemeIdx == -1 {
		if len(raw) > 12 {
			return raw[:6] + "..." + raw[len(raw)-6:]
		}
		return raw
	}
	scheme := raw[:schemeIdx+3]
	rest := raw[schemeIdx+3:]
	atIdx := strings.LastIndex(rest, "@")
	if atIdx == -1 {
		return scheme + rest
	}
	userInfo := rest[:atIdx]
	hostAndRest := rest[atIdx:]
	colonIdx := strings.Index(userInfo, ":")
	if colonIdx == -1 {
		return scheme + userInfo + hostAndRest
	}
	return scheme + userInfo[:colonIdx+1] + "******" + hostAndRest
}

func getEnv(key, fallback string) string {
	if val, ok := os.LookupEnv(key); ok {
		cleaned := strings.TrimSpace(val)
		cleaned = strings.Trim(cleaned, `"'`+"`")
		cleaned = strings.TrimSpace(cleaned)
		if cleaned != "" {
			return cleaned
		}
	}
	return fallback
}
