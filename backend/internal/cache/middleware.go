package cache

import (
	"net/http"
	"strings"
)

// Middleware applies Cloudflare edge cache and browser caching headers
func Middleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path := r.URL.Path

			// 1. Never cache dynamic APIs or real-time WebSocket handshakes
			if strings.HasPrefix(path, "/api/") || path == "/ws" {
				w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, private")
				w.Header().Set("Pragma", "no-cache")
				w.Header().Set("Expires", "0")
				next.ServeHTTP(w, r)
				return
			}

			// 2. Uploaded videos: NO CACHING since they are ephemeral and deleted after streaming.
			// Still require Accept-Ranges and CORS for WebGL video textures.
			if strings.HasPrefix(path, "/assets/uploads/") && strings.HasSuffix(strings.ToLower(path), ".mp4") {
				w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, private")
				w.Header().Set("Accept-Ranges", "bytes")
				w.Header().Set("Access-Control-Allow-Origin", "*")
				w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, ETag")
				next.ServeHTTP(w, r)
				return
			}

			// 2b. Bundled static catalog videos: Cache allowed
			if strings.HasPrefix(path, "/assets/videos/") && strings.HasSuffix(strings.ToLower(path), ".mp4") {
				w.Header().Set("Cache-Control", "public, max-age=86400")
				w.Header().Set("Accept-Ranges", "bytes")
				w.Header().Set("Access-Control-Allow-Origin", "*")
				w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, ETag")
				next.ServeHTTP(w, r)
				return
			}

			// 3. Static libraries, CSS, icons, Three.js: immutable edge caching (7 days TTL)
			if strings.HasPrefix(path, "/css/") ||
				strings.HasPrefix(path, "/assets/") ||
				strings.HasSuffix(path, ".js") ||
				strings.HasSuffix(path, ".css") ||
				strings.HasSuffix(path, ".svg") ||
				strings.HasSuffix(path, ".png") ||
				strings.HasSuffix(path, ".ico") ||
				strings.HasSuffix(path, ".webp") {
				w.Header().Set("Cache-Control", "no-cache") // Changed from immutable for development
				next.ServeHTTP(w, r)
				return
			}

			// 4. HTML root and entry pages: no-cache
			if path == "/" || strings.HasSuffix(path, ".html") {
				w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
				next.ServeHTTP(w, r)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
