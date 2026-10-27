package auth

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"spatialwatch/config"
	"spatialwatch/models"
	"spatialwatch/repository"
)

const (
	CookieSessionName = "sw_session"
	// RefreshThreshold defines minimum time since last seen before refreshing session in DB
	RefreshThreshold = 15 * time.Minute
)

var (
	ErrUnauthorized    = errors.New("unauthorized")
	ErrRateLimitExceeded = errors.New("rate limit exceeded")
)

// IPRateLimiter provides per-IP rate limiting for guest session creation
type IPRateLimiter struct {
	mu       sync.Mutex
	attempts map[string][]time.Time
	limit    int
	window   time.Duration
}

func NewIPRateLimiter(limit int, window time.Duration) *IPRateLimiter {
	return &IPRateLimiter{
		attempts: make(map[string][]time.Time),
		limit:    limit,
		window:   window,
	}
}

func (l *IPRateLimiter) Allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-l.window)

	var valid []time.Time
	for _, t := range l.attempts[ip] {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}

	if len(valid) >= l.limit {
		l.attempts[ip] = valid
		return false
	}

	l.attempts[ip] = append(valid, now)
	return true
}

// AuthService coordinates authentication, session lifecycle, and cookies
type AuthService struct {
	userRepo    repository.UserRepository
	sessionRepo repository.SessionRepository
	cfg         *config.Config
	limiter     *IPRateLimiter
}

// NewAuthService creates a new AuthService instance
func NewAuthService(
	userRepo repository.UserRepository,
	sessionRepo repository.SessionRepository,
	cfg *config.Config,
) *AuthService {
	// Allow 60 new guest session creations per minute per IP (generous for dev, protective for prod)
	limiter := NewIPRateLimiter(60, time.Minute)
	return &AuthService{
		userRepo:    userRepo,
		sessionRepo: sessionRepo,
		cfg:         cfg,
		limiter:     limiter,
	}
}

// SessionDuration returns the configured duration for sessions
func (s *AuthService) SessionDuration() time.Duration {
	days := s.cfg.SessionDurationDays
	if days <= 0 {
		days = 30
	}
	return time.Duration(days) * 24 * time.Hour
}

// GetOrCreateSession retrieves the active authenticated user from the cookie,
// or creates a new guest identity and issues a session cookie if missing/stale/expired.
func (s *AuthService) GetOrCreateSession(w http.ResponseWriter, r *http.Request) (*models.SanitizedUser, error) {
	ctx := r.Context()

	// 1. Check existing cookie
	if cookie, err := r.Cookie(CookieSessionName); err == nil && strings.TrimSpace(cookie.Value) != "" {
		tokenHash := HashToken(cookie.Value)
		sess, err := s.sessionRepo.FindByTokenHash(ctx, tokenHash)
		if err == nil && sess != nil {
			user, err := s.userRepo.FindByID(ctx, sess.UserID)
			if err == nil && user != nil {
				// Refresh session if threshold passed
				now := time.Now()
				if now.Sub(sess.LastSeenAt) > RefreshThreshold {
					newExpiry := now.Add(s.SessionDuration())
					_ = s.sessionRepo.Refresh(ctx, tokenHash, newExpiry, now)
					_ = s.userRepo.TouchLastSeen(ctx, user.ID, now)
				}
				sanitized := user.ToSanitized()
				return &sanitized, nil
			}
		}
		// If session is unknown, expired, or user not found, fall through to create a fresh guest session.
		// NOTE: Do not call ClearSessionCookie here, because SetSessionCookie below will overwrite it cleanly.
	}

	// 2. Rate limit new guest creation per client IP
	clientIP := getClientIP(r)
	if !s.limiter.Allow(clientIP) {
		return nil, ErrRateLimitExceeded
	}

	// 3. Create fresh guest user
	userID, err := GenerateUUIDv4()
	if err != nil {
		return nil, err
	}

	displayName := GenerateGuestName()
	now := time.Now()
	user := models.User{
		ID:          userID,
		DisplayName: displayName,
		IsGuest:     true,
		CreatedAt:   now,
		LastSeenAt:  now,
	}

	if err := s.userRepo.Create(ctx, user); err != nil {
		return nil, err
	}

	// 4. Generate opaque session token & hash
	rawToken, err := GenerateToken()
	if err != nil {
		return nil, err
	}
	tokenHash := HashToken(rawToken)

	session := models.Session{
		TokenHash:  tokenHash,
		UserID:     userID,
		CreatedAt:  now,
		ExpiresAt:  now.Add(s.SessionDuration()),
		LastSeenAt: now,
	}

	if err := s.sessionRepo.Create(ctx, session); err != nil {
		return nil, err
	}

	// 5. Send raw token once in HttpOnly session cookie
	s.SetSessionCookie(w, rawToken)

	sanitized := user.ToSanitized()
	return &sanitized, nil
}

// AuthenticateRequest verifies the sw_session cookie and returns the authenticated user
func (s *AuthService) AuthenticateRequest(r *http.Request) (*models.User, error) {
	cookie, err := r.Cookie(CookieSessionName)
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		return nil, ErrUnauthorized
	}

	ctx := r.Context()
	tokenHash := HashToken(cookie.Value)
	sess, err := s.sessionRepo.FindByTokenHash(ctx, tokenHash)
	if err != nil || sess == nil {
		return nil, ErrUnauthorized
	}

	user, err := s.userRepo.FindByID(ctx, sess.UserID)
	if err != nil || user == nil {
		return nil, ErrUnauthorized
	}

	// Session refresh if threshold reached
	now := time.Now()
	if now.Sub(sess.LastSeenAt) > RefreshThreshold {
		newExpiry := now.Add(s.SessionDuration())
		_ = s.sessionRepo.Refresh(ctx, tokenHash, newExpiry, now)
		_ = s.userRepo.TouchLastSeen(ctx, user.ID, now)
	}

	return user, nil
}

// UpdateProfile updates the display name for an existing authenticated user
func (s *AuthService) UpdateProfile(ctx context.Context, userID, rawName string) (*models.SanitizedUser, error) {
	validName, err := ValidateDisplayName(rawName)
	if err != nil {
		return nil, err
	}

	user, err := s.userRepo.UpdateDisplayName(ctx, userID, validName)
	if err != nil {
		return nil, err
	}

	sanitized := user.ToSanitized()
	return &sanitized, nil
}

// Logout invalidates the active session and clears the cookie
func (s *AuthService) Logout(w http.ResponseWriter, r *http.Request) error {
	if cookie, err := r.Cookie(CookieSessionName); err == nil && strings.TrimSpace(cookie.Value) != "" {
		tokenHash := HashToken(cookie.Value)
		_ = s.sessionRepo.DeleteByTokenHash(r.Context(), tokenHash)
	}
	s.ClearSessionCookie(w)
	return nil
}

// resolveSameSite maps the configured CookieSameSite string to http.SameSite and determines if Secure is required
func (s *AuthService) resolveSameSite() (http.SameSite, bool) {
	sameSiteMode := http.SameSiteLaxMode
	secure := s.cfg.CookieSecure

	switch strings.ToLower(strings.TrimSpace(s.cfg.CookieSameSite)) {
	case "none":
		sameSiteMode = http.SameSiteNoneMode
		secure = true // RFC 6265bis: SameSite=None requires Secure
	case "strict":
		sameSiteMode = http.SameSiteStrictMode
	default:
		sameSiteMode = http.SameSiteLaxMode
	}
	return sameSiteMode, secure
}

// SetSessionCookie writes the sw_session cookie to ResponseWriter
func (s *AuthService) SetSessionCookie(w http.ResponseWriter, rawToken string) {
	maxAge := int(s.SessionDuration().Seconds())
	sameSiteMode, secure := s.resolveSameSite()

	cookie := &http.Cookie{
		Name:     CookieSessionName,
		Value:    rawToken,
		Path:     "/",
		MaxAge:   maxAge,
		Expires:  time.Now().Add(s.SessionDuration()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: sameSiteMode,
	}
	domain := strings.TrimSpace(s.cfg.CookieDomain)
	if domain != "" && !strings.EqualFold(domain, "localhost") && domain != "127.0.0.1" && strings.Contains(domain, ".") {
		cookie.Domain = domain
	}
	http.SetCookie(w, cookie)
}

// ClearSessionCookie overwrites the sw_session cookie with an expired value
func (s *AuthService) ClearSessionCookie(w http.ResponseWriter) {
	sameSiteMode, secure := s.resolveSameSite()

	cookie := &http.Cookie{
		Name:     CookieSessionName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
		HttpOnly: true,
		Secure:   secure,
		SameSite: sameSiteMode,
	}
	domain := strings.TrimSpace(s.cfg.CookieDomain)
	if domain != "" && !strings.EqualFold(domain, "localhost") && domain != "127.0.0.1" && strings.Contains(domain, ".") {
		cookie.Domain = domain
	}
	http.SetCookie(w, cookie)
}

func isPrivateOrLoopbackIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate()
}

// getClientIP extracts IP address from request (handling Cloudflare & reverse proxies safely)
func getClientIP(r *http.Request) string {
	remoteHost, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		remoteHost = strings.TrimSpace(r.RemoteAddr)
	}
	remoteIP := net.ParseIP(remoteHost)

	// If behind a trusted private/loopback reverse proxy or container gateway
	if remoteIP == nil || isPrivateOrLoopbackIP(remoteIP) {
		// 1. Cloudflare edge header (canonical when proxied)
		if cfIP := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); cfIP != "" {
			if ip := net.ParseIP(cfIP); ip != nil {
				return ip.String()
			}
		}

		// 2. Standard X-Forwarded-For
		if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
			parts := strings.Split(xff, ",")
			if len(parts) > 0 {
				first := strings.TrimSpace(parts[0])
				if ip := net.ParseIP(first); ip != nil {
					return ip.String()
				}
			}
		}

		// 3. X-Real-IP
		if xrip := strings.TrimSpace(r.Header.Get("X-Real-IP")); xrip != "" {
			if ip := net.ParseIP(xrip); ip != nil {
				return ip.String()
			}
		}
	} else {
		// Direct public connection: only Cloudflare CF-Connecting-IP takes precedence
		if cfIP := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); cfIP != "" {
			if ip := net.ParseIP(cfIP); ip != nil {
				return ip.String()
			}
		}
	}

	if remoteIP != nil {
		return remoteIP.String()
	}
	if remoteHost != "" {
		return remoteHost
	}

	return "127.0.0.1"
}
