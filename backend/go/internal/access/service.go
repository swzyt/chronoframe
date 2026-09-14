package access

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/platform/redisx"
	"github.com/swzyt/chronoframe/backend/go/internal/settings"
)

type State struct {
	Enabled           bool
	Granted           bool
	Version           int64
	ClearAccessCookie bool
}

type Service struct {
	settings     *settings.Service
	sessions     *redisx.SessionStore
	accessCookie string
}

func NewService(
	settingsService *settings.Service,
	sessions *redisx.SessionStore,
	accessCookie string,
) *Service {
	return &Service{
		settings:     settingsService,
		sessions:     sessions,
		accessCookie: strings.TrimSpace(accessCookie),
	}
}

func (s *Service) State(
	ctx context.Context,
	r *http.Request,
	authenticated bool,
) (State, error) {
	enabled := s.readBool(ctx, "app", "access.enabled", false)
	version := s.readInt(ctx, "app", "access.version", 1)
	if !enabled || authenticated {
		return State{Enabled: enabled, Granted: true, Version: version}, nil
	}

	if s == nil || s.sessions == nil {
		return State{Enabled: enabled, Granted: false, Version: version}, nil
	}
	cookieName := s.accessCookie
	if cookieName == "" {
		cookieName = "cf_access"
	}
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		if errors.Is(err, http.ErrNoCookie) {
			return State{Enabled: enabled, Granted: false, Version: version}, nil
		}
		return State{}, err
	}
	grant, err := s.sessions.GetAccessGrant(ctx, cookie.Value)
	if err != nil {
		if errors.Is(err, redisx.ErrSessionNotFound) ||
			errors.Is(err, redisx.ErrSessionExpired) ||
			errors.Is(err, redisx.ErrInvalidRecord) {
			if clearErr := s.Clear(ctx, cookie.Value); clearErr != nil {
				return State{}, clearErr
			}
			return State{
				Enabled: enabled, Granted: false, Version: version,
				ClearAccessCookie: true,
			}, nil
		}
		return State{}, err
	}
	if grant.AccessVersion != version {
		if err := s.Clear(ctx, cookie.Value); err != nil {
			return State{}, err
		}
		return State{
			Enabled: enabled, Granted: false, Version: version,
			ClearAccessCookie: true,
		}, nil
	}
	return State{
		Enabled: enabled,
		Granted: true,
		Version: version,
	}, nil
}

func (s *Service) AccessCookieName() string {
	if s == nil || strings.TrimSpace(s.accessCookie) == "" {
		return "cf_access"
	}
	return s.accessCookie
}

func (s *Service) Version(ctx context.Context) int64 {
	return s.readInt(ctx, "app", "access.version", 1)
}

func (s *Service) Enabled(ctx context.Context) bool {
	return s.readBool(ctx, "app", "access.enabled", false)
}

func (s *Service) Sessions() *redisx.SessionStore {
	if s == nil {
		return nil
	}
	return s.sessions
}

func (s *Service) Issue(ctx context.Context, now time.Time) (string, error) {
	if s == nil || s.sessions == nil {
		return "", errors.New("shared access store is unavailable")
	}
	token, err := redisx.GenerateToken()
	if err != nil {
		return "", err
	}
	issued := now.Unix()
	grant := redisx.AccessGrant{
		SchemaVersion: 1,
		AccessVersion: s.Version(ctx),
		IssuedAt:      issued,
		ExpiresAt:     issued + 30*24*60*60,
	}
	if err := s.sessions.PutAccess(ctx, token, grant); err != nil {
		return "", fmt.Errorf("issue shared access grant: %w", err)
	}
	return token, nil
}

func (s *Service) Clear(ctx context.Context, token string) error {
	if s == nil || s.sessions == nil || token == "" {
		return nil
	}
	err := s.sessions.DeleteAccess(ctx, token)
	if errors.Is(err, redisx.ErrInvalidRecord) {
		return nil
	}
	return err
}

func (s *Service) readBool(
	ctx context.Context,
	namespace string,
	key string,
	fallback bool,
) bool {
	if s == nil || s.settings == nil {
		return fallback
	}
	setting, err := s.settings.Value(ctx, namespace, key)
	if err != nil {
		return fallback
	}
	value, ok := settings.BooleanValue(setting.Value)
	if !ok {
		return fallback
	}
	return value
}

func (s *Service) readInt(
	ctx context.Context,
	namespace string,
	key string,
	fallback int64,
) int64 {
	if s == nil || s.settings == nil {
		return fallback
	}
	setting, err := s.settings.Value(ctx, namespace, key)
	if err != nil {
		return fallback
	}
	value, ok := settings.NumberValue(setting.Value)
	if !ok || value < 1 || value != math.Trunc(value) ||
		value >= float64(math.MaxInt64) {
		return fallback
	}
	return int64(value)
}
