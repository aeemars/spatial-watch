package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"strings"
	"unicode"
)

var (
	ErrInvalidDisplayName = errors.New("display name must be 2-32 characters without control characters or HTML")
	ErrInvalidRoomName    = errors.New("room name must be 2-50 characters without control characters or HTML")
	ErrInvalidCustomMedia = errors.New("custom media must be a valid HTTPS URL pointing to an .mp4 file with a valid title")
)

// GenerateToken generates a cryptographically secure, opaque random session token
// using at least 32 bytes of entropy.
func GenerateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	// RawURLEncoding produces 43 URL-safe characters without padding
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// HashToken computes the SHA-256 hex digest of a session token
func HashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// GenerateUUIDv4 generates an immutable RFC 4122 Version 4 UUID using crypto/rand
func GenerateUUIDv4() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // Version 4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// Curated lists for cinema-themed pleasant guest names
var guestAdjectives = []string{
	"Cinema", "Quiet", "Cosmic", "Velvet", "Lunar",
	"Radiant", "Mystic", "Solar", "Golden", "Stellar",
	"Emerald", "Amber", "Cobalt", "Neon", "Silver",
	"Echo", "Horizon", "Prism", "Midnight", "Astral",
}

var guestNouns = []string{
	"Fox", "Comet", "Owl", "Falcon", "Lynx",
	"Hawk", "Otter", "Wolf", "Star", "Nebula",
	"Phoenix", "Voyager", "Seeker", "Orbit", "Nomad",
	"Director", "Viewer", "Spectator", "Drifter", "Pioneer",
}

// GenerateGuestName returns a pleasant guest display name like "Cinema Fox" or "Quiet Comet"
func GenerateGuestName() string {
	adjIdx, err := rand.Int(rand.Reader, big.NewInt(int64(len(guestAdjectives))))
	if err != nil {
		return "Cinema Guest"
	}
	nounIdx, err := rand.Int(rand.Reader, big.NewInt(int64(len(guestNouns))))
	if err != nil {
		return "Cinema Guest"
	}
	return guestAdjectives[adjIdx.Int64()] + " " + guestNouns[nounIdx.Int64()]
}

// ValidateDisplayName ensures a display name meets requirements:
// - Trimmed whitespace
// - 2 to 32 visible characters
// - No control characters
// - No unsafe HTML characters (< or >)
func ValidateDisplayName(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	runes := []rune(trimmed)
	if len(runes) < 2 || len(runes) > 32 {
		return "", ErrInvalidDisplayName
	}

	for _, r := range runes {
		if unicode.IsControl(r) {
			return "", ErrInvalidDisplayName
		}
		if r == '<' || r == '>' {
			return "", ErrInvalidDisplayName
		}
	}

	return trimmed, nil
}

// ValidateRoomName ensures a room name meets consistency and safety requirements:
// - Trimmed whitespace and collapsed multiple spaces
// - 2 to 50 characters
// - At least one letter or digit
// - No control characters
// - No unsafe HTML characters (< or >)
func ValidateRoomName(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", ErrInvalidRoomName
	}

	// Reject control characters or HTML brackets
	for _, r := range trimmed {
		if unicode.IsControl(r) || r == '<' || r == '>' {
			return "", ErrInvalidRoomName
		}
	}

	// Normalize multiple whitespace to single space
	parts := strings.Fields(trimmed)
	normalized := strings.Join(parts, " ")

	runes := []rune(normalized)
	if len(runes) < 2 || len(runes) > 50 {
		return "", ErrInvalidRoomName
	}

	hasAlphanumeric := false
	for _, r := range runes {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			hasAlphanumeric = true
			break
		}
	}

	if !hasAlphanumeric {
		return "", ErrInvalidRoomName
	}

	return normalized, nil
}

// ValidateCustomMedia validates host-provided custom media:
// - URL must be https://
// - Path must end with .mp4 (case-insensitive)
// - Title must be 2 to 100 characters without control characters or HTML brackets
func ValidateCustomMedia(rawURL, rawTitle string) (string, string, error) {
	trimmedURL := strings.TrimSpace(rawURL)
	trimmedTitle := strings.TrimSpace(rawTitle)

	if trimmedURL == "" || trimmedTitle == "" {
		return "", "", ErrInvalidCustomMedia
	}

	u, err := url.Parse(trimmedURL)
	if err != nil {
		return "", "", ErrInvalidCustomMedia
	}

	isHTTPS := u.Scheme == "https" && u.Host != ""
	isLocalDev := (u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1")) || (u.Scheme == "" && strings.HasPrefix(trimmedURL, "/"))
	if !isHTTPS && !isLocalDev {
		return "", "", ErrInvalidCustomMedia
	}

	// Must have .mp4 extension
	lowerPath := strings.ToLower(u.Path)
	if !strings.HasSuffix(lowerPath, ".mp4") {
		return "", "", ErrInvalidCustomMedia
	}

	// Validate title: 2-100 characters, no control chars or HTML
	for _, r := range trimmedTitle {
		if unicode.IsControl(r) || r == '<' || r == '>' {
			return "", "", ErrInvalidCustomMedia
		}
	}

	parts := strings.Fields(trimmedTitle)
	normalizedTitle := strings.Join(parts, " ")
	runes := []rune(normalizedTitle)
	if len(runes) < 2 || len(runes) > 100 {
		return "", "", ErrInvalidCustomMedia
	}

	hasAlphanumeric := false
	for _, r := range runes {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			hasAlphanumeric = true
			break
		}
	}
	if !hasAlphanumeric {
		return "", "", ErrInvalidCustomMedia
	}

	return trimmedURL, normalizedTitle, nil
}

