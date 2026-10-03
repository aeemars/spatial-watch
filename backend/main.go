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
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"go.mongodb.org/mongo-driver/mongo/readpref"

	"spatialwatch/config"
	"spatialwatch/handlers"
	"spatialwatch/repository"
	"spatialwatch/seed"
	ws "spatialwatch/websocket"
)

func main() {
	cfg := config.Load()

	log.Println("Spatial Watch — starting up")
	log.Printf("  Port: %d", cfg.Port)
	log.Printf("  Database: %s", cfg.DatabaseName)

	// Attempt MongoDB connection with 2s timeout, fallback to in-memory store
	var db *mongo.Database
	if cfg.MongoURI != "" && !strings.Contains(cfg.MongoURI, "<user>") {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		clientOpts := options.Client().ApplyURI(cfg.MongoURI)
		mongoClient, err := mongo.Connect(ctx, clientOpts)
		if err == nil {
			if err := mongoClient.Ping(ctx, readpref.Primary()); err == nil {
				log.Println("  MongoDB connected successfully")
				db = mongoClient.Database(cfg.DatabaseName)
				defer func() {
					if err := mongoClient.Disconnect(context.Background()); err != nil {
						log.Printf("MongoDB disconnect error: %v", err)
					}
				}()
			} else {
				log.Printf("MongoDB ping: %v — falling back to in-memory store", err)
			}
		} else {
			log.Printf("MongoDB connect error: %v — falling back to in-memory store", err)
		}
		cancel()
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

	// Seed default data
	seed.Run(commentRepo)

	// Initialize WebSocket hub
	hub := ws.NewHub(roomRepo, partRepo, reactionRepo)

	// Initialize handlers
	handler := handlers.NewHandler(roomRepo, partRepo, commentRepo, reactionRepo, hub)

	// Set up router
	r := mux.NewRouter()

	// API routes
	api := r.PathPrefix("/api").Subrouter()
	api.HandleFunc("/rooms", handler.CreateRoom).Methods("POST")
	api.HandleFunc("/rooms/join", handler.JoinRoom).Methods("POST")
	api.HandleFunc("/rooms/{roomCode}", handler.GetRoom).Methods("GET")
	api.HandleFunc("/rooms/{roomCode}/commentary", handler.GetCommentary).Methods("GET")
	api.HandleFunc("/health", handler.Health).Methods("GET")

	// Health at root level too
	r.HandleFunc("/health", handler.Health).Methods("GET")

	// WebSocket
	r.HandleFunc("/ws", handler.HandleWebSocket).Methods("GET")

	// Static files — serve the frontend
	frontendDir := filepath.Join("..", "frontend")
	if _, err := os.Stat(frontendDir); os.IsNotExist(err) {
		frontendDir = "frontend"
	}
	r.PathPrefix("/").Handler(http.FileServer(http.Dir(frontendDir)))

	// CORS middleware
	corsRouter := corsMiddleware(r)

	// Create server
	srv := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      corsRouter,
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

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}
