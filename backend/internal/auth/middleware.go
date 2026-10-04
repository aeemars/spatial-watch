package auth

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/gorilla/mux"
)

type userContextKeyType struct{}

var userContextKey = userContextKeyType{}

// AuthenticatedUser contains user identity attached to request context
type AuthenticatedUser struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	IsGuest     bool   `json:"isGuest"`
}

// Middleware returns a gorilla/mux MiddlewareFunc that enforces session authentication
func Middleware(authService *AuthService) mux.MiddlewareFunc {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, err := authService.AuthenticateRequest(r)
			if err != nil {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				json.NewEncoder(w).Encode(map[string]string{
					"error": "Unauthorized",
				})
				return
			}

			authUser := &AuthenticatedUser{
				ID:          user.ID,
				DisplayName: user.DisplayName,
				IsGuest:     user.IsGuest,
			}

			ctx := context.WithValue(r.Context(), userContextKey, authUser)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetAuthenticatedUser extracts the AuthenticatedUser from request context
func GetAuthenticatedUser(ctx context.Context) (*AuthenticatedUser, bool) {
	val := ctx.Value(userContextKey)
	if val == nil {
		return nil, false
	}
	user, ok := val.(*AuthenticatedUser)
	return user, ok
}

// ContextWithUser creates a new context with the given AuthenticatedUser (useful for tests)
func ContextWithUser(parent context.Context, user *AuthenticatedUser) context.Context {
	return context.WithValue(parent, userContextKey, user)
}
