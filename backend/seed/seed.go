package seed

import (
	"context"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"spatialwatch/models"
	"spatialwatch/repository"
)

// DefaultCommentaryCues returns seed data for Director's Cut mode
func DefaultCommentaryCues() []models.CommentaryCue {
	return []models.CommentaryCue{
		{
			TemplateRef:      "default",
			TimestampSeconds: 15,
			Title:            "Opening Composition",
			Body:             "Notice how the opening shot uses a slow pull-back to establish scale. The wide-angle lens choice here makes the environment feel vast while keeping the subject intimate — a technique borrowed from Kubrick's establishing shots.",
			Category:         "Creative choice",
		},
		{
			TemplateRef:      "default",
			TimestampSeconds: 45,
			Title:            "Sound Design Layer",
			Body:             "The ambient soundscape here uses three distinct layers: environmental tone, subtle musical underscore, and diegetic effects. Each is mixed to create spatial depth even before any character interaction begins.",
			Category:         "Behind the scenes",
		},
		{
			TemplateRef:      "default",
			TimestampSeconds: 90,
			Title:            "Color Grading Philosophy",
			Body:             "The warm-to-cool color shift in this scene was achieved through a custom LUT inspired by late-afternoon golden hour. The shadows carry a subtle teal to create visual separation without feeling artificial.",
			Category:         "Technical insight",
		},
		{
			TemplateRef:      "default",
			TimestampSeconds: 150,
			Title:            "Character Blocking",
			Body:             "This sequence required 14 takes to get the timing right. The character's movement through the frame follows a diagonal path — a deliberate choice to create dynamic tension within a static camera setup.",
			Category:         "Behind the scenes",
		},
		{
			TemplateRef:      "default",
			TimestampSeconds: 210,
			Title:            "The Edit Point",
			Body:             "Here we chose a match cut over a dissolve. The match cut creates a more energetic transition, connecting the two scenes through movement rather than mood. It's a subtle choice that keeps the viewer engaged rather than contemplative.",
			Category:         "Creative choice",
		},
		{
			TemplateRef:      "default",
			TimestampSeconds: 300,
			Title:            "Score Integration",
			Body:             "The score enters here on a sustained note that mirrors the character's emotional state. Rather than leading the audience's emotion, the music follows it — a technique that creates a more authentic connection with the moment.",
			Category:         "Technical insight",
		},
		{
			TemplateRef:      "default",
			TimestampSeconds: 420,
			Title:            "Practical Effects",
			Body:             "Every light source in this scene is practical — nothing was added in post. The cinematographer used a combination of household lamps and modified film lights to create a naturalistic look that feels lived-in and truthful.",
			Category:         "Behind the scenes",
		},
	}
}

// Run inserts default commentary cues if they don't already exist
func Run(commentRepo *repository.CommentaryRepo) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Check if default cues already exist
	count, err := commentRepo.Count(ctx, bson.M{"templateRef": "default"})
	if err != nil {
		log.Printf("[seed] failed to check existing cues: %v", err)
		return
	}

	if count > 0 {
		log.Printf("[seed] %d default commentary cues already exist, skipping seed", count)
		return
	}

	cues := DefaultCommentaryCues()
	if err := commentRepo.InsertMany(ctx, cues); err != nil {
		log.Printf("[seed] failed to insert commentary cues: %v", err)
		return
	}

	log.Printf("[seed] inserted %d default commentary cues", len(cues))
}
