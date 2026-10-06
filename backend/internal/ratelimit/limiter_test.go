package ratelimit

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestClientIP(t *testing.T) {
	tests := []struct {
		name       string
		headers    map[string]string
		remoteAddr string
		expectedIP string
	}{
		{
			name: "Prefers CF-Connecting-IP",
			headers: map[string]string{
				"CF-Connecting-IP": "203.0.113.195",
				"X-Forwarded-For":  "198.51.100.1, 10.0.0.1",
			},
			remoteAddr: "192.0.2.1:54321",
			expectedIP: "203.0.113.195",
		},
		{
			name: "Fallback to X-Forwarded-For if CF-Connecting-IP absent",
			headers: map[string]string{
				"X-Forwarded-For": "198.51.100.42, 10.0.0.2",
			},
			remoteAddr: "192.0.2.1:54321",
			expectedIP: "198.51.100.42",
		},
		{
			name: "Fallback to RemoteAddr host:port",
			headers: map[string]string{},
			remoteAddr: "192.0.2.77:12345",
			expectedIP: "192.0.2.77",
		},
		{
			name: "RemoteAddr bare IP",
			headers: map[string]string{},
			remoteAddr: "192.0.2.88",
			expectedIP: "192.0.2.88",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/test", nil)
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}
			req.RemoteAddr = tc.remoteAddr

			got := ClientIP(req)
			if got != tc.expectedIP {
				t.Fatalf("expected IP %s, got %s", tc.expectedIP, got)
			}
		})
	}
}

func TestLimiter_Allow(t *testing.T) {
	limiter := NewLimiter([]Rule{
		{
			Name:   "test_action",
			Method: http.MethodPost,
			Path:   "/test/action",
			Limit:  3,
			Window: 1 * time.Second,
		},
	})
	defer limiter.Stop()

	ip := "203.0.113.1"

	// First 3 requests should be allowed
	for i := 1; i <= 3; i++ {
		allowed, retryAfter := limiter.Allow(http.MethodPost, "/test/action", ip)
		if !allowed {
			t.Fatalf("request #%d should have been allowed", i)
		}
		if retryAfter != 0 {
			t.Fatalf("retryAfter should be 0, got %d", retryAfter)
		}
	}

	// 4th request must be rejected
	allowed, retryAfter := limiter.Allow(http.MethodPost, "/test/action", ip)
	if allowed {
		t.Fatalf("request #4 should have been rejected")
	}
	if retryAfter <= 0 {
		t.Fatalf("expected positive retryAfter, got %d", retryAfter)
	}

	// Different IP should still be allowed
	allowedOther, _ := limiter.Allow(http.MethodPost, "/test/action", "203.0.113.2")
	if !allowedOther {
		t.Fatalf("request from different IP should be allowed")
	}

	// Different unmonitored path should be allowed
	allowedUnmonitored, _ := limiter.Allow(http.MethodGet, "/test/other", ip)
	if !allowedUnmonitored {
		t.Fatalf("request for unconfigured route should be allowed")
	}
}

func TestLimiter_Middleware(t *testing.T) {
	limiter := NewLimiter([]Rule{
		{
			Name:   "create_room",
			Method: http.MethodPost,
			Path:   "/api/rooms",
			Limit:  2,
			Window: 10 * time.Second,
		},
	})
	defer limiter.Stop()

	nextHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	handler := limiter.Middleware()(nextHandler)

	// OPTIONS preflight should pass even if called repeatedly
	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodOptions, "/api/rooms", nil)
		req.Header.Set("CF-Connecting-IP", "1.2.3.4")
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("OPTIONS should pass, got code %d", rr.Code)
		}
	}

	// POST 1 & 2 pass
	for i := 1; i <= 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/rooms", nil)
		req.Header.Set("CF-Connecting-IP", "1.2.3.4")
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("request #%d should pass with 200, got %d", i, rr.Code)
		}
	}

	// POST 3 blocked with 429 and Retry-After header
	req := httptest.NewRequest(http.MethodPost, "/api/rooms", nil)
	req.Header.Set("CF-Connecting-IP", "1.2.3.4")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 Too Many Requests, got %d", rr.Code)
	}

	retryAfterHdr := rr.Header().Get("Retry-After")
	if retryAfterHdr == "" {
		t.Fatalf("expected Retry-After header to be present")
	}
	retryVal, err := strconv.Atoi(retryAfterHdr)
	if err != nil || retryVal <= 0 {
		t.Fatalf("invalid Retry-After value: %s", retryAfterHdr)
	}

	var body map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode response JSON: %v", err)
	}
	if body["error"] != "Too many requests. Please try again later." {
		t.Fatalf("unexpected error message: %v", body["error"])
	}
}
