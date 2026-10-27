package ratelimit

import (
	"net"
	"net/http"
	"strings"
)

// ClientIP extracts the real client IP address from the HTTP request,
// prioritizing Cloudflare's CF-Connecting-IP header and safely evaluating proxy headers.
func ClientIP(r *http.Request) string {
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

	// 4. RemoteAddr
	remoteHost, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		if ip := net.ParseIP(remoteHost); ip != nil {
			return ip.String()
		}
		return remoteHost
	}

	trimmed := strings.TrimSpace(r.RemoteAddr)
	if ip := net.ParseIP(trimmed); ip != nil {
		return ip.String()
	}

	return "127.0.0.1"
}
