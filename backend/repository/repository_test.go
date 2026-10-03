package repository_test

import (
	"context"
	"testing"

	"spatialwatch/models"
	"spatialwatch/repository"
)

func TestInMemoryRoomRepo(t *testing.T) {
	ctx := context.Background()
	repo := repository.NewRoomRepo(nil)

	room := &models.Room{
		RoomCode:          "SW-AB23",
		HostParticipantID: "p_host1",
		MediaURL:          "https://example.com/test.mp4",
	}

	// Test Create
	if err := repo.Create(ctx, room); err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	// Test FindByCode
	found, err := repo.FindByCode(ctx, "SW-AB23")
	if err != nil {
		t.Fatalf("FindByCode failed: %v", err)
	}
	if found.HostParticipantID != "p_host1" {
		t.Errorf("Expected host p_host1, got %s", found.HostParticipantID)
	}
	if !found.IsPaused {
		t.Error("Expected room to be initialized as paused")
	}

	// Test case-insensitive lookup
	foundLower, err := repo.FindByCode(ctx, "sw-ab23")
	if err != nil {
		t.Fatalf("Case-insensitive lookup failed: %v", err)
	}
	if foundLower.RoomCode != "SW-AB23" {
		t.Errorf("Expected SW-AB23, got %s", foundLower.RoomCode)
	}

	// Test UpdatePlaybackState
	if err := repo.UpdatePlaybackState(ctx, "SW-AB23", 42.5, false); err != nil {
		t.Fatalf("UpdatePlaybackState failed: %v", err)
	}
	updated, _ := repo.FindByCode(ctx, "SW-AB23")
	if updated.PlaybackPositionSeconds != 42.5 || updated.IsPaused != false {
		t.Errorf("Playback state not updated properly: %+v", updated)
	}

	// Test UpdateDirectorCut
	if err := repo.UpdateDirectorCut(ctx, "SW-AB23", true); err != nil {
		t.Fatalf("UpdateDirectorCut failed: %v", err)
	}
	updatedDC, _ := repo.FindByCode(ctx, "SW-AB23")
	if !updatedDC.DirectorCutEnabled {
		t.Error("DirectorCutEnabled should be true")
	}

	// Test UpdateMediaURL
	if err := repo.UpdateMediaURL(ctx, "SW-AB23", "https://example.com/new.mp4"); err != nil {
		t.Fatalf("UpdateMediaURL failed: %v", err)
	}
	updatedURL, _ := repo.FindByCode(ctx, "SW-AB23")
	if updatedURL.MediaURL != "https://example.com/new.mp4" {
		t.Errorf("Expected new media URL, got %s", updatedURL.MediaURL)
	}
}

func TestInMemoryParticipantRepo(t *testing.T) {
	ctx := context.Background()
	repo := repository.NewParticipantRepo(nil)

	p1 := &models.Participant{
		ParticipantID: "p_1",
		RoomCode:      "SW-CD45",
		DisplayName:   "Alice",
	}
	p2 := &models.Participant{
		ParticipantID: "p_2",
		RoomCode:      "SW-CD45",
		DisplayName:   "Bob",
	}

	if err := repo.Create(ctx, p1); err != nil {
		t.Fatalf("Create p1 failed: %v", err)
	}
	if err := repo.Create(ctx, p2); err != nil {
		t.Fatalf("Create p2 failed: %v", err)
	}

	// Find by room
	list, err := repo.FindByRoom(ctx, "SW-CD45")
	if err != nil {
		t.Fatalf("FindByRoom failed: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("Expected 2 participants, got %d", len(list))
	}

	// Remove p1
	if err := repo.Remove(ctx, "p_1"); err != nil {
		t.Fatalf("Remove p1 failed: %v", err)
	}
	listAfter, _ := repo.FindByRoom(ctx, "SW-CD45")
	if len(listAfter) != 1 {
		t.Fatalf("Expected 1 participant after removal, got %d", len(listAfter))
	}
	if listAfter[0].ParticipantID != "p_2" {
		t.Errorf("Expected p_2 remaining, got %s", listAfter[0].ParticipantID)
	}
}

func TestInMemoryCommentaryRepo(t *testing.T) {
	ctx := context.Background()
	repo := repository.NewCommentaryRepo(nil)

	cues := []models.CommentaryCue{
		{
			TemplateRef:      "default",
			TimestampSeconds: 30,
			Title:            "Shot Analysis",
			Body:             "Wide angle camera shot.",
		},
		{
			TemplateRef:      "default",
			TimestampSeconds: 10,
			Title:            "Intro",
			Body:             "Opening credits.",
		},
	}

	if err := repo.InsertMany(ctx, cues); err != nil {
		t.Fatalf("InsertMany failed: %v", err)
	}

	count, err := repo.Count(ctx, map[string]interface{}{"templateRef": "default"})
	if err != nil {
		t.Fatalf("Count failed: %v", err)
	}
	if count != 2 {
		t.Fatalf("Expected count 2, got %d", count)
	}

	// Retrieve by room (should return default template and sort by timestamp)
	results, err := repo.FindByRoom(ctx, "SW-XY88")
	if err != nil {
		t.Fatalf("FindByRoom failed: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("Expected 2 cues, got %d", len(results))
	}
	if results[0].TimestampSeconds != 10 {
		t.Errorf("Expected first cue at 10s, got %v", results[0].TimestampSeconds)
	}
	if results[1].TimestampSeconds != 30 {
		t.Errorf("Expected second cue at 30s, got %v", results[1].TimestampSeconds)
	}
}

func TestInMemoryReactionRepo(t *testing.T) {
	ctx := context.Background()
	repo := repository.NewReactionRepo(nil)

	r1 := &models.Reaction{
		RoomCode:      "SW-ZZ99",
		ParticipantID: "p_1",
		ReactionType:  "applause",
	}
	r2 := &models.Reaction{
		RoomCode:      "SW-ZZ99",
		ParticipantID: "p_2",
		ReactionType:  "popcorn",
	}

	if err := repo.Create(ctx, r1); err != nil {
		t.Fatalf("Create r1 failed: %v", err)
	}
	if err := repo.Create(ctx, r2); err != nil {
		t.Fatalf("Create r2 failed: %v", err)
	}

	reactions, err := repo.FindByRoom(ctx, "SW-ZZ99")
	if err != nil {
		t.Fatalf("FindByRoom failed: %v", err)
	}
	if len(reactions) != 2 {
		t.Fatalf("Expected 2 reactions, got %d", len(reactions))
	}
}
