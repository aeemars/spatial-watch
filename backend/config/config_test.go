package config

import (
	"testing"
)

func TestCleanMongoURI(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "already clean",
			input:    "mongodb+srv://user:pass@cluster.mongodb.net/db",
			expected: "mongodb+srv://user:pass@cluster.mongodb.net/db",
		},
		{
			name:     "double quotes",
			input:    `"mongodb+srv://user:pass@cluster.mongodb.net/db"`,
			expected: "mongodb+srv://user:pass@cluster.mongodb.net/db",
		},
		{
			name:     "single quotes",
			input:    `'mongodb://localhost:27017'`,
			expected: "mongodb://localhost:27017",
		},
		{
			name:     "variable assignment prefix MONGODB_URI=",
			input:    "MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/db",
			expected: "mongodb+srv://user:pass@cluster.mongodb.net/db",
		},
		{
			name:     "quoted variable assignment prefix",
			input:    `MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net/db"`,
			expected: "mongodb+srv://user:pass@cluster.mongodb.net/db",
		},
		{
			name:     "variable assignment prefix MONGO_URI=",
			input:    "MONGO_URI=mongodb://localhost:27017/spatialwatch",
			expected: "mongodb://localhost:27017/spatialwatch",
		},
		{
			name:     "missing colon typo",
			input:    "mongodb+srv//cluster.mongodb.net/db",
			expected: "mongodb+srv://cluster.mongodb.net/db",
		},
		{
			name:     "spaces and newlines",
			input:    "  \n mongodb+srv://user:pass@cluster.mongodb.net/db \r\n ",
			expected: "mongodb+srv://user:pass@cluster.mongodb.net/db",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CleanMongoURI(tt.input)
			if got != tt.expected {
				t.Errorf("CleanMongoURI(%q) = %q, want %q", tt.input, got, tt.expected)
			}
		})
	}
}

func TestMaskMongoURI(t *testing.T) {
	input := "mongodb+srv://aeemars:SuperSecretPass123!@cluster0.abcde.mongodb.net/spatialwatch"
	masked := MaskMongoURI(input)

	if masked == input {
		t.Errorf("Password was not masked: %s", masked)
	}
	if masked != "mongodb+srv://aeemars:******@cluster0.abcde.mongodb.net/spatialwatch" {
		t.Errorf("Unexpected masked URI: %s", masked)
	}
}
