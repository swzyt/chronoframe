package media

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

func TestVerifyOGMediaTokenAcceptsCurrentAndLegacyKeys(t *testing.T) {
	t.Setenv("NUXT_OG_IMAGE_SECRET", "dedicated-og-secret-with-at-least-32-chars")
	t.Setenv("NUXT_SESSION_PASSWORD", "legacy-session-secret-with-at-least-32-chars")

	photoID := "photo-1"
	storageKey := "thumb/photo-1.webp"
	version := "7"
	payload := version + ":" + photoID + ":" + storageKey

	derived := hmac.New(sha256.New, []byte("legacy-session-secret-with-at-least-32-chars"))
	_, _ = derived.Write([]byte(ogContext))
	keys := [][]byte{
		[]byte("dedicated-og-secret-with-at-least-32-chars"),
		derived.Sum(nil),
		[]byte("legacy-session-secret-with-at-least-32-chars"),
	}
	for index, key := range keys {
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte(payload))
		token := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
		if !VerifyOGMediaToken(photoID, storageKey, token, version) {
			t.Fatalf("verification key %d was rejected", index)
		}
	}
}

func TestVerifyOGMediaTokenRejectsInvalidToken(t *testing.T) {
	t.Setenv("NUXT_OG_IMAGE_SECRET", "dedicated-og-secret-with-at-least-32-chars")
	t.Setenv("NUXT_SESSION_PASSWORD", "legacy-session-secret-with-at-least-32-chars")
	if VerifyOGMediaToken("photo-1", "thumb/photo-1.webp", "not-a-signature", "7") {
		t.Fatal("invalid token was accepted")
	}
}
