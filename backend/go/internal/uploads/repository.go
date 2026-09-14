package uploads

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

type Share struct {
	ID              int64
	TokenHash       string
	Token           *string
	OwnerUserID     int64
	CreatedByUserID int64
	Label           *string
	IsActive        bool
	UploadCount     int64
	MaxUploads      *int64
	ExpiresAt       *string
	LastUsedAt      *string
	CreatedAt       string
	UpdatedAt       string
}

type Owner struct {
	Username string
	Avatar   *string
	IsActive bool
}

type Repository struct {
	db *sql.DB
}

func NewSQLiteRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (r *Repository) ListByOwner(ctx context.Context, ownerUserID int64) ([]Share, error) {
	return r.query(ctx, `
		SELECT id, token_hash, token, owner_user_id, created_by_user_id,
		       label, is_active, upload_count, max_uploads, expires_at,
		       last_used_at, created_at, updated_at
		FROM upload_shares
		WHERE owner_user_id = ?
		ORDER BY created_at DESC
	`, ownerUserID)
}

func (r *Repository) FindUsable(
	ctx context.Context,
	token string,
	now time.Time,
) (Share, Owner, error) {
	if strings.TrimSpace(token) == "" || len(token) < 24 {
		return Share{}, Owner{}, ErrNotFound
	}
	var (
		share      Share
		active     int64
		expiresAt  sql.NullInt64
		lastUsedAt sql.NullInt64
		createdAt  int64
		updatedAt  int64
		maxUploads sql.NullInt64
	)
	err := r.db.QueryRowContext(ctx, `
		SELECT id, token_hash, token, owner_user_id, created_by_user_id,
		       label, is_active, upload_count, max_uploads, expires_at,
		       last_used_at, created_at, updated_at
		FROM upload_shares
		WHERE token_hash = ?
	`, HashToken(token)).Scan(
		&share.ID,
		&share.TokenHash,
		&share.Token,
		&share.OwnerUserID,
		&share.CreatedByUserID,
		&share.Label,
		&active,
		&share.UploadCount,
		&maxUploads,
		&expiresAt,
		&lastUsedAt,
		&createdAt,
		&updatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Share{}, Owner{}, ErrNotFound
	}
	if err != nil {
		return Share{}, Owner{}, fmt.Errorf("find upload share: %w", err)
	}
	share.IsActive = active != 0
	if maxUploads.Valid {
		share.MaxUploads = &maxUploads.Int64
	}
	if expiresAt.Valid {
		value := time.Unix(expiresAt.Int64, 0).UTC().Format("2006-01-02T15:04:05.000Z")
		share.ExpiresAt = &value
	}
	if lastUsedAt.Valid {
		value := time.Unix(lastUsedAt.Int64, 0).UTC().Format("2006-01-02T15:04:05.000Z")
		share.LastUsedAt = &value
	}
	share.CreatedAt = time.Unix(createdAt, 0).UTC().Format("2006-01-02T15:04:05.000Z")
	share.UpdatedAt = time.Unix(updatedAt, 0).UTC().Format("2006-01-02T15:04:05.000Z")
	if !share.IsActive {
		return Share{}, Owner{}, ErrNotFound
	}
	if share.ExpiresAt != nil {
		expiry, parseErr := time.Parse(time.RFC3339Nano, *share.ExpiresAt)
		if parseErr == nil && !expiry.After(now) {
			return Share{}, Owner{}, ErrExpired
		}
	}
	if share.MaxUploads != nil && share.UploadCount >= *share.MaxUploads {
		return Share{}, Owner{}, ErrLimitReached
	}

	var (
		owner   Owner
		ownerOn int64
	)
	err = r.db.QueryRowContext(ctx, `
		SELECT name, avatar, is_active FROM users WHERE id = ?
	`, share.OwnerUserID).Scan(&owner.Username, &owner.Avatar, &ownerOn)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && ownerOn == 0) {
		return Share{}, Owner{}, ErrNotFound
	}
	if err != nil {
		return Share{}, Owner{}, fmt.Errorf("find upload share owner: %w", err)
	}
	owner.IsActive = ownerOn != 0
	return share, owner, nil
}

func (r *Repository) query(ctx context.Context, query string, args ...any) ([]Share, error) {
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query upload shares: %w", err)
	}
	defer rows.Close()
	result := make([]Share, 0)
	for rows.Next() {
		var (
			share      Share
			active     int64
			maxUploads sql.NullInt64
			expiresAt  sql.NullInt64
			lastUsedAt sql.NullInt64
			createdAt  int64
			updatedAt  int64
		)
		if err := rows.Scan(
			&share.ID,
			&share.TokenHash,
			&share.Token,
			&share.OwnerUserID,
			&share.CreatedByUserID,
			&share.Label,
			&active,
			&share.UploadCount,
			&maxUploads,
			&expiresAt,
			&lastUsedAt,
			&createdAt,
			&updatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan upload share: %w", err)
		}
		share.IsActive = active != 0
		if maxUploads.Valid {
			share.MaxUploads = &maxUploads.Int64
		}
		if expiresAt.Valid {
			value := time.Unix(expiresAt.Int64, 0).UTC().Format("2006-01-02T15:04:05.000Z")
			share.ExpiresAt = &value
		}
		if lastUsedAt.Valid {
			value := time.Unix(lastUsedAt.Int64, 0).UTC().Format("2006-01-02T15:04:05.000Z")
			share.LastUsedAt = &value
		}
		share.CreatedAt = time.Unix(createdAt, 0).UTC().Format("2006-01-02T15:04:05.000Z")
		share.UpdatedAt = time.Unix(updatedAt, 0).UTC().Format("2006-01-02T15:04:05.000Z")
		result = append(result, share)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate upload shares: %w", err)
	}
	return result, nil
}

var (
	ErrNotFound     = errors.New("upload link not found")
	ErrExpired      = errors.New("upload link expired")
	ErrLimitReached = errors.New("upload link limit reached")
)

func SerializeShare(share Share, requestOrigin string) map[string]any {
	value := map[string]any{
		"id":          share.ID,
		"label":       share.Label,
		"isActive":    share.IsActive,
		"uploadCount": share.UploadCount,
		"maxUploads":  share.MaxUploads,
		"expiresAt":   share.ExpiresAt,
		"lastUsedAt":  share.LastUsedAt,
		"createdAt":   share.CreatedAt,
		"updatedAt":   share.UpdatedAt,
		"token":       share.Token,
		"url":         nil,
	}
	if share.Token != nil && requestOrigin != "" {
		value["url"] = strings.TrimRight(requestOrigin, "/") +
			"/upload/" + url.PathEscape(*share.Token)
	}
	return value
}

func DecodeJSON(value string) any {
	var parsed any
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return nil
	}
	return parsed
}
