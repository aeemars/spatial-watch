package handlers_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"
	"spatialwatch/handlers"
	"spatialwatch/models"
	"spatialwatch/repository"
	"spatialwatch/seed"
	ws "spatialwatch/websocket"
)

func setupTestHandler() (*handlers.Handler, *mux.Router) {
	roomRepo := repository.NewRoomRepo(nil)
	partRepo := repository.NewParticipantRepo(nil)
	commentRepo := repository.NewCommentaryRepo(nil)
	reactionRepo := repository.NewReactionRepo(nil)

	seed.Run(commentRepo)
	hub := ws.NewHub(roomRepo, partRepo, reactionRepo)
	h := handlers.NewHandler(roomRepo, partRepo, commentRepo, reactionRepo, hub)

	r := mux.NewRouter()
	api := r.PathPrefix("/api").Subrouter()
	api.HandleFunc("/rooms", h.CreateRoom).Methods("POST")
	api.HandleFunc("/rooms/join", h.JoinRoom).Methods("POST")
	api.HandleFunc("/rooms/{roomCode}", h.GetRoom).Methods("GET")
	api.HandleFunc("/rooms/{roomCode}/commentary", h.GetCommentary).Methods("GET")
	api.HandleFunc("/health", h.Health).Methods("GET")

	return h, r
}

func TestHealthEndpoint(t *testing.T) {
	_, r := setupTestHandler()

	req, _ := http.NewRequest("GET", "/api/health", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

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

func TestCreateAndJoinRoom(t *testing.T) {
	_, r := setupTestHandler()

	// 1. Create Room
	createPayload := models.CreateRoomRequest{
		DisplayName: "Director Alice",
	}
	body, _ := json.Marshal(createPayload)
	req, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("Expected 201 Created, got %d: %s", rr.Code, rr.Body.String())
	}

	var createResp models.CreateRoomResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &createResp); err != nil {
		t.Fatalf("Failed to decode CreateRoom response: %v", err)
	}

	if createResp.RoomCode == "" {
		t.Fatal("Expected room code in response")
	}
	if !createResp.IsHost {
		t.Fatal("Creator must be host")
	}

	// 2. Get Room details
	reqGet, _ := http.NewRequest("GET", "/api/rooms/"+createResp.RoomCode, nil)
	rrGet := httptest.NewRecorder()
	r.ServeHTTP(rrGet, reqGet)

	if rrGet.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK for GetRoom, got %d: %s", rrGet.Code, rrGet.Body.String())
	}

	var getPayload struct {
		Room         models.Room          `json:"room"`
		Participants []models.Participant `json:"participants"`
		ActiveCount  int                  `json:"activeCount"`
	}
	if err := json.Unmarshal(rrGet.Body.Bytes(), &getPayload); err != nil {
		t.Fatalf("Failed to decode Room response: %v", err)
	}
	if getPayload.Room.RoomCode != createResp.RoomCode {
		t.Errorf("Expected room code %s, got %s", createResp.RoomCode, getPayload.Room.RoomCode)
	}
	if len(getPayload.Participants) != 1 {
		t.Errorf("Expected 1 participant initially, got %d", len(getPayload.Participants))
	}

	// 3. Join Room
	joinPayload := models.JoinRoomRequest{
		RoomCode:    createResp.RoomCode,
		DisplayName: "Guest Bob",
	}
	joinBody, _ := json.Marshal(joinPayload)
	reqJoin, _ := http.NewRequest("POST", "/api/rooms/join", bytes.NewBuffer(joinBody))
	reqJoin.Header.Set("Content-Type", "application/json")
	rrJoin := httptest.NewRecorder()
	r.ServeHTTP(rrJoin, reqJoin)

	if rrJoin.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK for JoinRoom, got %d: %s", rrJoin.Code, rrJoin.Body.String())
	}

	var joinResp models.JoinRoomResponse
	if err := json.Unmarshal(rrJoin.Body.Bytes(), &joinResp); err != nil {
		t.Fatalf("Failed to decode JoinRoom response: %v", err)
	}
	if joinResp.IsHost {
		t.Error("Guest should not be host")
	}

	// 4. Verify 2 participants now
	reqGet2, _ := http.NewRequest("GET", "/api/rooms/"+createResp.RoomCode, nil)
	rrGet2 := httptest.NewRecorder()
	r.ServeHTTP(rrGet2, reqGet2)

	var getPayload2 struct {
		Room         models.Room          `json:"room"`
		Participants []models.Participant `json:"participants"`
		ActiveCount  int                  `json:"activeCount"`
	}
	json.Unmarshal(rrGet2.Body.Bytes(), &getPayload2)
	if len(getPayload2.Participants) != 2 {
		t.Errorf("Expected 2 participants after join, got %d", len(getPayload2.Participants))
	}

	// 5. Get Commentary cues
	reqCom, _ := http.NewRequest("GET", "/api/rooms/"+createResp.RoomCode+"/commentary", nil)
	rrCom := httptest.NewRecorder()
	r.ServeHTTP(rrCom, reqCom)

	if rrCom.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK for commentary, got %d", rrCom.Code)
	}
	var comPayload struct {
		Cues []models.CommentaryCue `json:"cues"`
	}
	if err := json.Unmarshal(rrCom.Body.Bytes(), &comPayload); err != nil {
		t.Fatalf("Failed to decode commentary: %v", err)
	}
	if len(comPayload.Cues) == 0 {
		t.Error("Expected seeded commentary cues to be returned")
	}
}

func TestCreateRoomValidation(t *testing.T) {
	_, r := setupTestHandler()

	// Empty display name should fail
	createPayload := models.CreateRoomRequest{
		DisplayName: "   ",
	}
	body, _ := json.Marshal(createPayload)
	req, _ := http.NewRequest("POST", "/api/rooms", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 Bad Request for empty name, got %d", rr.Code)
	}
}

func TestJoinNonExistentRoom(t *testing.T) {
	_, r := setupTestHandler()

	joinPayload := models.JoinRoomRequest{
		RoomCode:    "SW-FAKE",
		DisplayName: "Visitor",
	}
	body, _ := json.Marshal(joinPayload)
	req, _ := http.NewRequest("POST", "/api/rooms/join", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Errorf("Expected 404 Not Found, got %d", rr.Code)
	}
}
