package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

type Provider struct {
	ID        int64
	Name      string
	Provider  string
	Config    any
	CreatedAt string
	UpdatedAt string
}

type Repository struct {
	db *sql.DB
}

func NewSQLiteRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

func (r *Repository) List(ctx context.Context) ([]Provider, error) {
	return r.query(ctx, `
		SELECT id, name, provider, config, created_at, updated_at
		FROM settings_storage_providers
		ORDER BY id ASC
	`)
}

func (r *Repository) FindByID(ctx context.Context, id int64) (Provider, error) {
	providers, err := r.query(ctx, `
		SELECT id, name, provider, config, created_at, updated_at
		FROM settings_storage_providers
		WHERE id = ?
	`, id)
	if err != nil {
		return Provider{}, err
	}
	if len(providers) == 0 {
		return Provider{}, sql.ErrNoRows
	}
	return providers[0], nil
}

func (r *Repository) query(ctx context.Context, query string, args ...any) ([]Provider, error) {
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query storage providers: %w", err)
	}
	defer rows.Close()

	result := make([]Provider, 0)
	for rows.Next() {
		var (
			provider  Provider
			config    string
			createdAt int64
			updatedAt int64
		)
		if err := rows.Scan(
			&provider.ID,
			&provider.Name,
			&provider.Provider,
			&config,
			&createdAt,
			&updatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan storage provider: %w", err)
		}
		if err := json.Unmarshal([]byte(config), &provider.Config); err != nil {
			provider.Config = nil
		}
		provider.CreatedAt = time.Unix(createdAt, 0).UTC().Format("2006-01-02T15:04:05.000Z")
		provider.UpdatedAt = time.Unix(updatedAt, 0).UTC().Format("2006-01-02T15:04:05.000Z")
		result = append(result, provider)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate storage providers: %w", err)
	}
	return result, nil
}
