package seed

import (
	"context"
	"log"
	"time"

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
			TimestampSeconds: 75,
			Title:            "Color Grading Philosophy",
			Body:             "The warm-to-cool color shift in this scene was achieved through a custom LUT inspired by late-afternoon golden hour. The shadows carry a subtle teal to create visual separation without feeling artificial.",
			Category:         "Technical insight",
		},
		{
			TemplateRef:      "default",
			TimestampSeconds: 105,
			Title:            "Character Blocking",
			Body:             "This sequence required 14 takes to get the timing right. The character's movement through the frame follows a diagonal path — a deliberate choice to create dynamic tension within a static camera setup.",
			Category:         "Behind the scenes",
		},
		{
			TemplateRef:      "default",
			TimestampSeconds: 130,
			Title:            "The Edit Point",
			Body:             "Here we chose a match cut over a dissolve. The match cut creates a more energetic transition, connecting the two scenes through movement rather than mood. It's a subtle choice that keeps the viewer engaged rather than contemplative.",
			Category:         "Creative choice",
		},
		{
			TemplateRef:      "default",
			TimestampSeconds: 155,
			Title:            "Score Integration",
			Body:             "The score enters here on a sustained note that mirrors the character's emotional state. Rather than leading the audience's emotion, the music follows it — a technique that creates a more authentic connection with the moment.",
			Category:         "Technical insight",
		},
		{
			TemplateRef:      "default",
			TimestampSeconds: 175,
			Title:            "Practical Effects",
			Body:             "Every light source in this scene is practical — nothing was added in post. The cinematographer used a combination of household lamps and modified film lights to create a naturalistic look that feels lived-in and truthful.",
			Category:         "Behind the scenes",
		},
	}
}

// DefaultMediaAssets returns curated seed films for the catalog
func DefaultMediaAssets() []models.MediaAsset {
	return []models.MediaAsset{
		{
			AssetID:               "coffee-run",
			Title:                 "Coffee Run - Blender Open Movie",
			Description:           "Fueled by caffeine, a young woman runs through the bittersweet memories of her past relationship.",
			DurationSeconds:       184,
			PosterURL:             "https://pub-e68e9acfc40b4388b0444968a7672e9e.r2.dev/Coffee_Run%20poster.png",
			Gradient:              "linear-gradient(135deg, #4a2c11 0%, #1a0f05 100%)",
			MediaURL:              "https://pub-e68e9acfc40b4388b0444968a7672e9e.r2.dev/Coffee_Run.mp4",
			CORSReady:             true,
			DirectorCutAvailable:  true,
			CommentaryTemplateRef: "default",
		},
		{
			AssetID:              "glass-half",
			Title:                "Glass Half - Blender animated cartoon",
			Description:          "Two amateur art critics meet in a gallery and argue passionately about the pieces they see, until finally they find a piece on which they can agree.",
			DurationSeconds:      193,
			PosterURL:            "https://pub-e68e9acfc40b4388b0444968a7672e9e.r2.dev/Glass_Half_Poster.png",
			Gradient:             "linear-gradient(135deg, #1e3a5f 0%, #0c1827 100%)",
			MediaURL:             "https://pub-e68e9acfc40b4388b0444968a7672e9e.r2.dev/Glass_Half.mp4",
			CORSReady:            true,
			DirectorCutAvailable: false,
		},
	}
}

// Run inserts default commentary cues and media assets if they don't already exist
func Run(commentRepo *repository.CommentaryRepo, mediaRepo *repository.MediaAssetRepo) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Seed or refresh commentary cues for Director's Cut
	if commentRepo != nil {
		_ = commentRepo.DeleteByTemplateRef(ctx, "default")
		cues := DefaultCommentaryCues()
		if err := commentRepo.InsertMany(ctx, cues); err != nil {
			log.Printf("[seed] failed to insert commentary cues: %v", err)
		} else {
			log.Printf("[seed] synchronized %d default commentary cues", len(cues))
		}
	}

	// Seed / upsert media catalog assets
	if mediaRepo != nil {
		// Purge obsolete demo assets
		obsolete := []string{"big-buck-bunny", "tears-of-steel", "sintel", "elephants-dream"}
		for _, id := range obsolete {
			_ = mediaRepo.DeleteByAssetID(ctx, id)
		}

		assets := DefaultMediaAssets()
		for _, a := range assets {
			if err := mediaRepo.Upsert(ctx, &a); err != nil {
				log.Printf("[seed] failed to upsert media asset %s: %v", a.AssetID, err)
			}
		}
		log.Printf("[seed] synchronized %d default media assets into catalog", len(assets))
	}
}
