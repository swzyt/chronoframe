package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/platform/redisx"
)

var (
	ErrUnauthorized = errors.New("unauthorized")
	ErrForbidden    = errors.New("forbidden")
)

type invalidSessionError struct {
	cookieName string
	secure     bool
}

func (e *invalidSessionError) Error() string {
	return ErrUnauthorized.Error()
}

func (e *invalidSessionError) Unwrap() error {
	return ErrUnauthorized
}

// InvalidSessionCookie reports the response cookie that must be cleared when
// a presented shared session is missing, malformed, expired, or no longer
// matches an active SQLite user. This mirrors Node's revokeSharedSession path
// without treating a genuinely absent cookie as an invalid credential.
func InvalidSessionCookie(err error) (name string, secure bool, ok bool) {
	var invalid *invalidSessionError
	if !errors.As(err, &invalid) {
		return "", false, false
	}
	return invalid.cookieName, invalid.secure, true
}

type User struct {
	ID          int64   `json:"id"`
	Username    string  `json:"username"`
	Email       string  `json:"email"`
	Avatar      *string `json:"avatar"`
	CreatedAt   string  `json:"createdAt"`
	IsAdmin     int64   `json:"isAdmin"`
	IsActive    bool    `json:"isActive"`
	AuthVersion int64   `json:"authVersion"`
}

type Repository interface {
	FindByID(context.Context, int64) (User, error)
}

type IdentityRepository interface {
	Repository
	FindByEmail(context.Context, string) (User, error)
	FindByUsername(context.Context, string) (User, error)
	Create(context.Context, User, string) (User, error)
	Update(context.Context, int64, UserPatch) (User, error)
	Delete(context.Context, int64) error
	List(context.Context) ([]User, error)
}

// CredentialRepository is deliberately separate from IdentityRepository so
// password hashes never become part of the JSON-facing User model. Both the
// Node and Go services read the same users.password column, which lets either
// backend authenticate a session created by the other one.
type CredentialRepository interface {
	FindCredentials(context.Context, string) (User, string, error)
}

type UserPatch struct {
	Username *string
	Email    *string
	Password *string
	IsAdmin  *bool
	IsActive *bool
}

type SQLiteRepository struct {
	db *sql.DB
}

func NewSQLiteRepository(db *sql.DB) *SQLiteRepository {
	return &SQLiteRepository{db: db}
}

func (r *SQLiteRepository) FindByEmail(
	ctx context.Context,
	email string,
) (User, error) {
	return r.findOne(ctx, `WHERE email = ?`, email)
}

func (r *SQLiteRepository) FindByUsername(
	ctx context.Context,
	username string,
) (User, error) {
	return r.findOne(ctx, `WHERE name = ?`, username)
}

func (r *SQLiteRepository) FindCredentials(
	ctx context.Context,
	email string,
) (User, string, error) {
	var (
		user      User
		password  sql.NullString
		createdAt int64
		isActive  int64
	)
	err := r.db.QueryRowContext(ctx, `
		SELECT id, name, email, password, avatar, created_at,
		       is_admin, is_active, auth_version
		FROM users
		WHERE email = ?
	`, email).Scan(
		&user.ID,
		&user.Username,
		&user.Email,
		&password,
		&user.Avatar,
		&createdAt,
		&user.IsAdmin,
		&isActive,
		&user.AuthVersion,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, "", ErrUnauthorized
		}
		return User{}, "", fmt.Errorf("find user credentials: %w", err)
	}
	if !password.Valid || strings.TrimSpace(password.String) == "" {
		return User{}, "", ErrUnauthorized
	}
	user.CreatedAt = unixSecondsToISOString(createdAt)
	user.IsActive = isActive != 0
	return user, password.String, nil
}

func (r *SQLiteRepository) FindByID(ctx context.Context, id int64) (User, error) {
	return r.findOne(ctx, `WHERE id = ?`, id)
}

func (r *SQLiteRepository) findOne(
	ctx context.Context,
	where string,
	arg any,
) (User, error) {
	var (
		user      User
		createdAt int64
		isActive  int64
	)
	err := r.db.QueryRowContext(ctx, `
		SELECT id, name, email, avatar, created_at, is_admin, is_active, auth_version
		FROM users
		`+where+`
	`, arg).Scan(
		&user.ID,
		&user.Username,
		&user.Email,
		&user.Avatar,
		&createdAt,
		&user.IsAdmin,
		&isActive,
		&user.AuthVersion,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, ErrUnauthorized
		}
		return User{}, fmt.Errorf("find user: %w", err)
	}
	user.CreatedAt = unixSecondsToISOString(createdAt)
	user.IsActive = isActive != 0
	return user, nil
}

func (r *SQLiteRepository) Create(
	ctx context.Context,
	user User,
	password string,
) (User, error) {
	result, err := r.db.ExecContext(ctx, `
		INSERT INTO users (name, email, password, avatar, created_at, is_admin, is_active, auth_version)
		VALUES (?, ?, ?, ?, ?, ?, ?, 1)
	`, user.Username, user.Email, password, user.Avatar,
		time.Now().Unix(), user.IsAdmin, user.IsActive)
	if err != nil {
		return User{}, fmt.Errorf("create user: %w", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return User{}, fmt.Errorf("read created user id: %w", err)
	}
	return r.FindByID(ctx, id)
}

func (r *SQLiteRepository) Update(
	ctx context.Context,
	id int64,
	patch UserPatch,
) (User, error) {
	sets := make([]string, 0, 5)
	args := make([]any, 0, 6)
	if patch.Username != nil {
		sets = append(sets, "name = ?")
		args = append(args, *patch.Username)
	}
	if patch.Email != nil {
		sets = append(sets, "email = ?")
		args = append(args, *patch.Email)
	}
	if patch.Password != nil {
		sets = append(sets, "password = ?")
		args = append(args, *patch.Password)
	}
	if patch.IsAdmin != nil {
		sets = append(sets, "is_admin = ?")
		if *patch.IsAdmin {
			args = append(args, 1)
		} else {
			args = append(args, 0)
		}
	}
	if patch.IsActive != nil {
		sets = append(sets, "is_active = ?")
		if *patch.IsActive {
			args = append(args, 1)
		} else {
			args = append(args, 0)
		}
	}
	if len(sets) == 0 {
		return r.FindByID(ctx, id)
	}
	args = append(args, id)
	if _, err := r.db.ExecContext(ctx,
		"UPDATE users SET "+strings.Join(sets, ", ")+" WHERE id = ?",
		args...,
	); err != nil {
		return User{}, fmt.Errorf("update user: %w", err)
	}
	return r.FindByID(ctx, id)
}

func (r *SQLiteRepository) Delete(ctx context.Context, id int64) error {
	if _, err := r.db.ExecContext(ctx, "DELETE FROM users WHERE id = ?", id); err != nil {
		return fmt.Errorf("delete user: %w", err)
	}
	return nil
}

func (r *SQLiteRepository) List(ctx context.Context) ([]User, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, name, email, avatar, created_at, is_admin, is_active, auth_version
		FROM users ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()
	result := make([]User, 0)
	for rows.Next() {
		var (
			user      User
			createdAt int64
			isActive  int64
		)
		if err := rows.Scan(
			&user.ID, &user.Username, &user.Email, &user.Avatar,
			&createdAt, &user.IsAdmin, &isActive, &user.AuthVersion,
		); err != nil {
			return nil, fmt.Errorf("scan user: %w", err)
		}
		user.CreatedAt = unixSecondsToISOString(createdAt)
		user.IsActive = isActive != 0
		result = append(result, user)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate users: %w", err)
	}
	return result, nil
}

type Service struct {
	repository    Repository
	sessions      *redisx.SessionStore
	sessionCookie string
}

func NewService(
	repository Repository,
	sessions *redisx.SessionStore,
	sessionCookie string,
) *Service {
	return &Service{
		repository:    repository,
		sessions:      sessions,
		sessionCookie: strings.TrimSpace(sessionCookie),
	}
}

func (s *Service) OptionalUser(
	ctx context.Context,
	r *http.Request,
) (*User, error) {
	if s == nil || s.sessions == nil {
		return nil, nil
	}
	cookieName := s.sessionCookie
	if cookieName == "" {
		cookieName = "cf_session"
	}
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		if errors.Is(err, http.ErrNoCookie) {
			return nil, nil
		}
		return nil, err
	}
	session, err := s.sessions.GetSession(ctx, cookie.Value)
	if err != nil {
		if errors.Is(err, redisx.ErrSessionNotFound) ||
			errors.Is(err, redisx.ErrSessionExpired) ||
			errors.Is(err, redisx.ErrInvalidRecord) {
			return nil, s.invalidateSession(ctx, r, cookieName, cookie.Value)
		}
		return nil, err
	}
	user, err := s.repository.FindByID(ctx, session.UserID)
	if err != nil {
		if errors.Is(err, ErrUnauthorized) {
			return nil, s.invalidateSession(ctx, r, cookieName, cookie.Value)
		}
		return nil, err
	}
	if !user.IsActive || user.AuthVersion != session.AuthVersion {
		return nil, s.invalidateSession(ctx, r, cookieName, cookie.Value)
	}
	return &user, nil
}

func (s *Service) invalidateSession(
	ctx context.Context,
	r *http.Request,
	cookieName string,
	token string,
) error {
	if err := s.sessions.DeleteSession(ctx, token); err != nil &&
		!errors.Is(err, redisx.ErrInvalidRecord) {
		return err
	}
	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	return &invalidSessionError{cookieName: cookieName, secure: secure}
}

func (s *Service) RequireUser(
	ctx context.Context,
	r *http.Request,
) (*User, error) {
	user, err := s.OptionalUser(ctx, r)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, ErrUnauthorized
	}
	return user, nil
}

func (s *Service) RequireAdmin(
	ctx context.Context,
	r *http.Request,
) (*User, error) {
	user, err := s.RequireUser(ctx, r)
	if err != nil {
		return nil, err
	}
	if user.IsAdmin == 0 {
		return nil, ErrForbidden
	}
	return user, nil
}

func (s *Service) IdentityRepository() (IdentityRepository, bool) {
	if s == nil {
		return nil, false
	}
	repository, ok := s.repository.(IdentityRepository)
	return repository, ok
}

func (s *Service) CredentialRepository() (CredentialRepository, bool) {
	if s == nil {
		return nil, false
	}
	repository, ok := s.repository.(CredentialRepository)
	return repository, ok
}

func (s *Service) SessionStore() *redisx.SessionStore {
	if s == nil {
		return nil
	}
	return s.sessions
}

func (s *Service) SessionCookieName() string {
	if s == nil || strings.TrimSpace(s.sessionCookie) == "" {
		return "cf_session"
	}
	return s.sessionCookie
}

func unixSecondsToISOString(value int64) string {
	// Node's Drizzle timestamp fields serialize as Date JSON strings. Keep the
	// same millisecond precision for cross-language response comparisons.
	return time.Unix(value, 0).UTC().Format("2006-01-02T15:04:05.000Z")
}
