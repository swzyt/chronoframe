package app

import (
	"reflect"
	"testing"

	"github.com/swzyt/chronoframe/backend/go/internal/photos"
)

func TestPhotoDeleteStorageKeysMatchNodeSideEffects(t *testing.T) {
	got := photoDeleteStorageKeys(photos.Record{
		StorageKey:        deleteStorageString("originals/camera/IMG_0001.HEIC"),
		ThumbnailKey:      deleteStorageString("thumbnails/camera/IMG_0001.webp"),
		DisplayKey:        deleteStorageString("display/camera/IMG_0001.webp"),
		LivePhotoVideoKey: deleteStorageString("live/camera/IMG_0001.mov"),
		VideoPlaybackKey:  deleteStorageString("videos/camera/IMG_0001.mp4"),
	})
	want := []string{
		"originals/camera/IMG_0001.HEIC",
		"originals/camera/IMG_0001.jpeg",
		"thumbnails/camera/IMG_0001.webp",
		"display/camera/IMG_0001.webp",
		"live/camera/IMG_0001.mov",
		"videos/camera/IMG_0001.mp4",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("photoDeleteStorageKeys() = %#v, want %#v", got, want)
	}
}

func TestPhotoDeleteStorageKeysRequireOriginalStorageKeyLikeNode(t *testing.T) {
	got := photoDeleteStorageKeys(photos.Record{
		ThumbnailKey:      deleteStorageString("thumbnails/orphan.webp"),
		DisplayKey:        deleteStorageString("display/orphan.webp"),
		LivePhotoVideoKey: deleteStorageString("live/orphan.mov"),
		VideoPlaybackKey:  deleteStorageString("videos/orphan.mp4"),
	})
	if len(got) != 0 {
		t.Fatalf("photoDeleteStorageKeys() = %#v, want no deletes without storageKey", got)
	}
}

func TestConvertedHEICJPEGKeySupportsNodeExtensions(t *testing.T) {
	for _, test := range []struct {
		storageKey string
		want       string
		ok         bool
	}{
		{storageKey: "originals/photo.heic", want: "originals/photo.jpeg", ok: true},
		{storageKey: "originals/photo.HEIF", want: "originals/photo.jpeg", ok: true},
		{storageKey: "originals/photo.Hif", want: "originals/photo.jpeg", ok: true},
		{storageKey: "originals/photo.jpg"},
	} {
		got, ok := convertedHEICJPEGKey(test.storageKey)
		if got != test.want || ok != test.ok {
			t.Fatalf("convertedHEICJPEGKey(%q) = (%q, %t), want (%q, %t)", test.storageKey, got, ok, test.want, test.ok)
		}
	}
}

func deleteStorageString(value string) *string {
	return &value
}
