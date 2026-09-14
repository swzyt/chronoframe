package media

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"os"
	"strings"
)

const (
	minSecretLength = 32
	ogContext       = "chronoframe:og-media:v1"
)

func CreateOGMediaToken(photoID, storageKey, version string) (string, error) {
	key, err := signingKey()
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(version + ":" + photoID + ":" + storageKey))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func VerifyOGMediaToken(photoID, storageKey, token, version string) bool {
	keys, err := verificationKeys()
	if err != nil {
		return false
	}
	actual, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(actual) != sha256.Size {
		return false
	}
	payload := []byte(version + ":" + photoID + ":" + storageKey)
	matches := false
	for _, key := range keys {
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write(payload)
		matches = hmac.Equal(mac.Sum(nil), actual) || matches
	}
	return matches
}

func verificationKeys() ([][]byte, error) {
	keys := make([][]byte, 0, 3)
	dedicated := strings.TrimSpace(os.Getenv("NUXT_OG_IMAGE_SECRET"))
	if dedicated != "" {
		if len(dedicated) < minSecretLength {
			return nil, errors.New("NUXT_OG_IMAGE_SECRET must contain at least 32 characters")
		}
		keys = append(keys, []byte(dedicated))
	}

	session := strings.TrimSpace(os.Getenv("NUXT_SESSION_PASSWORD"))
	if session != "" {
		if len(session) < minSecretLength {
			return nil, errors.New("NUXT_SESSION_PASSWORD must contain at least 32 characters")
		}
		derived := hmac.New(sha256.New, []byte(session))
		_, _ = derived.Write([]byte(ogContext))
		keys = append(keys, derived.Sum(nil), []byte(session))
	}

	if len(keys) == 0 {
		return nil, errors.New(
			"NUXT_OG_IMAGE_SECRET or NUXT_SESSION_PASSWORD must contain at least 32 characters",
		)
	}
	return keys, nil
}

func signingKey() ([]byte, error) {
	dedicated := strings.TrimSpace(os.Getenv("NUXT_OG_IMAGE_SECRET"))
	if dedicated != "" {
		if len(dedicated) < minSecretLength {
			return nil, errors.New("NUXT_OG_IMAGE_SECRET must contain at least 32 characters")
		}
		return []byte(dedicated), nil
	}

	session := strings.TrimSpace(os.Getenv("NUXT_SESSION_PASSWORD"))
	if len(session) < minSecretLength {
		return nil, errors.New(
			"NUXT_OG_IMAGE_SECRET or NUXT_SESSION_PASSWORD must contain at least 32 characters",
		)
	}
	derived := hmac.New(sha256.New, []byte(session))
	_, _ = derived.Write([]byte(ogContext))
	return derived.Sum(nil), nil
}
