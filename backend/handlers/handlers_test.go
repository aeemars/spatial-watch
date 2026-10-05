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
	mediaRepo := repository.NewMediaAssetRepo(nil)

	cfg := &config.Config{
		CookieSecure:        false,
		SessionDurationDays: 30,
	}

	authService := auth.NewAuthService(userRepo, sessionRepo, cfg)
	seed.Run(commentRepo, mediaRepo)
	hub := ws.NewHub(roomRepo, partRepo, reactionRepo)
	h := handlers.NewHandler(roomRepo, partRepo, commentRepo, reactionRepo, hub, authService, mediaRepo, nil)

	r := mux.NewRouter()
	api := r.PathPrefix("/api").Subrouter()

	// Public Auth endpoints
	api.HandleFunc("/auth/session", h.GetSession).Methods("GET")
	api.HandleFunc("/auth/logout", h.Logout).Methods("POST")

	// Media Catalog
	api.HandleFunc("/media-assets", h.GetMediaAssets).Methods("GET")

	// Protected routes (enforced by auth middleware)
	protected := api.PathPrefix("").Subrouter()
	protected.Use(auth.Middleware(authService))
	protected.HandleFunc("/auth/profile", h.UpdateProfile).Methods("PATCH")
	protected.HandleFunc("/user/rooms", h.GetUserRooms).Methods("GET")
	protected.HandleFunc("/rooms", h.CreateRoom).Methods("POST")
	protected.HandleFunc("/rooms/join", h.JoinRoom).Methods("POST")
	protected.HandleFunc("/rooms/{roomCode}", h.ShutdownRoom).Methods("DELETE")
	protected.HandleFunc("/rooms/{roomCode}/leave", h.LeaveRoom).Methods("POST")

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
		RoomName:    "Alice's Cinema",
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
	createBody, _ := json.Marshal(models.CreateRoomRequest{
		RoomName:    "WS Screening",
		DisplayName: "WS Host",
	})
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

// Enforces room name uniqueness across active rooms (case-insensitive)
func TestRoomNameDuplicationCheck(t *testing.T) {
	rig := setupTestRig()

	_, cookie1 := createTestGuestSession(t, rig)
	_, cookie2 := createTestGuestSession(t, rig)

	// 1. Create first room with name "Cosmic Cinema"
	body1, _ := json.Marshal(models.CreateRoomRequest{
		RoomName:    "Cosmic Cinema",
		DisplayName: "Host One",
	})
	req1, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(body1))
	req1.Header.Set("Content-Type", "application/json")
	req1.AddCookie(cookie1)
	rr1 := httptest.NewRecorder()
	rig.Router.ServeHTTP(rr1, req1)

	if rr1.Code != http.StatusCreated {
		t.Fatalf("Expected 201 Created for first room, got %d: %s", rr1.Code, rr1.Body.String())
	}

	// 2. Attempt to create another room with the exact same name (even case-differed)
	body2, _ := json.Marshal(models.CreateRoomRequest{
		RoomName:    "  cosmic cinema  ",
		DisplayName: "Host Two",
	})
	req2, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(body2))
	req2.Header.Set("Content-Type", "application/json")
	req2.AddCookie(cookie2)
	rr2 := httptest.NewRecorder()
	rig.Router.ServeHTTP(rr2, req2)

	if rr2.Code != http.StatusConflict {
		t.Fatalf("Expected 409 Conflict for duplicate room name, got %d: %s", rr2.Code, rr2.Body.String())
	}

	// 3. Create room with a unique name should succeed
	body3, _ := json.Marshal(models.CreateRoomRequest{
		RoomName:    "Solar Cinema",
		DisplayName: "Host Two",
	})
	req3, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(body3))
	req3.Header.Set("Content-Type", "application/json")
	req3.AddCookie(cookie2)
	rr3 := httptest.NewRecorder()
	rig.Router.ServeHTTP(rr3, req3)

	if rr3.Code != http.StatusCreated {
		t.Fatalf("Expected 201 Created for unique room name, got %d: %s", rr3.Code, rr3.Body.String())
	}
}

// User can view all created and joined rooms with continued access
func TestUserRoomsRecordsAndContinuedAccess(t *testing.T) {
	rig := setupTestRig()

	_, hostCookie := createTestGuestSession(t, rig)
	_, guestCookie := createTestGuestSession(t, rig)

	// 1. Host creates Room A
	bodyA, _ := json.Marshal(models.CreateRoomRequest{
		RoomName:    "Alpha Screening",
		DisplayName: "Host User",
	})
	reqA, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(bodyA))
	reqA.Header.Set("Content-Type", "application/json")
	reqA.AddCookie(hostCookie)
	rrA := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrA, reqA)

	var respA models.CreateRoomResponse
	json.Unmarshal(rrA.Body.Bytes(), &respA)

	// 2. Guest joins Room A
	joinBody, _ := json.Marshal(models.JoinRoomRequest{
		RoomCode:    respA.RoomCode,
		DisplayName: "Guest User",
	})
	reqJoin, _ := http.NewRequest("POST", "/api/rooms/join", bytes.NewBuffer(joinBody))
	reqJoin.Header.Set("Content-Type", "application/json")
	reqJoin.AddCookie(guestCookie)
	rrJoin := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrJoin, reqJoin)

	if rrJoin.Code != http.StatusOK {
		t.Fatalf("Guest join room failed: %d", rrJoin.Code)
	}

	// 3. Guest creates their own Room B
	bodyB, _ := json.Marshal(models.CreateRoomRequest{
		RoomName:    "Beta Screening",
		DisplayName: "Guest User",
	})
	reqB, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(bodyB))
	reqB.Header.Set("Content-Type", "application/json")
	reqB.AddCookie(guestCookie)
	rrB := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrB, reqB)

	// 4. Query guest's user rooms records: should have 1 created room (Beta) and 1 joined room (Alpha)
	reqRecords, _ := http.NewRequest("GET", "/api/user/rooms", nil)
	reqRecords.AddCookie(guestCookie)
	rrRecords := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrRecords, reqRecords)

	if rrRecords.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK for /api/user/rooms, got %d: %s", rrRecords.Code, rrRecords.Body.String())
	}

	var userRooms models.UserRoomsResponse
	if err := json.Unmarshal(rrRecords.Body.Bytes(), &userRooms); err != nil {
		t.Fatalf("Failed to decode user rooms response: %v", err)
	}

	if len(userRooms.CreatedRooms) != 1 {
		t.Fatalf("Expected 1 created room for guest, got %d", len(userRooms.CreatedRooms))
	}
	if userRooms.CreatedRooms[0].Name != "Beta Screening" {
		t.Errorf("Expected created room 'Beta Screening', got %s", userRooms.CreatedRooms[0].Name)
	}

	if len(userRooms.JoinedRooms) != 1 {
		t.Fatalf("Expected 1 joined room for guest, got %d", len(userRooms.JoinedRooms))
	}
	if userRooms.JoinedRooms[0].RoomCode != respA.RoomCode {
		t.Errorf("Expected joined room %s, got %s", respA.RoomCode, userRooms.JoinedRooms[0].RoomCode)
	}
	if userRooms.JoinedRooms[0].Name != "Alpha Screening" {
		t.Errorf("Expected joined room name 'Alpha Screening', got %s", userRooms.JoinedRooms[0].Name)
	}

	// 5. Query host's user rooms records: should have 1 created room (Alpha) and 0 joined rooms
	reqHostRecords, _ := http.NewRequest("GET", "/api/user/rooms", nil)
	reqHostRecords.AddCookie(hostCookie)
	rrHostRecords := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrHostRecords, reqHostRecords)

	var hostRooms models.UserRoomsResponse
	json.Unmarshal(rrHostRecords.Body.Bytes(), &hostRooms)

	if len(hostRooms.CreatedRooms) != 1 || hostRooms.CreatedRooms[0].RoomCode != respA.RoomCode {
		t.Fatalf("Expected 1 created room for host, got %d", len(hostRooms.CreatedRooms))
	}
	if len(hostRooms.JoinedRooms) != 0 {
		t.Fatalf("Expected 0 joined rooms for host, got %d", len(hostRooms.JoinedRooms))
	}
}

// Guest can leave a joined room, removing it from their active joined records
func TestGuestLeaveRoom(t *testing.T) {
	rig := setupTestRig()

	_, hostCookie := createTestGuestSession(t, rig)
	_, guestCookie := createTestGuestSession(t, rig)

	// Create room
	body, _ := json.Marshal(models.CreateRoomRequest{
		RoomName:    "Gamma Screening",
		DisplayName: "Host",
	})
	req, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(hostCookie)
	rr := httptest.NewRecorder()
	rig.Router.ServeHTTP(rr, req)

	var createResp models.CreateRoomResponse
	json.Unmarshal(rr.Body.Bytes(), &createResp)

	// Guest joins
	joinBody, _ := json.Marshal(models.JoinRoomRequest{
		RoomCode:    createResp.RoomCode,
		DisplayName: "Guest",
	})
	reqJoin, _ := http.NewRequest("POST", "/api/rooms/join", bytes.NewBuffer(joinBody))
	reqJoin.Header.Set("Content-Type", "application/json")
	reqJoin.AddCookie(guestCookie)
	rrJoin := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrJoin, reqJoin)

	// Verify room appears in guest's joined records
	reqRec1, _ := http.NewRequest("GET", "/api/user/rooms", nil)
	reqRec1.AddCookie(guestCookie)
	rrRec1 := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrRec1, reqRec1)
	var rec1 models.UserRoomsResponse
	json.Unmarshal(rrRec1.Body.Bytes(), &rec1)
	if len(rec1.JoinedRooms) != 1 {
		t.Fatalf("Expected 1 joined room before leaving, got %d", len(rec1.JoinedRooms))
	}

	// Guest leaves room
	reqLeave, _ := http.NewRequest("POST", "/api/rooms/"+createResp.RoomCode+"/leave", nil)
	reqLeave.AddCookie(guestCookie)
	rrLeave := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrLeave, reqLeave)

	if rrLeave.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK for leave room, got %d: %s", rrLeave.Code, rrLeave.Body.String())
	}

	// Verify room NO LONGER appears in guest's joined records
	reqRec2, _ := http.NewRequest("GET", "/api/user/rooms", nil)
	reqRec2.AddCookie(guestCookie)
	rrRec2 := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrRec2, reqRec2)
	var rec2 models.UserRoomsResponse
	json.Unmarshal(rrRec2.Body.Bytes(), &rec2)
	if len(rec2.JoinedRooms) != 0 {
		t.Fatalf("Expected 0 joined rooms after leaving, got %d", len(rec2.JoinedRooms))
	}
}

// Host can shut down / delete room, preventing further access and removing from records
func TestHostShutdownRoom(t *testing.T) {
	rig := setupTestRig()

	_, hostCookie := createTestGuestSession(t, rig)
	_, guestCookie := createTestGuestSession(t, rig)

	// Host creates room
	body, _ := json.Marshal(models.CreateRoomRequest{
		RoomName:    "Delta Screening",
		DisplayName: "Host",
	})
	req, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(hostCookie)
	rr := httptest.NewRecorder()
	rig.Router.ServeHTTP(rr, req)

	var createResp models.CreateRoomResponse
	json.Unmarshal(rr.Body.Bytes(), &createResp)

	// Guest joins
	joinBody, _ := json.Marshal(models.JoinRoomRequest{
		RoomCode:    createResp.RoomCode,
		DisplayName: "Guest",
	})
	reqJoin, _ := http.NewRequest("POST", "/api/rooms/join", bytes.NewBuffer(joinBody))
	reqJoin.Header.Set("Content-Type", "application/json")
	reqJoin.AddCookie(guestCookie)
	rrJoin := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrJoin, reqJoin)

	// Non-host attempts to shut down room -> 403 Forbidden
	reqShutdownGuest, _ := http.NewRequest("DELETE", "/api/rooms/"+createResp.RoomCode, nil)
	reqShutdownGuest.AddCookie(guestCookie)
	rrShutdownGuest := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrShutdownGuest, reqShutdownGuest)
	if rrShutdownGuest.Code != http.StatusForbidden {
		t.Fatalf("Expected 403 Forbidden when non-host deletes room, got %d", rrShutdownGuest.Code)
	}

	// Host shuts down room -> 200 OK
	reqShutdown, _ := http.NewRequest("DELETE", "/api/rooms/"+createResp.RoomCode, nil)
	reqShutdown.AddCookie(hostCookie)
	rrShutdown := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrShutdown, reqShutdown)
	if rrShutdown.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK when host shuts down room, got %d: %s", rrShutdown.Code, rrShutdown.Body.String())
	}

	// GetRoom on shutdown room returns 404
	reqGet, _ := http.NewRequest("GET", "/api/rooms/"+createResp.RoomCode, nil)
	rrGet := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrGet, reqGet)
	if rrGet.Code != http.StatusNotFound {
		t.Fatalf("Expected 404 Not Found for shut down room, got %d", rrGet.Code)
	}

	// Host records show 0 created rooms
	reqHostRec, _ := http.NewRequest("GET", "/api/user/rooms", nil)
	reqHostRec.AddCookie(hostCookie)
	rrHostRec := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrHostRec, reqHostRec)
	var hostRec models.UserRoomsResponse
	json.Unmarshal(rrHostRec.Body.Bytes(), &hostRec)
	if len(hostRec.CreatedRooms) != 0 {
		t.Fatalf("Expected 0 created rooms after shutdown, got %d", len(hostRec.CreatedRooms))
	}

	// Guest records show 0 joined rooms
	reqGuestRec, _ := http.NewRequest("GET", "/api/user/rooms", nil)
	reqGuestRec.AddCookie(guestCookie)
	rrGuestRec := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrGuestRec, reqGuestRec)
	var guestRec models.UserRoomsResponse
	json.Unmarshal(rrGuestRec.Body.Bytes(), &guestRec)
	if len(guestRec.JoinedRooms) != 0 {
		t.Fatalf("Expected 0 joined rooms for guest after room shutdown, got %d", len(guestRec.JoinedRooms))
	}
}

func TestGetMediaAssetsCatalog(t *testing.T) {
	rig := setupTestRig()

	req, _ := http.NewRequest("GET", "/api/media-assets", nil)
	rr := httptest.NewRecorder()
	rig.Router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK from GET /api/media-assets, got %d", rr.Code)
	}

	var assets []models.MediaAsset
	if err := json.Unmarshal(rr.Body.Bytes(), &assets); err != nil {
		t.Fatalf("Failed to decode media assets: %v", err)
	}

	if len(assets) < 4 {
		t.Fatalf("Expected at least 4 catalog assets seeded, got %d", len(assets))
	}

	foundBBB := false
	for _, a := range assets {
		if a.AssetID == "big-buck-bunny" {
			foundBBB = true
			if !strings.HasPrefix(a.MediaURL, "https://") || !strings.HasSuffix(a.MediaURL, ".mp4") {
				t.Fatalf("Big Buck Bunny URL must be HTTPS MP4, got %s", a.MediaURL)
			}
			if !a.CORSReady {
				t.Fatalf("Expected Big Buck Bunny to have CORSReady = true")
			}
			if !a.DirectorCutAvailable {
				t.Fatalf("Expected Big Buck Bunny to have DirectorCutAvailable = true")
			}
		}
	}
	if !foundBBB {
		t.Fatalf("Seeded catalog must contain big-buck-bunny")
	}
}

func TestCreateRoom_DefaultMedia(t *testing.T) {
	rig := setupTestRig()
	_, cookie := createTestGuestSession(t, rig)

	body, _ := json.Marshal(models.CreateRoomRequest{
		RoomName: "Default Media Room",
	})
	req, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	rr := httptest.NewRecorder()
	rig.Router.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("Expected 201 Created, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp models.CreateRoomResponse
	json.Unmarshal(rr.Body.Bytes(), &resp)

	if resp.MediaSourceType != "catalog" {
		t.Fatalf("Expected mediaSourceType 'catalog', got %q", resp.MediaSourceType)
	}
	if resp.MediaAssetID != "big-buck-bunny" {
		t.Fatalf("Expected default mediaAssetId 'big-buck-bunny', got %q", resp.MediaAssetID)
	}
	if resp.MediaTitle != "Big Buck Bunny" {
		t.Fatalf("Expected default mediaTitle 'Big Buck Bunny', got %q", resp.MediaTitle)
	}
	if resp.DurationSeconds <= 0 {
		t.Fatalf("Expected positive durationSeconds for default media, got %f", resp.DurationSeconds)
	}
}

func TestCreateRoom_CatalogSelection(t *testing.T) {
	rig := setupTestRig()
	_, cookie := createTestGuestSession(t, rig)

	body, _ := json.Marshal(models.CreateRoomRequest{
		RoomName:     "Tears of Steel Cinema",
		MediaAssetID: "tears-of-steel",
	})
	req, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	rr := httptest.NewRecorder()
	rig.Router.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("Expected 201 Created, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp models.CreateRoomResponse
	json.Unmarshal(rr.Body.Bytes(), &resp)

	if resp.MediaSourceType != "catalog" {
		t.Fatalf("Expected mediaSourceType 'catalog', got %q", resp.MediaSourceType)
	}
	if resp.MediaAssetID != "tears-of-steel" {
		t.Fatalf("Expected mediaAssetId 'tears-of-steel', got %q", resp.MediaAssetID)
	}
	if resp.MediaTitle != "Tears of Steel" {
		t.Fatalf("Expected mediaTitle 'Tears of Steel', got %q", resp.MediaTitle)
	}
	if resp.DurationSeconds != 734 {
		t.Fatalf("Expected duration 734s, got %f", resp.DurationSeconds)
	}
}

func TestCreateRoom_UnknownCatalogAsset(t *testing.T) {
	rig := setupTestRig()
	_, cookie := createTestGuestSession(t, rig)

	body, _ := json.Marshal(models.CreateRoomRequest{
		RoomName:     "Non-existent Film Room",
		MediaAssetID: "non-existent-film",
	})
	req, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	rr := httptest.NewRecorder()
	rig.Router.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400 Bad Request for unknown mediaAssetId, got %d", rr.Code)
	}
}

func TestCreateRoom_CustomHostedMP4(t *testing.T) {
	rig := setupTestRig()
	_, cookie := createTestGuestSession(t, rig)

	body, _ := json.Marshal(models.CreateRoomRequest{
		RoomName:   "Indie Screening",
		MediaURL:   "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
		MediaTitle: "Sintel (Indie Premiere)",
	})
	req, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	rr := httptest.NewRecorder()
	rig.Router.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("Expected 201 Created for valid custom MP4, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp models.CreateRoomResponse
	json.Unmarshal(rr.Body.Bytes(), &resp)

	if resp.MediaSourceType != "custom" {
		t.Fatalf("Expected mediaSourceType 'custom', got %q", resp.MediaSourceType)
	}
	if resp.MediaTitle != "Sintel (Indie Premiere)" {
		t.Fatalf("Expected custom title to be preserved, got %q", resp.MediaTitle)
	}
	if resp.MediaURL != "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4" {
		t.Fatalf("Expected custom URL to be preserved, got %q", resp.MediaURL)
	}
}

func TestCreateRoom_InvalidCustomMedia(t *testing.T) {
	rig := setupTestRig()
	_, cookie := createTestGuestSession(t, rig)

	tests := []struct {
		name       string
		url        string
		title      string
		expectCode int
	}{
		{
			name:       "Insecure HTTP URL",
			url:        "http://commondatastorage.googleapis.com/video.mp4",
			title:      "Insecure Video",
			expectCode: http.StatusBadRequest,
		},
		{
			name:       "Non-MP4 URL",
			url:        "https://commondatastorage.googleapis.com/video.mkv",
			title:      "MKV Video",
			expectCode: http.StatusBadRequest,
		},
		{
			name:       "Missing title with URL",
			url:        "https://commondatastorage.googleapis.com/video.mp4",
			title:      "",
			expectCode: http.StatusBadRequest,
		},
		{
			name:       "Missing URL with title",
			url:        "",
			title:      "Custom Video",
			expectCode: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(models.CreateRoomRequest{
				RoomName:   "Test Room",
				MediaURL:   tc.url,
				MediaTitle: tc.title,
			})
			req, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(body))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(cookie)
			rr := httptest.NewRecorder()
			rig.Router.ServeHTTP(rr, req)

			if rr.Code != tc.expectCode {
				t.Fatalf("[%s] Expected status %d, got %d: %s", tc.name, tc.expectCode, rr.Code, rr.Body.String())
			}
		})
	}
}

func TestCreateRoom_MutuallyExclusiveMedia(t *testing.T) {
	rig := setupTestRig()
	_, cookie := createTestGuestSession(t, rig)

	body, _ := json.Marshal(models.CreateRoomRequest{
		RoomName:     "Conflict Room",
		MediaAssetID: "big-buck-bunny",
		MediaURL:     "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
		MediaTitle:   "Sintel",
	})
	req, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	rr := httptest.NewRecorder()
	rig.Router.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400 Bad Request when specifying both mediaAssetId and mediaUrl, got %d", rr.Code)
	}
}

func TestGetUserRooms_IncludesMediaSnapshot(t *testing.T) {
	rig := setupTestRig()
	_, cookie := createTestGuestSession(t, rig)

	body, _ := json.Marshal(models.CreateRoomRequest{
		RoomName:     "Catalog Screening Room",
		MediaAssetID: "sintel",
	})
	req, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	rr := httptest.NewRecorder()
	rig.Router.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("Expected 201 Created, got %d: %s", rr.Code, rr.Body.String())
	}

	// Fetch user rooms
	reqRooms, _ := http.NewRequest("GET", "/api/user/rooms", nil)
	reqRooms.AddCookie(cookie)
	rrRooms := httptest.NewRecorder()
	rig.Router.ServeHTTP(rrRooms, reqRooms)

	if rrRooms.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK from GET /api/user/rooms, got %d", rrRooms.Code)
	}

	var userRooms models.UserRoomsResponse
	if err := json.Unmarshal(rrRooms.Body.Bytes(), &userRooms); err != nil {
		t.Fatalf("Failed to parse user rooms: %v", err)
	}

	if len(userRooms.CreatedRooms) != 1 {
		t.Fatalf("Expected 1 created room, got %d", len(userRooms.CreatedRooms))
	}

	record := userRooms.CreatedRooms[0]
	if record.MediaTitle != "Sintel" {
		t.Fatalf("Expected mediaTitle 'Sintel', got %q", record.MediaTitle)
	}
	if record.MediaSourceType != "catalog" {
		t.Fatalf("Expected mediaSourceType 'catalog', got %q", record.MediaSourceType)
	}
	if record.MediaAssetID != "sintel" {
		t.Fatalf("Expected mediaAssetId 'sintel', got %q", record.MediaAssetID)
	}
	if record.DurationSeconds != 888 {
		t.Fatalf("Expected duration 888s, got %f", record.DurationSeconds)
	}
}
