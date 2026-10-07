package ratelimit

import (
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/mux"
)

// Rule defines rate limiting parameters for a route
type Rule struct {
	Name    string
	Method  string
	Path    string
	Limit   int
	Window  time.Duration
}

type clientRecord struct {
	timestamps []time.Time
}

// Limiter manages thread-safe sliding window rate limiting
type Limiter struct {
	mu      sync.RWMutex
	rules   map[string]Rule
	clients map[string]map[string]*clientRecord // ruleName -> ip -> record
	stopCh  chan struct{}
}

// NewLimiter creates a new Limiter with the provided rules
func NewLimiter(rules []Rule) *Limiter {
	l := &Limiter{
		rules:   make(map[string]Rule),
		clients: make(map[string]map[string]*clientRecord),
		stopCh:  make(chan struct{}),
	}

	for _, r := range rules {
		key := ruleKey(r.Method, r.Path)
		l.rules[key] = r
		l.clients[key] = make(map[string]*clientRecord)
	}

	// Start background cleanup goroutine
	go l.cleanupLoop(1 * time.Minute)

	return l
}

// NewDefaultLimiter creates a Limiter initialized with the production anti-abuse rules:
// - POST /api/rooms: 5 req per 5 min
// - GET /api/auth/session: 30 req per 1 min
// - POST /api/media/presign-upload: 3 req per 10 min
// - GET /ws: 10 handshakes per 1 min
func NewDefaultLimiter() *Limiter {
	return NewLimiter([]Rule{
		{
			Name:   "create_room",
			Method: http.MethodPost,
			Path:   "/api/rooms",
			Limit:  5,
			Window: 5 * time.Minute,
		},
		{
			Name:   "auth_session",
			Method: http.MethodGet,
			Path:   "/api/auth/session",
			Limit:  30,
			Window: 1 * time.Minute,
		},
		{
			Name:   "presign_upload",
			Method: http.MethodPost,
			Path:   "/api/media/presign-upload",
			Limit:  3,
			Window: 10 * time.Minute,
		},
		{
			Name:   "websocket_handshake",
			Method: http.MethodGet,
			Path:   "/ws",
			Limit:  10,
			Window: 1 * time.Minute,
		},
	})
}

func ruleKey(method, path string) string {
	return method + ":" + path
}

// Allow checks if a request from the given IP for the specified method and path is allowed.
// If allowed, it returns (true, 0).
// If rejected, it returns (false, retryAfterSeconds).
func (l *Limiter) Allow(method, path, ip string) (bool, int) {
	key := ruleKey(method, path)

	l.mu.Lock()
	defer l.mu.Unlock()

	rule, ok := l.rules[key]
	if !ok {
		// Not rate-limited
		return true, 0
	}

	ipMap, ok := l.clients[key]
	if !ok {
		ipMap = make(map[string]*clientRecord)
		l.clients[key] = ipMap
	}

	rec, ok := ipMap[ip]
	if !ok {
		rec = &clientRecord{timestamps: make([]time.Time, 0, rule.Limit)}
		ipMap[ip] = rec
	}

	now := time.Now()
	cutoff := now.Add(-rule.Window)

	// Filter timestamps within sliding window
	valid := make([]time.Time, 0, len(rec.timestamps))
	for _, t := range rec.timestamps {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	rec.timestamps = valid

	if len(rec.timestamps) >= rule.Limit {
		// Exceeded: calculate retry-after from earliest timestamp in current window
		oldest := rec.timestamps[0]
		remaining := oldest.Add(rule.Window).Sub(now)
		retrySec := int(remaining.Seconds()) + 1
		if retrySec < 1 {
			retrySec = 1
		}
		return false, retrySec
	}

	// Record this request
	rec.timestamps = append(rec.timestamps, now)
	return true, 0
}

// Stop terminates the background cleanup routine
func (l *Limiter) Stop() {
	select {
	case <-l.stopCh:
		// already closed
	default:
		close(l.stopCh)
	}
}

// cleanupLoop periodically evicts expired client records to prevent memory exhaustion
func (l *Limiter) cleanupLoop(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			l.sweep()
		case <-l.stopCh:
			return
		}
	}
}

// sweep cleans up timestamps and removes empty IP entries
func (l *Limiter) sweep() {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	for key, rule := range l.rules {
		cutoff := now.Add(-rule.Window)
		ipMap := l.clients[key]
		for ip, rec := range ipMap {
			valid := make([]time.Time, 0, len(rec.timestamps))
			for _, t := range rec.timestamps {
				if t.After(cutoff) {
					valid = append(valid, t)
				}
			}
			if len(valid) == 0 {
				delete(ipMap, ip)
			} else {
				rec.timestamps = valid
			}
		}
	}
}

// Middleware returns a Gorilla mux middleware that applies rate limiting rules
func (l *Limiter) Middleware() mux.MiddlewareFunc {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// OPTIONS requests (CORS preflight) are never rate limited
			if r.Method == http.MethodOptions {
				next.ServeHTTP(w, r)
				return
			}

			key := ruleKey(r.Method, r.URL.Path)
			l.mu.RLock()
			_, hasRule := l.rules[key]
			l.mu.RUnlock()

			if hasRule {
				ip := ClientIP(r)
				allowed, retryAfter := l.Allow(r.Method, r.URL.Path, ip)
				if !allowed {
					w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusTooManyRequests)
					_ = json.NewEncoder(w).Encode(map[string]interface{}{
						"error":       "Too many requests. Please try again later.",
						"retry_after": retryAfter,
					})
					return
				}
			}

			next.ServeHTTP(w, r)
		})
	}
}
