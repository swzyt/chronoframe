package redisx

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/redis/go-redis/v9"
)

const schemaVersion = 1

const readWithPTTL = `
local value = redis.call('GET', KEYS[1])
if not value then
  return {false, -2}
end
return {value, redis.call('PTTL', KEYS[1])}
`

var environmentPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

var (
	ErrSessionNotFound = errors.New("session not found")
	ErrSessionExpired  = errors.New("session expired")
	ErrInvalidRecord   = errors.New("invalid shared-state record")
	ErrUnavailable     = errors.New("shared Redis is unavailable")
)

type Session struct {
	SchemaVersion int   `json:"schemaVersion"`
	UserID        int64 `json:"userId"`
	AuthVersion   int64 `json:"authVersion"`
	IssuedAt      int64 `json:"issuedAt"`
	ExpiresAt     int64 `json:"expiresAt"`
}

type AccessGrant struct {
	SchemaVersion int   `json:"schemaVersion"`
	AccessVersion int64 `json:"accessVersion"`
	IssuedAt      int64 `json:"issuedAt"`
	ExpiresAt     int64 `json:"expiresAt"`
}

type SessionStore struct {
	redis       redis.Cmdable
	environment string
	now         func() time.Time
}

func (s *SessionStore) PutSession(
	ctx context.Context,
	token string,
	session Session,
) error {
	if err := validateSessionShape(session); err != nil {
		return err
	}
	key, err := SessionKey(s.environment, token)
	if err != nil {
		return ErrInvalidRecord
	}
	value, err := json.Marshal(session)
	if err != nil {
		return fmt.Errorf("encode session: %w", err)
	}
	expiry := time.Until(time.Unix(session.ExpiresAt, 0))
	if expiry <= 0 {
		return ErrSessionExpired
	}
	if err := s.redis.Set(ctx, key, value, expiry).Err(); err != nil {
		return fmt.Errorf("%w: write shared session: %w", ErrUnavailable, err)
	}
	return nil
}

func (s *SessionStore) DeleteSession(ctx context.Context, token string) error {
	key, err := SessionKey(s.environment, token)
	if err != nil {
		return ErrInvalidRecord
	}
	if err := s.redis.Del(ctx, key).Err(); err != nil {
		return fmt.Errorf("%w: delete shared session: %w", ErrUnavailable, err)
	}
	return nil
}

func (s *SessionStore) PutAccess(
	ctx context.Context,
	token string,
	grant AccessGrant,
) error {
	if err := validateAccessShape(grant); err != nil {
		return err
	}
	key, err := AccessKey(s.environment, token)
	if err != nil {
		return ErrInvalidRecord
	}
	value, err := json.Marshal(grant)
	if err != nil {
		return fmt.Errorf("encode access grant: %w", err)
	}
	expiry := time.Until(time.Unix(grant.ExpiresAt, 0))
	if expiry <= 0 {
		return ErrSessionExpired
	}
	if err := s.redis.Set(ctx, key, value, expiry).Err(); err != nil {
		return fmt.Errorf("%w: write shared access grant: %w", ErrUnavailable, err)
	}
	return nil
}

func (s *SessionStore) DeleteAccess(ctx context.Context, token string) error {
	key, err := AccessKey(s.environment, token)
	if err != nil {
		return ErrInvalidRecord
	}
	if err := s.redis.Del(ctx, key).Err(); err != nil {
		return fmt.Errorf("%w: delete shared access grant: %w", ErrUnavailable, err)
	}
	return nil
}

func NewSessionStore(client redis.Cmdable, environment string) (*SessionStore, error) {
	if client == nil {
		return nil, errors.New("Redis client must not be nil")
	}
	if !environmentPattern.MatchString(environment) {
		return nil, errors.New("environment has an invalid shared-state namespace")
	}
	return &SessionStore{redis: client, environment: environment, now: time.Now}, nil
}

func GenerateToken() (string, error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate opaque token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(random), nil
}

func TokenDigest(token string) (string, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(decoded) != 32 {
		return "", errors.New("opaque token must be 32-byte base64url without padding")
	}
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:]), nil
}

func SessionKey(environment, token string) (string, error) {
	return sharedKey(environment, "session", token)
}

func AccessKey(environment, token string) (string, error) {
	return sharedKey(environment, "access", token)
}

func (s *SessionStore) GetSession(ctx context.Context, token string) (Session, error) {
	key, err := SessionKey(s.environment, token)
	if err != nil {
		return Session{}, ErrInvalidRecord
	}
	value, ttl, err := s.getWithTTL(ctx, key)
	if err != nil {
		return Session{}, err
	}
	var session Session
	if err := json.Unmarshal(value, &session); err != nil {
		return Session{}, fmt.Errorf("%w: decode session", ErrInvalidRecord)
	}
	if err := validateSession(session, s.now(), ttl); err != nil {
		return Session{}, err
	}
	return session, nil
}

func (s *SessionStore) GetAccessGrant(ctx context.Context, token string) (AccessGrant, error) {
	key, err := AccessKey(s.environment, token)
	if err != nil {
		return AccessGrant{}, ErrInvalidRecord
	}
	value, ttl, err := s.getWithTTL(ctx, key)
	if err != nil {
		return AccessGrant{}, err
	}
	var grant AccessGrant
	if err := json.Unmarshal(value, &grant); err != nil {
		return AccessGrant{}, fmt.Errorf("%w: decode access grant", ErrInvalidRecord)
	}
	if err := validateAccessGrant(grant, s.now(), ttl); err != nil {
		return AccessGrant{}, err
	}
	return grant, nil
}

func (s *SessionStore) getWithTTL(ctx context.Context, key string) ([]byte, time.Duration, error) {
	result, err := s.redis.EvalRO(ctx, readWithPTTL, []string{key}).Slice()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, 0, ErrSessionNotFound
		}
		return nil, 0, fmt.Errorf("%w: read shared state: %w", ErrUnavailable, err)
	}
	if len(result) != 2 || result[0] == nil || result[0] == false {
		return nil, 0, ErrSessionNotFound
	}
	value, ok := result[0].(string)
	if !ok {
		return nil, 0, fmt.Errorf("%w: shared-state value is not a string", ErrInvalidRecord)
	}
	ttlMilliseconds, ok := result[1].(int64)
	if !ok {
		return nil, 0, fmt.Errorf("%w: shared-state TTL is not an integer", ErrInvalidRecord)
	}
	remaining := time.Duration(ttlMilliseconds) * time.Millisecond
	if remaining <= 0 {
		return nil, remaining, ErrSessionExpired
	}
	return []byte(value), remaining, nil
}

func validateSession(session Session, now time.Time, ttl time.Duration) error {
	if err := validateSessionShape(session); err != nil {
		return err
	}
	return validateTimes(session.IssuedAt, session.ExpiresAt, now, ttl)
}

func validateSessionShape(session Session) error {
	if session.SchemaVersion != schemaVersion || session.UserID <= 0 || session.AuthVersion <= 0 {
		return ErrInvalidRecord
	}
	if session.IssuedAt <= 0 || session.ExpiresAt <= session.IssuedAt {
		return ErrInvalidRecord
	}
	return nil
}

func validateAccessGrant(grant AccessGrant, now time.Time, ttl time.Duration) error {
	if err := validateAccessShape(grant); err != nil {
		return err
	}
	return validateTimes(grant.IssuedAt, grant.ExpiresAt, now, ttl)
}

func validateAccessShape(grant AccessGrant) error {
	if grant.SchemaVersion != schemaVersion || grant.AccessVersion <= 0 {
		return ErrInvalidRecord
	}
	if grant.IssuedAt <= 0 || grant.ExpiresAt <= grant.IssuedAt {
		return ErrInvalidRecord
	}
	return nil
}

func validateTimes(issuedAt, expiresAt int64, now time.Time, ttl time.Duration) error {
	if issuedAt <= 0 || expiresAt <= issuedAt {
		return ErrInvalidRecord
	}
	remaining := time.Unix(expiresAt, 0).Sub(now)
	if remaining <= 0 || ttl <= 0 {
		return ErrSessionExpired
	}
	// Redis may round TTL and clocks can differ slightly, but the record must not
	// live materially beyond its absolute expiry.
	if ttl > remaining+2*time.Second {
		return ErrInvalidRecord
	}
	return nil
}

func sharedKey(environment, purpose, token string) (string, error) {
	if !environmentPattern.MatchString(environment) {
		return "", errors.New("environment has an invalid shared-state namespace")
	}
	digest, err := TokenDigest(token)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("cf:v1:%s:%s:%s", environment, purpose, digest), nil
}
