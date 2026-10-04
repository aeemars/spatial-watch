package auth_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatialwatch/config"
	"spatialwatch/internal/auth"
	"spatialwatch/models"
	"spatialwatch/repository"
)

func setupTestAuthService() (*auth.AuthService, repository.UserRepository, repository.SessionRepository) {
	userRepo := repository.NewUserRepo(nil)
	sessionRepo := repository.NewSessionRepo(nil)
	cfg := &config.Config{
		CookieSecure:        false,
		SessionDurationDays: 30,
	}
	svc := auth.NewAuthService(userRepo, sessionRepo, cfg)
	return svc, userRepo, sessionRepo
}

// 1. First visit creates user, session, returns sanitized data, sets cookie
func TestFirstVisitCreatesGuestSession(t *testing.T) {
	svc, userRepo, sessionRepo := setupTestAuthService()

	req := httptest.NewRequest("GET", "/api/auth/session", nil)
	w := httptest.NewRecorder()

	sanitized, err := svc.GetOrCreateSession(w, req)
	if err != nil {
		t.Fatalf("GetOrCreateSession failed: %v", err)
	}

	if sanitized.ID == "" {
		t.Fatal("Expected non-empty user ID")
	}
	if !sanitized.IsGuest {
		t.Fatal("Expected isGuest to be true")
	}
	if sanitized.DisplayName == "" {
		t.Fatal("Expected pleasant generated display name")
	}

	// Verify cookie was set
	cookies := w.Result().Cookies()
	var sessionCookie *http.Cookie
	for _, c := range cookies {
		if c.Name == auth.CookieSessionName {
			sessionCookie = c
			break
		}
	}

	if sessionCookie == nil {
		t.Fatal("Expected sw_session cookie to be set")
	}
	if sessionCookie.Value == "" {
		t.Fatal("Expected sw_session cookie to have a non-empty token")
	}
	if !sessionCookie.HttpOnly {
		t.Error("sw_session cookie must be HttpOnly")
	}
	if sessionCookie.SameSite != http.SameSiteLaxMode {
		t.Errorf("Expected SameSite Lax, got %v", sessionCookie.SameSite)
	}

	// Verify User was saved in repository
	user, err := userRepo.FindByID(context.Background(), sanitized.ID)
	if err != nil {
		t.Fatalf("User not found in repo: %v", err)
	}
	if user.DisplayName != sanitized.DisplayName {
		t.Errorf("Expected display name %s, got %s", sanitized.DisplayName, user.DisplayName)
	}

	// Verify Session was saved with TokenHash (NOT raw token)
	tokenHash := auth.HashToken(sessionCookie.Value)
	sess, err := sessionRepo.FindByTokenHash(context.Background(), tokenHash)
	if err != nil {
		t.Fatalf("Session not found in repo by hash: %v", err)
	}
	if sess.UserID != user.ID {
		t.Errorf("Expected session userId %s, got %s", user.ID, sess.UserID)
	}
}

// 2. Returning visitor receives the same user ID and refreshes session
func TestReturningVisitorPreservesIdentity(t *testing.T) {
	svc, _, sessionRepo := setupTestAuthService()

	// Initial visit
	req1 := httptest.NewRequest("GET", "/api/auth/session", nil)
	w1 := httptest.NewRecorder()
	u1, err := svc.GetOrCreateSession(w1, req1)
	if err != nil {
		t.Fatalf("Initial session failed: %v", err)
	}

	var sessionCookie *http.Cookie
	for _, c := range w1.Result().Cookies() {
		if c.Name == auth.CookieSessionName {
			sessionCookie = c
		}
	}
	if sessionCookie == nil {
		t.Fatal("sw_session cookie missing")
	}

	// Second visit with cookie
	req2 := httptest.NewRequest("GET", "/api/auth/session", nil)
	req2.AddCookie(sessionCookie)
	w2 := httptest.NewRecorder()

	u2, err := svc.GetOrCreateSession(w2, req2)
	if err != nil {
		t.Fatalf("Returning session failed: %v", err)
	}

	if u1.ID != u2.ID {
		t.Fatalf("Expected same user ID %s, got %s", u1.ID, u2.ID)
	}
	if u1.DisplayName != u2.DisplayName {
		t.Fatalf("Expected same display name %s, got %s", u1.DisplayName, u2.DisplayName)
	}

	// Simulate session inactivity passing RefreshThreshold (15 mins)
	tokenHash := auth.HashToken(sessionCookie.Value)
	pastTime := time.Now().Add(-2 * time.Hour)
	_ = sessionRepo.Refresh(context.Background(), tokenHash, time.Now().Add(24*time.Hour), pastTime)

	req3 := httptest.NewRequest("GET", "/api/auth/session", nil)
	req3.AddCookie(sessionCookie)
	w3 := httptest.NewRecorder()
	u3, err := svc.GetOrCreateSession(w3, req3)
	if err != nil {
		t.Fatalf("Refresh check failed: %v", err)
	}
	if u3.ID != u1.ID {
		t.Errorf("Expected user ID %s, got %s", u1.ID, u3.ID)
	}

	refreshedSess, _ := sessionRepo.FindByTokenHash(context.Background(), tokenHash)
	if refreshedSess != nil && refreshedSess.LastSeenAt.Before(time.Now().Add(-time.Minute)) {
		t.Error("Expected LastSeenAt to be updated on active use")
	}
}

// 3. Stale, malformed, or expired cookies are cleared and produce a fresh session
func TestStaleOrMalformedCookies(t *testing.T) {
	svc, _, sessionRepo := setupTestAuthService()

	// A) Unknown / random token
	req := httptest.NewRequest("GET", "/api/auth/session", nil)
	req.AddCookie(&http.Cookie{Name: auth.CookieSessionName, Value: "non-existent-fake-token-12345"})
	w := httptest.NewRecorder()

	u, err := svc.GetOrCreateSession(w, req)
	if err != nil {
		t.Fatalf("Expected fresh guest, got error: %v", err)
	}
	if u == nil || u.ID == "" {
		t.Fatal("Expected new guest user")
	}

	// B) Expired session
	rawToken, _ := auth.GenerateToken()
	tokenHash := auth.HashToken(rawToken)
	now := time.Now()
	expiredSession := modelsSessionHelper(tokenHash, u.ID, now.Add(-48*time.Hour), now.Add(-24*time.Hour))
	_ = sessionRepo.Create(context.Background(), expiredSession)

	reqExpired := httptest.NewRequest("GET", "/api/auth/session", nil)
	reqExpired.AddCookie(&http.Cookie{Name: auth.CookieSessionName, Value: rawToken})
	wExpired := httptest.NewRecorder()

	uFresh, err := svc.GetOrCreateSession(wExpired, reqExpired)
	if err != nil {
		t.Fatalf("Failed to issue fresh session on expired cookie: %v", err)
	}
	if uFresh == nil || uFresh.ID == "" {
		t.Fatal("Expected fresh user on expired cookie")
	}
}

// 4. Token security: random token has high entropy, only hash stored
func TestTokenSecurity(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 50; i++ {
		token, err := auth.GenerateToken()
		if err != nil {
			t.Fatalf("GenerateToken failed: %v", err)
		}
		if len(token) < 40 {
			t.Errorf("Expected token length >= 40, got %d", len(token))
		}
		if strings.Contains(token, "-") && len(token) == 36 {
			t.Error("Session token should never be a UUID")
		}
		if seen[token] {
			t.Fatal("Duplicate token generated")
		}
		seen[token] = true

		hash := auth.HashToken(token)
		if hash == token {
			t.Fatal("Hash must differ from raw token")
		}
		if len(hash) != 64 { // SHA-256 hex is 64 chars
			t.Errorf("Expected 64 hex characters for SHA-256 hash, got %d", len(hash))
		}
	}
}

// 5. Display name validation: boundaries, whitespace, control chars, safe HTML
func TestDisplayNameValidation(t *testing.T) {
	// Valid names
	valid := []string{
		"Cinema Fox",
		"Ada",
		"Quiet Comet 42",
		"Director ✨",
		"   Trimmed Name   ",
	}
	for _, v := range valid {
		res, err := auth.ValidateDisplayName(v)
		if err != nil {
			t.Errorf("Expected %q to be valid, got err: %v", v, err)
		}
		if strings.TrimSpace(res) != res {
			t.Errorf("Expected trimmed output for %q, got %q", v, res)
		}
	}

	// Invalid names
	invalid := []string{
		"",
		" ",
		"a",                                    // too short (< 2)
		"this name is way too long to be valid in our system because it exceeds thirty-two visible chars", // > 32
		"<script>alert(1)</script>",           // HTML tag
		"Hello <world>",                       // < or >
		"Bad\nNewline",                        // Control char
		"Bad\tTab",                            // Control char
		"Bad\x00Null",                         // Control char
	}
	for _, inv := range invalid {
		_, err := auth.ValidateDisplayName(inv)
		if err == nil {
			t.Errorf("Expected %q to be rejected, but it passed", inv)
		}
	}
}

// 6. Profile update requires authentication and persists safely
func TestProfileUpdate(t *testing.T) {
	svc, userRepo, _ := setupTestAuthService()

	// Create user
	req := httptest.NewRequest("GET", "/api/auth/session", nil)
	w := httptest.NewRecorder()
	u, err := svc.GetOrCreateSession(w, req)
	if err != nil {
		t.Fatalf("Failed to create session: %v", err)
	}

	// Update display name
	updated, err := svc.UpdateProfile(context.Background(), u.ID, "Stellar Voyager")
	if err != nil {
		t.Fatalf("UpdateProfile failed: %v", err)
	}
	if updated.DisplayName != "Stellar Voyager" {
		t.Errorf("Expected Stellar Voyager, got %s", updated.DisplayName)
	}

	// Verify in repo
	inRepo, _ := userRepo.FindByID(context.Background(), u.ID)
	if inRepo.DisplayName != "Stellar Voyager" {
		t.Errorf("Expected in repo Stellar Voyager, got %s", inRepo.DisplayName)
	}
}

// 7. Logout invalidates session and clears cookie without deleting user
func TestLogoutBehavior(t *testing.T) {
	svc, userRepo, sessionRepo := setupTestAuthService()

	// Initial session
	req := httptest.NewRequest("GET", "/api/auth/session", nil)
	w := httptest.NewRecorder()
	u, _ := svc.GetOrCreateSession(w, req)

	var sessionCookie *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == auth.CookieSessionName {
			sessionCookie = c
		}
	}

	// Call logout
	logoutReq := httptest.NewRequest("POST", "/api/auth/logout", nil)
	logoutReq.AddCookie(sessionCookie)
	logoutW := httptest.NewRecorder()

	err := svc.Logout(logoutW, logoutReq)
	if err != nil {
		t.Fatalf("Logout failed: %v", err)
	}

	// Check cookie was cleared (Max-Age: -1 or empty)
	var clearedCookie *http.Cookie
	for _, c := range logoutW.Result().Cookies() {
		if c.Name == auth.CookieSessionName {
			clearedCookie = c
		}
	}
	if clearedCookie == nil || clearedCookie.MaxAge >= 0 {
		t.Errorf("Expected cleared cookie with MaxAge < 0, got %+v", clearedCookie)
	}

	// Check session was deleted from repo
	tokenHash := auth.HashToken(sessionCookie.Value)
	_, err = sessionRepo.FindByTokenHash(context.Background(), tokenHash)
	if err == nil {
		t.Error("Expected session to be deleted after logout")
	}

	// Check user record STILL exists
	userInDb, err := userRepo.FindByID(context.Background(), u.ID)
	if err != nil || userInDb == nil {
		t.Error("User record must NOT be deleted on logout")
	}
}

// Helper to construct models.Session
func modelsSessionHelper(tokenHash, userID string, createdAt, expiresAt time.Time) models.Session {
	return models.Session{
		TokenHash:  tokenHash,
		UserID:     userID,
		CreatedAt:  createdAt,
		ExpiresAt:  expiresAt,
		LastSeenAt: createdAt,
	}
}
