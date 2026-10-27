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
	"spatialwatch/internal/cache"
	"spatialwatch/internal/ratelimit"
	"spatialwatch/internal/storage"
	"spatialwatch/repository"
	"spatialwatch/seed"
	ws "spatialwatch/websocket"
)

func main() {
	cfg := config.Load()
	if cfg.DatabaseName == "" {
		cfg.DatabaseName = "spatialwatch"
	}

	log.Println("Spatial Watch — starting up")
	log.Printf("  Port: %d", cfg.Port)
	log.Printf("  Database: %s", cfg.DatabaseName)

	// Attempt MongoDB connection with v2 driver (10s ping timeout, fallback to in-memory store)
	var db *mongo.Database
	if cfg.MongoURI != "" && !config.IsValidMongoURI(cfg.MongoURI) {
		log.Printf("  WARNING: MONGODB_URI is set to %q which is not a valid connection string.", cfg.MongoURI)
		log.Println("  -> MongoDB connection strings must start with 'mongodb://' or 'mongodb+srv://'.")
		log.Printf("  -> If %q is your database name, set it in the DATABASE_NAME field instead.", cfg.MongoURI)
		log.Println("  -> Falling back to in-memory store until a valid MONGODB_URI is provided.")
	} else if cfg.MongoURI != "" && !strings.Contains(cfg.MongoURI, "<user>") {
		masked := config.MaskMongoURI(cfg.MongoURI)
		log.Printf("  Connecting to MongoDB (%s)...", masked)
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
				log.Println("  -> Tip: If using MongoDB Atlas, check your IP whitelist (Network Access -> Add IP Address 0.0.0.0/0) and credentials.")
				log.Println("  -> Falling back to in-memory store")
			}
			cancel()
		} else {
			log.Printf("MongoDB connect error: %v (target was: %s) — falling back to in-memory store", err, masked)
		}
	} else {
		log.Println("  MongoDB URI is missing or contains placeholder '<user>' — falling back to in-memory store")
	}

	if db == nil {
		log.Println("  Persistence: In-memory store (active & standalone ready)")
	} else {
		log.Printf("  Persistence: MongoDB (%s)", cfg.DatabaseName)
	}

	// Initialize repositories (handles both MongoDB and in-memory gracefully)
	roomRepo := repository.NewRoomRepo(db)
	expiredRoomRepo := repository.NewExpiredRoomRepo(db)
	partRepo := repository.NewParticipantRepo(db)
	commentRepo := repository.NewCommentaryRepo(db)
	reactionRepo := repository.NewReactionRepo(db)
	userRepo := repository.NewUserRepo(db)
	sessionRepo := repository.NewSessionRepo(db)
	mediaAssetRepo := repository.NewMediaAssetRepo(db)

	// Initialize auth service
	authService := auth.NewAuthService(userRepo, sessionRepo, cfg)

	// Seed default data
	seed.Run(commentRepo, mediaAssetRepo)

	// Initialize WebSocket hub
	hub := ws.NewHub(roomRepo, partRepo, reactionRepo)

	// Initialize handlers
	handler := handlers.NewHandler(roomRepo, partRepo, commentRepo, reactionRepo, hub, authService, mediaAssetRepo, cfg.CORSAllowedOrigins)
	handler.SetExpiredRoomRepo(expiredRoomRepo)

	// Initialize Cloudflare R2 object storage client
	r2Storage, err := storage.NewR2Storage(cfg)
	if err != nil {
		log.Printf("R2 storage initialization warning: %v", err)
	} else if r2Storage.IsConfigured() {
		log.Printf("  Storage: Cloudflare R2 active (bucket: %s)", cfg.R2BucketName)
	} else {
		log.Println("  Storage: Local development simulation mode")
	}
	handler.SetStorage(r2Storage)

	// Initialize in-memory rate limiter with anti-abuse rules
	limiter := ratelimit.NewDefaultLimiter()

	// Set up router
	r := mux.NewRouter()

	// CORS must be registered first so every response — including 429 rate-limit rejections,
	// 500 errors, and WebSocket handshake upgrades — carries Access-Control-Allow-Origin.
	// Browsers will otherwise silently convert any non-CORS response into "Failed to fetch".
	r.Use(corsMiddleware(cfg.CORSAllowedOrigins))
	r.Use(securityHeadersMiddleware(cfg.CookieSecure))
	r.Use(cache.Middleware())
	r.Use(limiter.Middleware())

	// API routes
	api := r.PathPrefix("/api").Subrouter()

	// Public auth endpoints
	api.HandleFunc("/auth/session", handler.GetSession).Methods("GET", "OPTIONS")
	api.HandleFunc("/auth/logout", handler.Logout).Methods("POST", "OPTIONS")

	// Curated short film catalog
	api.HandleFunc("/media-assets", handler.GetMediaAssets).Methods("GET", "OPTIONS")

	// Protected routes (require active session)
	protected := api.PathPrefix("").Subrouter()
	protected.Use(auth.Middleware(authService))
	protected.HandleFunc("/auth/profile", handler.UpdateProfile).Methods("PATCH", "OPTIONS")
	protected.HandleFunc("/user/rooms", handler.GetUserRooms).Methods("GET", "OPTIONS")
	protected.HandleFunc("/media/presign-upload", handler.PresignUpload).Methods("POST", "OPTIONS")
	protected.HandleFunc("/rooms", handler.CreateRoom).Methods("POST", "OPTIONS")
	protected.HandleFunc("/rooms/join", handler.JoinRoom).Methods("POST", "OPTIONS")
	protected.HandleFunc("/rooms/{roomCode}", handler.ShutdownRoom).Methods("DELETE", "OPTIONS")
	protected.HandleFunc("/rooms/{roomCode}/leave", handler.LeaveRoom).Methods("POST", "OPTIONS")

	// Dev simulation endpoint for local direct uploads
	api.HandleFunc("/media/mock-upload/{key:.+}", handler.MockUpload).Methods("PUT", "OPTIONS")

	// Public room info and commentary
	api.HandleFunc("/rooms/{roomCode}", handler.GetRoom).Methods("GET", "OPTIONS")
	api.HandleFunc("/rooms/{roomCode}/commentary", handler.GetCommentary).Methods("GET", "OPTIONS")
	api.HandleFunc("/health", handler.Health).Methods("GET", "OPTIONS")

	// Health at root level too
	r.HandleFunc("/health", handler.Health).Methods("GET", "OPTIONS")

	// WebSocket (authenticated inside handler via sw_session cookie)
	r.HandleFunc("/ws", handler.HandleWebSocket).Methods("GET")

	// Static files — serve the frontend safely without exposing directory listings or metadata files
	frontendDir := filepath.Join("..", "frontend")
	if _, err := os.Stat(frontendDir); os.IsNotExist(err) {
		frontendDir = "frontend"
	}
	r.PathPrefix("/").Handler(http.FileServer(safeFileSystem{http.Dir(frontendDir)}))

	// Start background room reaper to auto-shutdown rooms when their duration expires
	stopReaper := handler.StartRoomReaper(15 * time.Second)

	// Bind primary server explicitly to 0.0.0.0 (IPv4) so container health checkers
	// inspecting /proc/net/tcp find an active IPv4 TCP listener
	primaryAddr := fmt.Sprintf("0.0.0.0:%d", cfg.Port)
	srv := &http.Server{
		Addr:         primaryAddr,
		Handler:      r,
		ReadTimeout:  15 * time.Minute,
		WriteTimeout: 15 * time.Minute,
		IdleTimeout:  60 * time.Second,
	}

	// Secondary dual-port listener: if primary is 3000, also bind 8080; if 8080, also bind 3000
	// Guarantees container healthchecks on either standard PaaS port succeed unconditionally
	secondaryPort := 8080
	if cfg.Port == 8080 {
		secondaryPort = 3000
	}
	secondaryAddr := fmt.Sprintf("0.0.0.0:%d", secondaryPort)
	secondarySrv := &http.Server{
		Addr:         secondaryAddr,
		Handler:      r,
		ReadTimeout:  15 * time.Minute,
		WriteTimeout: 15 * time.Minute,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan

		log.Println("Shutting down gracefully...")
		limiter.Stop()
		stopReaper()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		srv.Shutdown(shutdownCtx)
		secondarySrv.Shutdown(shutdownCtx)
	}()

	// Start secondary listener in background
	go func() {
		if err := secondarySrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[dual-port] secondary listener (%s) info: %v", secondaryAddr, err)
		}
	}()

	log.Printf("Spatial Watch listening on %s (dual-port standby on %s)", primaryAddr, secondaryAddr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}

// safeFileSystem wraps http.FileSystem to disallow directory listing and block dotfiles/metadata
type safeFileSystem struct {
	fs http.FileSystem
}

func (sfs safeFileSystem) Open(name string) (http.File, error) {
	cleanPath := filepath.Clean(name)
	parts := strings.Split(cleanPath, string(filepath.Separator))
	for _, p := range parts {
		if strings.HasPrefix(p, ".") && p != "." && p != ".." {
			return nil, os.ErrPermission
		}
		if strings.HasPrefix(p, "_") {
			return nil, os.ErrPermission
		}
	}

	f, err := sfs.fs.Open(name)
	if err != nil {
		return nil, err
	}

	stat, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}

	if stat.IsDir() {
		indexPath := filepath.Join(name, "index.html")
		if indexFile, err := sfs.fs.Open(indexPath); err == nil {
			indexFile.Close()
		} else {
			f.Close()
			return nil, os.ErrNotExist
		}
	}

	return f, nil
}

// securityHeadersMiddleware enforces defensive HTTP headers across all endpoints
func securityHeadersMiddleware(cookieSecure bool) mux.MiddlewareFunc {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("X-Frame-Options", "SAMEORIGIN")
			w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
			w.Header().Set("X-XSS-Protection", "1; mode=block")
			w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
			w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' wss: ws: https: blob:; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'self';")
			if cookieSecure || r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
				w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
			}
			next.ServeHTTP(w, r)
		})
	}
}

// corsMiddleware enforces explicit origin matching for credentialed requests
func corsMiddleware(allowedOrigins []string) mux.MiddlewareFunc {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && handlers.IsOriginAllowed(origin, allowedOrigins, r.Host) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Cookie, Authorization, X-Requested-With")
				w.Header().Set("Access-Control-Max-Age", "86400")
				w.Header().Add("Vary", "Origin")
			}

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
