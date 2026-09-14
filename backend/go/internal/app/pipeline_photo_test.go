package app

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/platform/config"
	platformdb "github.com/swzyt/chronoframe/backend/go/internal/platform/db"
)

func TestGenerateSafePhotoIDWithStorageHashMatchesNodeContract(t *testing.T) {
	cases := map[string]string{
		"users/1/clip.jpg":     "clip-c32663a4",
		"uploads/clip.jpg":     "clip-c837c810",
		"users/1/My Trip!.jpg": "My_Trip-a2b2e10f",
		"users/1/很短.jpg":       "photo_ec30c915-35cd8ccc",
	}
	for storageKey, want := range cases {
		if got := generateSafePhotoIDWithStorageHash(storageKey); got != want {
			t.Fatalf("generateSafePhotoIDWithStorageHash(%q) = %q, want %q", storageKey, got, want)
		}
	}
}

func TestResolvePhotoIDForStorageKeyKeepsLegacyIDUnlessItWouldOverwriteAnotherPhoto(t *testing.T) {
	ctx := context.Background()
	tempDir := t.TempDir()
	store, err := platformdb.Open(ctx, filepath.Join(tempDir, "app.sqlite3"), platformdb.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.SQL().ExecContext(ctx, `
		CREATE TABLE photos (
			id TEXT PRIMARY KEY,
			storage_key TEXT,
			owner_user_id INTEGER NOT NULL
		);
		INSERT INTO photos(id, storage_key, owner_user_id)
		VALUES('clip', 'users/1/clip.jpg', 1);
	`); err != nil {
		t.Fatal(err)
	}
	application := NewApplication(Dependencies{
		Config:   config.Config{Environment: "development"},
		Logger:   slog.New(slog.NewTextHandler(os.Stderr, nil)),
		Database: store,
	})
	same, err := application.resolvePhotoIDForStorageKey(ctx, "users/1/clip.jpg", 1)
	if err != nil {
		t.Fatal(err)
	}
	if same != "clip" {
		t.Fatalf("same owner/storage id = %q, want legacy clip", same)
	}
	colliding, err := application.resolvePhotoIDForStorageKey(ctx, "users/2/clip.jpg", 2)
	if err != nil {
		t.Fatal(err)
	}
	if colliding != "clip-d1d57901" {
		t.Fatalf("colliding id = %q, want storage-hashed id", colliding)
	}
}

func TestExtractMotionPhotoVideoBufferUsesXMPContainerItemLength(t *testing.T) {
	video := makeFakeMP4(9000)
	xmp := `<x:xmpmeta><Container:Directory><Container:Item Item:Semantic="MotionPhoto" Item:Mime="video/mp4" Item:Length="9000" Item:Padding="0"/></Container:Directory></x:xmpmeta>`
	raw := append([]byte("jpeg-prefix"+xmp), video...)
	got, offset, ok := extractMotionPhotoVideoBuffer(raw, nil)
	if !ok {
		t.Fatal("motion photo video was not detected")
	}
	if offset != len(raw)-len(video) {
		t.Fatalf("offset = %d, want %d", offset, len(raw)-len(video))
	}
	if !bytes.Equal(got, video) {
		t.Fatal("extracted video buffer does not match appended MP4")
	}
}

func TestExtractMotionPhotoVideoBufferUsesMicroVideoOffsetFromEnd(t *testing.T) {
	video := makeFakeMP4(9000)
	raw := append([]byte("jpeg-prefix"), video...)
	got, offset, ok := extractMotionPhotoVideoBuffer(raw, map[string]any{
		"MicroVideo":       1,
		"MicroVideoOffset": len(video),
	})
	if !ok {
		t.Fatal("motion photo video was not detected")
	}
	if offset != len(raw)-len(video) {
		t.Fatalf("offset = %d, want %d", offset, len(raw)-len(video))
	}
	if !bytes.Equal(got, video) {
		t.Fatal("extracted video buffer does not match appended MP4")
	}
}

func makeFakeMP4(length int) []byte {
	video := make([]byte, length)
	video[0] = 0
	video[1] = 0
	video[2] = 0
	video[3] = 24
	copy(video[4:], []byte("ftypisom"))
	return video
}

func TestExtractPhotoInfoFromExifMatchesNodeRules(t *testing.T) {
	now := time.Date(2026, 9, 11, 8, 9, 10, 0, time.UTC)
	info := extractPhotoInfoFromExif("uploads/2024-05-06_My-Trip_12views.jpg", map[string]any{
		"Subject":          []any{"travel"},
		"Keywords":         "family",
		"XPKeywords":       "city; evening",
		"Title":            "My Trip",
		"ImageDescription": `{"ARInfo":{}}`,
	}, now)
	if info.Title != "My Trip" {
		t.Fatalf("title = %q, want My Trip", info.Title)
	}
	if info.Description != "" {
		t.Fatalf("description = %q, want empty machine metadata", info.Description)
	}
	if info.DateTaken != "2024-05-06T00:00:00Z" {
		t.Fatalf("dateTaken = %q, want filename date", info.DateTaken)
	}
	wantTags := []string{"travel", "family", "city", "evening"}
	if len(info.Tags) != len(wantTags) {
		t.Fatalf("tags = %#v, want %#v", info.Tags, wantTags)
	}
	for index, want := range wantTags {
		if info.Tags[index] != want {
			t.Fatalf("tags = %#v, want %#v", info.Tags, wantTags)
		}
	}
}

func TestQueuePayloadBoolAcceptsOnlyJSONBoolean(t *testing.T) {
	if value, ok := queuePayloadBool(map[string]any{"eraseLocation": true}, "eraseLocation"); !ok || !value {
		t.Fatalf("boolean payload = %v %v, want true,true", value, ok)
	}
	if _, ok := queuePayloadBool(map[string]any{"eraseLocation": "true"}, "eraseLocation"); ok {
		t.Fatal("string payload should not be accepted as a boolean override")
	}
}

func TestHEICPreprocessingKeyHelpers(t *testing.T) {
	for _, key := range []string{"uploads/a.heic", "uploads/a.HEIF", "uploads/a.hif"} {
		if !isHEICImageKey(key) {
			t.Fatalf("%s should be treated as HEIC-family image", key)
		}
	}
	if isHEICImageKey("uploads/a.jpg") {
		t.Fatal("jpg should not be treated as HEIC-family image")
	}
	if got := jpegStorageKey("uploads/IMG_0001.HEIC"); got != "uploads/IMG_0001.jpeg" {
		t.Fatalf("jpegStorageKey = %q", got)
	}
	if got := jpegStorageKey("IMG_0001.heif"); got != "IMG_0001.jpeg" {
		t.Fatalf("jpegStorageKey root = %q", got)
	}
}

func TestResolvePhotoIDForStorageKeyReturnsLegacyIDWhenNoExistingRow(t *testing.T) {
	ctx := context.Background()
	tempDir := t.TempDir()
	store, err := platformdb.Open(ctx, filepath.Join(tempDir, "app.sqlite3"), platformdb.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.SQL().ExecContext(ctx, `
		CREATE TABLE photos (
			id TEXT PRIMARY KEY,
			storage_key TEXT,
			owner_user_id INTEGER NOT NULL
		);
	`); err != nil {
		t.Fatal(err)
	}
	application := NewApplication(Dependencies{Database: store})
	id, err := application.resolvePhotoIDForStorageKey(ctx, "uploads/new.jpg", 1)
	if err != nil {
		t.Fatal(err)
	}
	if id != "new" {
		t.Fatalf("id = %q, want new", id)
	}
}
