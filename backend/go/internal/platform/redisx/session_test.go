package redisx

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestSessionStoreClassifiesTransportFailureAsUnavailable(t *testing.T) {
	client := redis.NewClient(&redis.Options{
		Addr:       "redis.invalid:6379",
		MaxRetries: -1,
		Dialer: func(context.Context, string, string) (net.Conn, error) {
			return nil, errors.New("fixture transport unavailable")
		},
	})
	defer client.Close()
	store, err := NewSessionStore(client, "test")
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.GetSession(
		context.Background(),
		"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
	)
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("GetSession() error = %v, want ErrUnavailable", err)
	}
}

func TestTokenDigestGoldenVector(t *testing.T) {
	token := "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
	digest, err := TokenDigest(token)
	if err != nil {
		t.Fatalf("TokenDigest() error = %v", err)
	}
	const want = "ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0"
	if digest != want {
		t.Fatalf("TokenDigest() = %q, want %q", digest, want)
	}
	key, err := SessionKey("test", token)
	if err != nil {
		t.Fatal(err)
	}
	if key != "cf:v1:test:session:"+want {
		t.Fatalf("SessionKey() = %q", key)
	}
}

func TestTokenDigestRejectsMalformedToken(t *testing.T) {
	for _, token := range []string{"", "short", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="} {
		if _, err := TokenDigest(token); err == nil {
			t.Errorf("TokenDigest(%q) error = nil", token)
		}
	}
}

func TestValidateSession(t *testing.T) {
	now := time.Unix(1_788_940_800, 0)
	valid := Session{SchemaVersion: 1, UserID: 12, AuthVersion: 1, IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix()}
	if err := validateSession(valid, now, time.Hour); err != nil {
		t.Fatalf("validateSession() error = %v", err)
	}

	expired := valid
	expired.IssuedAt = now.Add(-time.Hour).Unix()
	expired.ExpiresAt = now.Add(-time.Second).Unix()
	if err := validateSession(expired, now, time.Second); !errors.Is(err, ErrSessionExpired) {
		t.Fatalf("expired session error = %v", err)
	}

	wrongVersion := valid
	wrongVersion.SchemaVersion = 2
	if err := validateSession(wrongVersion, now, time.Hour); !errors.Is(err, ErrInvalidRecord) {
		t.Fatalf("wrong-version session error = %v", err)
	}

	if err := validateSession(valid, now, 2*time.Hour); !errors.Is(err, ErrInvalidRecord) {
		t.Fatalf("overlong TTL error = %v", err)
	}
}
