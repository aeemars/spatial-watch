package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"spatialwatch/config"
	"spatialwatch/handlers"
	"spatialwatch/internal/auth"
	"spatialwatch/models"
	"spatialwatch/repository"
	"spatialwatch/seed"
	ws "spatialwatch/websocket"
)

type testRig struct {
	Handler     *handlers.Handler
	Router      *mux.Router
	AuthService *auth.AuthService
	RoomRepo    *repository.RoomRepo
	PartRepo    *repository.ParticipantRepo
}

func setupTestRig() *testRig {
	roomRepo := repository.NewRoomRepo(nil)
	partRepo := repository.NewParticipantRepo(nil)
	commentRepo := repository.NewCommentaryRepo(nil)
	reactionRepo := repository.NewReactionRepo(nil)
	userRepo := repository.NewUserRepo(nil)
	sessionRepo := repository.NewSessionRepo(nil)

	cfg := &config.Config{
		CookieSecure:        false,
		SessionDurationDays: 30,
	}

	authService := auth.NewAuthService(userRepo, sessionRepo, cfg)
	seed.Run(commentRepo)
	hub := ws.NewHub(roomRepo, partRepo, reactionRepo)
	h := handlers.NewHandler(roomRepo, partRepo, commentRepo, reactionRepo, hub, authService, nil)

	r := mux.NewRouter()
	api := r.PathPrefix("/api").Subrouter()

	// Public Auth endpoints
	api.HandleFunc("/auth/session", h.GetSession).Methods("GET")
	api.HandleFunc("/auth/logout", h.Logout).Methods("POST")

	// Protected routes (enforced by auth middleware)
	protected := api.PathPrefix("").Subrouter()
	protected.Use(auth.Middleware(authService))
	protected.HandleFunc("/auth/profile", h.UpdateProfile).Methods("PATCH")
	protected.HandleFunc("/rooms", h.CreateRoom).Methods("POST")
	protected.HandleFunc("/rooms/join", h.JoinRoom).Methods("POST")

	// Public room endpoints
	api.HandleFunc("/rooms/{roomCode}", h.GetRoom).Methods("GET")
	api.HandleFunc("/rooms/{roomCode}/commentary", h.GetCommentary).Methods("GET")
	api.HandleFunc("/health", h.Health).Methods("GET")

	// WebSocket endpoint
	r.HandleFunc("/ws", h.HandleWebSocket).Methods("GET")

	return &testRig{
		Handler:     h,
		Router:      r,
		AuthService: authService,
		RoomRepo:    roomRepo,
		PartRepo:    partRepo,
	}
}

// Helper to obtain a guest session and its cookie
func createTestGuestSession(t *testing.T, rig *testRig) (*models.SanitizedUser, *http.Cookie) {
	req := httptest.NewRequest("GET", "/api/auth/session", nil)
	rr := httptest.NewRecorder()
	rig.Router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("Failed to create guest session, status: %d", rr.Code)
	}

	var resp models.AuthSessionResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("Failed to parse session response: %v", err)
	}

	for _, c := range rr.Result().Cookies() {
		if c.Name == auth.CookieSessionName {
			return &resp.User, c
		}
	}

	t.Fatal("sw_session cookie not returned in Set-Cookie")
	return nil, nil
}

func TestHealthEndpoint(t *testing.T) {
	rig := setupTestRig()

	req, _ := http.NewRequest("GET", "/api/health", nil)
	rr := httptest.NewRecorder()
	rig.Router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("Expected 200 OK, got %d", rr.Code)
	}

	var resp map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("Failed to parse JSON response: %v", err)
	}
	if resp["status"] != "ok" {
		t.Errorf("Expected status 'ok', got '%s'", resp["status"])
	}
}

// Protected routes must reject unauthenticated requests with 401
func TestProtectedEndpointsRejectUnauthenticated(t *testing.T) {
	rig := setupTestRig()

	endpoints := []struct {
		method string
		path   string
		body   string
	}{
		{"POST", "/api/rooms", `{"displayName":"Hacker"}`},
		{"POST", "/api/rooms/join", `{"roomCode":"SW-AB12"}`},
		{"PATCH", "/api/auth/profile", `{"displayName":"NewName"}`},
	}

	for _, ep := range endpoints {
		req, _ := http.NewRequest(ep.method, ep.path, bytes.NewBufferString(ep.body))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		rig.Router.ServeHTTP(rr, req)

		if rr.Code != http.StatusUnauthorized {
			t.Errorf("[%s %s] Expected 401 Unauthorized, got %d: %s", ep.method, ep.path, rr.Code, rr.Body.String())
		}
	}
}

// Authenticated session creates room and joins room deriving identity from session
func TestAuthenticatedCreateAndJoinRoom(t *testing.T) {
	rig := setupTestRig()

	// 1. Create Guest Host
	hostUser, hostCookie := createTestGuestSession(t, rig)

	// 2. Host creates room
	createBody, _ := json.Marshal(models.CreateRoomRequest{
		DisplayName: "Host Alice",
	})
	reqCreate, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(createBody))
	reqCreate.Header.Set("Content-Type", "application/json")
	reqCreate.AddCookie(hostCookie)
	rrCreate := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrCreate, reqCreate)

	if rrCreate.Code != http.StatusCreated {
		t.Fatalf("Expected 201 Created, got %d: %s", rrCreate.Code, rrCreate.Body.String())
	}

	var createResp models.CreateRoomResponse
	if err := json.Unmarshal(rrCreate.Body.Bytes(), &createResp); err != nil {
		t.Fatalf("Decode CreateRoom response failed: %v", err)
	}

	if createResp.RoomCode == "" {
		t.Fatal("Expected non-empty room code")
	}
	if !createResp.IsHost {
		t.Fatal("Expected creator to be host")
	}
	// Participant ID must match the authenticated host user ID (not a random ID or spoofed ID)
	if createResp.ParticipantID != hostUser.ID {
		t.Errorf("Expected host participantId to be %s, got %s", hostUser.ID, createResp.ParticipantID)
	}

	// 3. Second visitor creates guest session and joins room
	guestUser, guestCookie := createTestGuestSession(t, rig)
	if guestUser.ID == hostUser.ID {
		t.Fatal("Separate guest visits should produce distinct user IDs")
	}

	joinBody, _ := json.Marshal(models.JoinRoomRequest{
		RoomCode:    createResp.RoomCode,
		DisplayName: "Guest Bob",
	})
	reqJoin, _ := http.NewRequest("POST", "/api/rooms/join", bytes.NewBuffer(joinBody))
	reqJoin.Header.Set("Content-Type", "application/json")
	reqJoin.AddCookie(guestCookie)
	rrJoin := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrJoin, reqJoin)

	if rrJoin.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK for join, got %d: %s", rrJoin.Code, rrJoin.Body.String())
	}

	var joinResp models.JoinRoomResponse
	if err := json.Unmarshal(rrJoin.Body.Bytes(), &joinResp); err != nil {
		t.Fatalf("Decode JoinRoom response failed: %v", err)
	}

	if joinResp.ParticipantID != guestUser.ID {
		t.Errorf("Expected guest participant ID %s, got %s", guestUser.ID, joinResp.ParticipantID)
	}
	if joinResp.IsHost {
		t.Fatal("Guest should not be host")
	}

	// 4. Verify room in DB has correct HostParticipantID
	room, err := rig.RoomRepo.FindByCode(context.Background(), createResp.RoomCode)
	if err != nil {
		t.Fatalf("Room lookup failed: %v", err)
	}
	if room.HostParticipantID != hostUser.ID {
		t.Errorf("Room host mismatch: expected %s, got %s", hostUser.ID, room.HostParticipantID)
	}
}

// Profile update requires authentication and validates input
func TestProfileUpdateEndpoint(t *testing.T) {
	rig := setupTestRig()
	_, cookie := createTestGuestSession(t, rig)

	// Valid update
	body, _ := json.Marshal(models.UpdateProfileRequest{DisplayName: "Cosmic Director"})
	req, _ := http.NewRequest("PATCH", "/api/auth/profile", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	rr := httptest.NewRecorder()
	rig.Router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp models.UpdateProfileResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("Decode failed: %v", err)
	}
	if resp.User.DisplayName != "Cosmic Director" {
		t.Errorf("Expected Cosmic Director, got %s", resp.User.DisplayName)
	}

	// Invalid update: unsafe HTML
	bodyHTML, _ := json.Marshal(models.UpdateProfileRequest{DisplayName: "<script>alert(1)</script>"})
	reqHTML, _ := http.NewRequest("PATCH", "/api/auth/profile", bytes.NewBuffer(bodyHTML))
	reqHTML.Header.Set("Content-Type", "application/json")
	reqHTML.AddCookie(cookie)
	rrHTML := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrHTML, reqHTML)

	if rrHTML.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 Bad Request for HTML, got %d", rrHTML.Code)
	}
}

// WebSocket authentication via sw_session cookie
func TestWebSocketAuthentication(t *testing.T) {
	rig := setupTestRig()
	server := httptest.NewServer(rig.Router)
	defer server.Close()

	// 1. Create a room first
	hostUser, hostCookie := createTestGuestSession(t, rig)
	createBody, _ := json.Marshal(models.CreateRoomRequest{DisplayName: "WS Host"})
	reqCreate, _ := http.NewRequest("POST", server.URL+"/api/rooms", bytes.NewBuffer(createBody))
	reqCreate.Header.Set("Content-Type", "application/json")
	reqCreate.AddCookie(hostCookie)
	resCreate, err := http.DefaultClient.Do(reqCreate)
	if err != nil {
		t.Fatalf("Create room failed: %v", err)
	}
	defer resCreate.Body.Close()

	var createResp models.CreateRoomResponse
	json.NewDecoder(resCreate.Body).Decode(&createResp)
	roomCode := createResp.RoomCode

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws?roomCode=" + roomCode

	// 2. Connection WITHOUT cookie should be rejected with 401
	_, respNoCookie, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err == nil {
		t.Fatal("Expected error connecting to WS without session cookie")
	}
	if respNoCookie != nil && respNoCookie.StatusCode != http.StatusUnauthorized {
		t.Errorf("Expected 401 Unauthorized, got %d", respNoCookie.StatusCode)
	}

	// 3. Connection WITH valid cookie should succeed
	header := http.Header{}
	header.Add("Cookie", hostCookie.String())

	conn, respCookie, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		t.Fatalf("WS connection with cookie failed: %v (status: %v)", err, respCookie)
	}
	defer conn.Close()

	if respCookie.StatusCode != http.StatusSwitchingProtocols {
		t.Errorf("Expected 101 Switching Protocols, got %d", respCookie.StatusCode)
	}

	_ = hostUser
}
