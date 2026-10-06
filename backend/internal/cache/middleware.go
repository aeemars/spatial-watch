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

			// 2. Bundled videos: enable HTTP Range request caching (1 day TTL)
			if strings.HasPrefix(path, "/assets/videos/") && strings.HasSuffix(strings.ToLower(path), ".mp4") {
				w.Header().Set("Cache-Control", "public, max-age=86400")
				w.Header().Set("Accept-Ranges", "bytes")
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
				w.Header().Set("Cache-Control", "public, max-age=604800, immutable")
				next.ServeHTTP(w, r)
				return
			}

			// 4. HTML root and entry pages: short edge caching with must-revalidate (5 min)
			if path == "/" || strings.HasSuffix(path, ".html") {
				w.Header().Set("Cache-Control", "public, max-age=300, must-revalidate")
				next.ServeHTTP(w, r)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
