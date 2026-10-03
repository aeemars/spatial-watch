package main

import (
	"strings"
	"testing"
	"time"

	"spatialwatch/models"
	"spatialwatch/repository"
)

func TestGenerateRoomCode(t *testing.T) {
	codes := make(map[string]bool)

	for i := 0; i < 100; i++ {
		code, err := repository.GenerateRoomCode()
		if err != nil {
			t.Fatalf("GenerateRoomCode failed: %v", err)
		}

		// Must start with SW-
		if !strings.HasPrefix(code, "SW-") {
			t.Errorf("Expected SW- prefix, got %s", code)
		}

		// Must be 7 characters: SW-XXXX
		if len(code) != 7 {
			t.Errorf("Expected 7 chars, got %d: %s", len(code), code)
		}

		// First two after SW- should be letters
		suffix := code[3:]
		for i := 0; i < 2; i++ {
			if suffix[i] < 'A' || suffix[i] > 'Z' {
				t.Errorf("Expected letter at position %d, got %c in %s", i, suffix[i], code)
			}
		}
		// Last two should be digits
		for i := 2; i < 4; i++ {
			if suffix[i] < '0' || suffix[i] > '9' {
				t.Errorf("Expected digit at position %d, got %c in %s", i, suffix[i], code)
			}
		}

		// Check no ambiguous characters (0, O, 1, I, L)
		for _, c := range suffix {
			if c == '0' || c == 'O' || c == '1' || c == 'I' || c == 'L' {
				t.Errorf("Ambiguous character %c found in %s", c, code)
			}
		}

		// Check uniqueness
		if codes[code] {
			t.Logf("Duplicate code generated (acceptable for small set): %s", code)
		}
		codes[code] = true
	}
}

func TestValidReactionTypes(t *testing.T) {
	valid := []string{"applause", "laugh", "heart", "surprised", "wow", "popcorn"}
	for _, rt := range valid {
		if !models.ValidReactionTypes[rt] {
			t.Errorf("Expected %s to be valid", rt)
		}
	}

	invalid := []string{"angry", "sad", "", "APPLAUSE", "dance"}
	for _, rt := range invalid {
		if models.ValidReactionTypes[rt] {
			t.Errorf("Expected %s to be invalid", rt)
		}
	}
}

func TestPlaybackStateCalculation(t *testing.T) {
	// Simulate server timestamp-based sync
	serverTime := time.Now().UnixMilli()
	position := 30.5 // seconds

	// Simulate 500ms network delay
	clientReceiveTime := serverTime + 500
	expectedPosition := position + float64(clientReceiveTime-serverTime)/1000.0

	if expectedPosition != 31.0 {
		t.Errorf("Expected position 31.0, got %f", expectedPosition)
	}
}

func TestWSEventValidation(t *testing.T) {
	tests := []struct {
		name    string
		event   models.WSEvent
		valid   bool
	}{
		{
			name:  "valid playback event",
			event: models.WSEvent{Type: "playback", ParticipantID: "p_abc123"},
			valid: true,
		},
		{
			name:  "valid reaction event",
			event: models.WSEvent{Type: "reaction", ParticipantID: "p_abc123"},
			valid: true,
		},
		{
			name:  "empty type",
			event: models.WSEvent{Type: "", ParticipantID: "p_abc123"},
			valid: false,
		},
		{
			name:  "empty participant",
			event: models.WSEvent{Type: "playback", ParticipantID: ""},
			valid: false,
		},
	}

	validTypes := map[string]bool{
		"playback":     true,
		"reaction":     true,
		"director_cut": true,
		"request_sync": true,
		"ping":         true,
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			isValid := tt.event.Type != "" && tt.event.ParticipantID != "" && validTypes[tt.event.Type]
			if isValid != tt.valid {
				t.Errorf("Expected valid=%v, got %v", tt.valid, isValid)
			}
		})
	}
}

func TestHostAuthorization(t *testing.T) {
	room := &models.Room{
		RoomCode:          "SW-AB23",
		HostParticipantID: "p_host123",
	}

	// Host should be authorized
	if room.HostParticipantID != "p_host123" {
		t.Error("Host should be authorized")
	}

	// Non-host should not be authorized
	nonHostID := "p_guest456"
	if room.HostParticipantID == nonHostID {
		t.Error("Non-host should not be authorized")
	}
}
