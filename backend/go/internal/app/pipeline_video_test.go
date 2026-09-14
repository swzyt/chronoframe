package app

import (
	"testing"
	"time"
)

func TestGenerateSafeVideoIDMatchesNodeContract(t *testing.T) {
	cases := map[string]string{
		"users/1/clip.mp4":     "clip-video-184aba7a",
		"uploads/clip.mp4":     "clip-video-1e9d0a8e",
		"users/1/My Trip!.mp4": "My_Trip-video-34abc9df",
		"users/1/很短.mp4":       "photo_ec30c915-video-c6560c02",
		"users/1/this-is-a-very-long-video-name-with-many-many-segments-and-symbols!!.mp4": "this-is-a-very-long-vid_94e86ccb-video-069895b9",
	}
	for storageKey, want := range cases {
		if got := generateSafeVideoID(storageKey); got != want {
			t.Fatalf("generateSafeVideoID(%q) = %q, want %q", storageKey, got, want)
		}
	}
}

func TestNormalizeContentHashMatchesNodeContract(t *testing.T) {
	valid := " ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789 "
	if got := normalizeContentHash(valid); got != "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" {
		t.Fatalf("normalized hash = %q", got)
	}
	for _, input := range []string{"", "xyz", "abcdef", "g123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"} {
		if got := normalizeContentHash(input); got != "" {
			t.Fatalf("normalizeContentHash(%q) = %q, want empty", input, got)
		}
	}
}

func TestParseVideoDateNormalizesExifStyleDates(t *testing.T) {
	fallback := time.Date(2026, 9, 11, 8, 9, 10, 0, time.UTC)
	if got := parseVideoDate("2024:05:06 07:08:09", fallback); got != "2024-05-06T07:08:09Z" {
		t.Fatalf("parseVideoDate EXIF = %q", got)
	}
	if got := parseVideoDate("2024-05-06T07:08:09Z", fallback); got != "2024-05-06T07:08:09Z" {
		t.Fatalf("parseVideoDate RFC3339 = %q", got)
	}
	if got := parseVideoDate("", fallback); got != "2026-09-11T08:09:10Z" {
		t.Fatalf("parseVideoDate fallback = %q", got)
	}
}
