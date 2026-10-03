package config

import (
	"log"
	"os"
	"strconv"

	"github.com/joho/godotenv"
)

// Config holds all application configuration
type Config struct {
	Port          int
	MongoURI      string
	DatabaseName  string
	PublicBaseURL string
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

	return &Config{
		Port:          port,
		MongoURI:      getEnv("MONGODB_URI", "mongodb://localhost:27017"),
		DatabaseName:  getEnv("DATABASE_NAME", "spatialwatch"),
		PublicBaseURL: getEnv("PUBLIC_BASE_URL", "http://localhost:8080"),
	}
}

func getEnv(key, fallback string) string {
	if val, ok := os.LookupEnv(key); ok {
		return val
	}
	return fallback
}
