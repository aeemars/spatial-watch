package websocket

import (
	"sync"
	"time"
)

// RateLimiter provides simple in-memory per-key rate limiting
type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	tokens    int
	lastCheck time.Time
}

// NewRateLimiter creates a new rate limiter
func NewRateLimiter() *RateLimiter {
	rl := &RateLimiter{
		buckets: make(map[string]*bucket),
	}
	// Periodically clean up stale buckets
	go func() {
		for {
			time.Sleep(5 * time.Minute)
			rl.cleanup()
		}
	}()
	return rl
}

// Allow returns true if the action is allowed under the rate limit
func (rl *RateLimiter) Allow(userID, action string, limit int, window time.Duration) bool {
	key := userID + ":" + action

	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, exists := rl.buckets[key]
	now := time.Now()

	if !exists || now.Sub(b.lastCheck) >= window {
		rl.buckets[key] = &bucket{tokens: 1, lastCheck: now}
		return true
	}

	if b.tokens >= limit {
		return false
	}

	b.tokens++
	return true
}

func (rl *RateLimiter) cleanup() {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	cutoff := time.Now().Add(-10 * time.Minute)
	for key, b := range rl.buckets {
		if b.lastCheck.Before(cutoff) {
			delete(rl.buckets, key)
		}
	}
}
