package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/mux"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readpref"

	"spatialwatch/config"
	"spatialwatch/handlers"
	"spatialwatch/internal/auth"
	"spatialwatch/repository"
	"spatialwatch/seed"
	ws "spatialwatch/websocket"
)

func main() {
	cfg := config.Load()

	log.Println("Spatial Watch — starting up")
	log.Printf("  Port: %d", cfg.Port)
	log.Printf("  Database: %s", cfg.DatabaseName)

	// Attempt MongoDB connection with v2 driver (10s ping timeout, fallback to in-memory store)
	var db *mongo.Database
	if cfg.MongoURI != "" && !strings.Contains(cfg.MongoURI, "<user>") {
		log.Println("  Connecting to MongoDB...")
		clientOpts := options.Client().
			ApplyURI(cfg.MongoURI).
			SetServerSelectionTimeout(10 * time.Second)

		mongoClient, err := mongo.Connect(clientOpts)
		if err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := mongoClient.Ping(ctx, readpref.Primary()); err == nil {
				log.Println("  MongoDB connected successfully (Driver v2)")
				db = mongoClient.Database(cfg.DatabaseName)
				defer func() {
					if err := mongoClient.Disconnect(context.Background()); err != nil {
						log.Printf("MongoDB disconnect error: %v", err)
					}
				}()
			} else {
				log.Printf("MongoDB ping failed: %v", err)
				log.Println("  -> Tip: If using MongoDB Atlas, check your IP whitelist (Network Access -> Add IP Address) and credentials.")
				log.Println("  -> Falling back to in-memory store")
			}
			cancel()
		} else {
			log.Printf("MongoDB connect error: %v — falling back to in-memory store", err)
		}
	}

	if db == nil {
		log.Println("  Persistence: In-memory store (active & standalone ready)")
	} else {
		log.Printf("  Persistence: MongoDB (%s)", cfg.DatabaseName)
	}

	// Initialize repositories (handles both MongoDB and in-memory gracefully)
	roomRepo := repository.NewRoomRepo(db)
	partRepo := repository.NewParticipantRepo(db)
	commentRepo := repository.NewCommentaryRepo(db)
	reactionRepo := repository.NewReactionRepo(db)
	userRepo := repository.NewUserRepo(db)
	sessionRepo := repository.NewSessionRepo(db)

	// Initialize auth service
	authService := auth.NewAuthService(userRepo, sessionRepo, cfg)

	// Seed default data
	seed.Run(commentRepo)

	// Initialize WebSocket hub
	hub := ws.NewHub(roomRepo, partRepo, reactionRepo)

	// Initialize handlers
	handler := handlers.NewHandler(roomRepo, partRepo, commentRepo, reactionRepo, hub, authService, cfg.CORSAllowedOrigins)

	// Set up router
	r := mux.NewRouter()

	// Apply CORS middleware to all routes
	r.Use(corsMiddleware(cfg.CORSAllowedOrigins))

	// API routes
	api := r.PathPrefix("/api").Subrouter()

	// Public auth endpoints
	api.HandleFunc("/auth/session", handler.GetSession).Methods("GET", "OPTIONS")
	api.HandleFunc("/auth/logout", handler.Logout).Methods("POST", "OPTIONS")

	// Protected routes (require active session)
	protected := api.PathPrefix("").Subrouter()
	protected.Use(auth.Middleware(authService))
	protected.HandleFunc("/auth/profile", handler.UpdateProfile).Methods("PATCH", "OPTIONS")
	protected.HandleFunc("/rooms", handler.CreateRoom).Methods("POST", "OPTIONS")
	protected.HandleFunc("/rooms/join", handler.JoinRoom).Methods("POST", "OPTIONS")

	// Public room info and commentary
	api.HandleFunc("/rooms/{roomCode}", handler.GetRoom).Methods("GET", "OPTIONS")
	api.HandleFunc("/rooms/{roomCode}/commentary", handler.GetCommentary).Methods("GET", "OPTIONS")
	api.HandleFunc("/health", handler.Health).Methods("GET", "OPTIONS")

	// Health at root level too
	r.HandleFunc("/health", handler.Health).Methods("GET", "OPTIONS")

	// WebSocket (authenticated inside handler via sw_session cookie)
	r.HandleFunc("/ws", handler.HandleWebSocket).Methods("GET")

	// Static files — serve the frontend
	frontendDir := filepath.Join("..", "frontend")
	if _, err := os.Stat(frontendDir); os.IsNotExist(err) {
		frontendDir = "frontend"
	}
	r.PathPrefix("/").Handler(http.FileServer(http.Dir(frontendDir)))

	// Create server
	srv := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan

		log.Println("Shutting down gracefully...")
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		srv.Shutdown(shutdownCtx)
	}()

	log.Printf("Spatial Watch listening on :%d", cfg.Port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}

// corsMiddleware enforces explicit origin matching for credentialed requests
func corsMiddleware(allowedOrigins []string) mux.MiddlewareFunc {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" {
				allowed := false
				for _, o := range allowedOrigins {
					if strings.EqualFold(origin, o) {
						allowed = true
						break
					}
				}
				// In development (when no explicit CORS origins are configured),
				// permit localhost and 127.0.0.1 for local dual-port dev
				if !allowed && len(allowedOrigins) == 0 {
					if strings.HasPrefix(origin, "http://localhost:") ||
						strings.HasPrefix(origin, "http://127.0.0.1:") ||
						strings.HasPrefix(origin, "https://localhost:") {
						allowed = true
					}
				}

				if allowed {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Access-Control-Allow-Credentials", "true")
					w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
					w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Cookie")
				}
			}

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
