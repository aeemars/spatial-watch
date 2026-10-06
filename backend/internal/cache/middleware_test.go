package cache_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"spatialwatch/internal/cache"
)

func TestCacheMiddleware_Headers(t *testing.T) {
	dummyHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	handler := cache.Middleware()(dummyHandler)

	tests := []struct {
		name                 string
		path                 string
		expectedCacheControl string
		expectedPragma       string
		expectedAcceptRanges string
	}{
		{
			name:                 "API Auth Endpoint Bypass",
			path:                 "/api/auth/session",
			expectedCacheControl: "no-store, no-cache, must-revalidate, private",
			expectedPragma:       "no-cache",
		},
		{
			name:                 "API Rooms Endpoint Bypass",
			path:                 "/api/rooms/SW-TEST",
			expectedCacheControl: "no-store, no-cache, must-revalidate, private",
			expectedPragma:       "no-cache",
		},
		{
			name:                 "WebSocket Handshake Bypass",
			path:                 "/ws",
			expectedCacheControl: "no-store, no-cache, must-revalidate, private",
			expectedPragma:       "no-cache",
		},
		{
			name:                 "Bundled Video Range Cache",
			path:                 "/assets/videos/big-buck-bunny.mp4",
			expectedCacheControl: "public, max-age=86400",
			expectedAcceptRanges: "bytes",
		},
		{
			name:                 "CSS File Immutable Cache",
			path:                 "/css/components.css",
			expectedCacheControl: "public, max-age=604800, immutable",
		},
		{
			name:                 "JavaScript Library Immutable Cache",
			path:                 "/assets/three.min.js",
			expectedCacheControl: "public, max-age=604800, immutable",
		},
		{
			name:                 "SVG Icon Immutable Cache",
			path:                 "/assets/logo.svg",
			expectedCacheControl: "public, max-age=604800, immutable",
		},
		{
			name:                 "Root HTML Entry Cache",
			path:                 "/",
			expectedCacheControl: "public, max-age=300, must-revalidate",
		},
		{
			name:                 "Index HTML Entry Cache",
			path:                 "/index.html",
			expectedCacheControl: "public, max-age=300, must-revalidate",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", tt.path, nil)
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)

			cc := rr.Header().Get("Cache-Control")
			if !strings.EqualFold(cc, tt.expectedCacheControl) {
				t.Errorf("Path %s: expected Cache-Control %q, got %q", tt.path, tt.expectedCacheControl, cc)
			}

			if tt.expectedPragma != "" {
				pragma := rr.Header().Get("Pragma")
				if pragma != tt.expectedPragma {
					t.Errorf("Path %s: expected Pragma %q, got %q", tt.path, tt.expectedPragma, pragma)
				}
			}

			if tt.expectedAcceptRanges != "" {
				ar := rr.Header().Get("Accept-Ranges")
				if ar != tt.expectedAcceptRanges {
					t.Errorf("Path %s: expected Accept-Ranges %q, got %q", tt.path, tt.expectedAcceptRanges, ar)
				}
			}
		})
	}
}
