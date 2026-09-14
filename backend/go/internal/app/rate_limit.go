package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	authRateLimitMaxAttempts   = int64(5)
	authRateLimitWindowSeconds = int64(15 * 60)
	rateLimitSecretContext     = "chronoframe:rate-limit:v1"
)

var rateLimitEnvironmentPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

type rateLimitStore interface {
	AcquireRateLimit(ctx context.Context, key string, maxAttempts int64, windowExpiresAt int64) (bool, int64, int64, error)
	ResetRateLimit(ctx context.Context, key string) error
}

type rateLimitDecision struct {
	Allowed           bool
	Count             int64
	RetryAfterSeconds int64
	Key               string
}

func (a *Application) acquireLoginRateLimit(ctx context.Context, r *http.Request, email string) (rateLimitDecision, error) {
	return a.acquireAuthRateLimit(ctx, "login", loginRateLimitSubject(r, email))
}

func (a *Application) acquireAccessRateLimit(ctx context.Context, r *http.Request) (rateLimitDecision, error) {
	return a.acquireAuthRateLimit(ctx, "access", requestIP(r))
}

func (a *Application) acquireAuthRateLimit(ctx context.Context, purpose string, subject string) (rateLimitDecision, error) {
	store, ok := a.redis.(rateLimitStore)
	if !ok || store == nil {
		return rateLimitDecision{}, errors.New("shared rate limit store is unavailable")
	}
	secret, err := rateLimitSecret()
	if err != nil {
		return rateLimitDecision{}, err
	}
	key, windowExpiresAt, err := buildRateLimitKey(rateLimitKeyInput{
		Environment:   a.rateLimitEnvironment(),
		Purpose:       purpose,
		Subject:       subject,
		NowSeconds:    a.rateLimitNowSeconds(),
		WindowSeconds: authRateLimitWindowSeconds,
		Secret:        secret,
	})
	if err != nil {
		return rateLimitDecision{}, err
	}
	allowed, count, retryAfter, err := store.AcquireRateLimit(ctx, key, authRateLimitMaxAttempts, windowExpiresAt)
	if err != nil {
		return rateLimitDecision{}, err
	}
	return rateLimitDecision{
		Allowed:           allowed,
		Count:             count,
		RetryAfterSeconds: retryAfter,
		Key:               key,
	}, nil
}

func (a *Application) resetLoginRateLimit(ctx context.Context, decision rateLimitDecision) error {
	return a.resetAuthRateLimit(ctx, decision)
}

func (a *Application) resetAccessRateLimit(ctx context.Context, decision rateLimitDecision) error {
	return a.resetAuthRateLimit(ctx, decision)
}

func (a *Application) resetAuthRateLimit(ctx context.Context, decision rateLimitDecision) error {
	if decision.Key == "" {
		return nil
	}
	store, ok := a.redis.(rateLimitStore)
	if !ok || store == nil {
		return errors.New("shared rate limit store is unavailable")
	}
	return store.ResetRateLimit(ctx, decision.Key)
}

func loginRateLimitSubject(r *http.Request, email string) string {
	return requestIP(r) + "\x00" + strings.ToLower(strings.TrimSpace(email))
}

type rateLimitKeyInput struct {
	Environment   string
	Purpose       string
	Subject       string
	NowSeconds    int64
	WindowSeconds int64
	Secret        []byte
}

func buildRateLimitKey(input rateLimitKeyInput) (string, int64, error) {
	environment := strings.TrimSpace(input.Environment)
	if environment == "" {
		environment = "development"
	}
	if !rateLimitEnvironmentPattern.MatchString(environment) {
		return "", 0, fmt.Errorf("CFRAME_ENV has an invalid shared-state namespace")
	}
	if input.NowSeconds <= 0 || input.WindowSeconds <= 0 {
		return "", 0, fmt.Errorf("rate-limit time window is invalid")
	}
	purpose := strings.TrimSpace(input.Purpose)
	if purpose == "" {
		return "", 0, fmt.Errorf("rate-limit purpose is required")
	}
	subject := input.Subject
	if subject == "" {
		subject = "unknown"
	}
	window := input.NowSeconds / input.WindowSeconds
	windowExpiresAt := (window + 1) * input.WindowSeconds
	mac := hmac.New(sha256.New, input.Secret)
	_, _ = mac.Write([]byte(subject))
	subjectDigest := hex.EncodeToString(mac.Sum(nil))
	return fmt.Sprintf(
		"cf:v1:%s:ratelimit:%s:%s:%d",
		environment,
		purpose,
		subjectDigest,
		window,
	), windowExpiresAt, nil
}

func rateLimitSecret() ([]byte, error) {
	if dedicated := os.Getenv("CFRAME_RATE_LIMIT_SECRET"); dedicated != "" {
		if len(dedicated) < 32 {
			return nil, fmt.Errorf("CFRAME_RATE_LIMIT_SECRET must contain at least 32 characters")
		}
		return []byte(dedicated), nil
	}
	sessionSecret := os.Getenv("NUXT_SESSION_PASSWORD")
	if len(sessionSecret) < 32 {
		return nil, fmt.Errorf("CFRAME_RATE_LIMIT_SECRET or NUXT_SESSION_PASSWORD must contain at least 32 characters")
	}
	mac := hmac.New(sha256.New, []byte(sessionSecret))
	_, _ = mac.Write([]byte(rateLimitSecretContext))
	return mac.Sum(nil), nil
}

func (a *Application) rateLimitEnvironment() string {
	if value := strings.TrimSpace(a.config.Environment); value != "" {
		return value
	}
	return "development"
}

func (a *Application) rateLimitNowSeconds() int64 {
	now := time.Now()
	if a.now != nil {
		now = a.now()
	}
	return now.Unix()
}
