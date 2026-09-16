package albums

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

type Owner struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar"`
	IsAdmin  int64   `json:"isAdmin"`
}

type Album struct {
	ID           int64    `json:"id"`
	Title        string   `json:"title"`
	Description  *string  `json:"description"`
	CoverPhotoID *string  `json:"coverPhotoId"`
	IsHidden     bool     `json:"isHidden"`
	Position     float64  `json:"position"`
	CreatedAt    string   `json:"createdAt"`
	UpdatedAt    string   `json:"updatedAt"`
	OwnerUserID  int64    `json:"ownerUserId"`
	Owner        *Owner   `json:"owner"`
	PhotoIDs     []string `json:"photoIds"`
}

// PhotoAlbum is the intentionally smaller album projection returned by
// GET /api/photos/{photoId}/albums. Keeping this separate from Album prevents
// private ownership fields from leaking into the public association response.
type PhotoAlbum struct {
	ID           int64   `json:"id"`
	Title        string  `json:"title"`
	Description  *string `json:"description"`
	CoverPhotoID *string `json:"coverPhotoId"`
	CreatedAt    string  `json:"createdAt"`
	UpdatedAt    string  `json:"updatedAt"`
}

type Repository struct {
	db *sql.DB
}

func NewSQLiteRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

func (r *Repository) ListPublic(ctx context.Context, limits ...int64) ([]Album, error) {
	query := `
		SELECT id, title, description, cover_photo_id, is_hidden, position,
		       created_at, updated_at, owner_user_id
		FROM albums
		WHERE is_hidden = 0
		ORDER BY position ASC, id ASC
	`
	args := []any{}
	if len(limits) > 0 && limits[0] > 0 {
		query += " LIMIT ?"
		args = append(args, limits[0])
	}
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list public albums: %w", err)
	}
	defer rows.Close()

	albums := make([]Album, 0)
	for rows.Next() {
		var album Album
		var hidden int64
		var createdAt int64
		var updatedAt int64
		if err := rows.Scan(
			&album.ID, &album.Title, &album.Description, &album.CoverPhotoID,
			&hidden, &album.Position, &createdAt, &updatedAt, &album.OwnerUserID,
		); err != nil {
			return nil, fmt.Errorf("scan public album: %w", err)
		}
		album.IsHidden = hidden != 0
		album.CreatedAt = unixSecondsToISOString(createdAt)
		album.UpdatedAt = unixSecondsToISOString(updatedAt)
		album.PhotoIDs = []string{}
		albums = append(albums, album)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate public albums: %w", err)
	}
	if len(albums) == 0 {
		return albums, nil
	}

	owners, err := r.ownerMap(ctx, albums)
	if err != nil {
		return nil, err
	}
	photoIDs, err := r.photoIDsByAlbum(ctx)
	if err != nil {
		return nil, err
	}
	for index := range albums {
		album := &albums[index]
		album.Owner = owners[album.OwnerUserID]
		if ids, ok := photoIDs[album.ID]; ok {
			album.PhotoIDs = ids
		}
	}
	return albums, nil
}

// ListManage returns the complete album inventory visible to the current
// dashboard user. Administrators see every album; regular users see only
// albums they own. The Node dashboard preserves database insertion order for
// this query, so the explicit id ordering keeps the result deterministic.
func (r *Repository) ListManage(
	ctx context.Context,
	userID int64,
	isAdmin bool,
) ([]Album, error) {
	query := `
		SELECT id, title, description, cover_photo_id, is_hidden, position,
		       created_at, updated_at, owner_user_id
		FROM albums`
	args := []any{}
	if !isAdmin {
		query += " WHERE owner_user_id = ?"
		args = append(args, userID)
	}
	query += " ORDER BY position ASC, id ASC"

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list managed albums: %w", err)
	}
	defer rows.Close()

	albums := make([]Album, 0)
	for rows.Next() {
		var (
			album     Album
			hidden    int64
			createdAt int64
			updatedAt int64
		)
		if err := rows.Scan(
			&album.ID,
			&album.Title,
			&album.Description,
			&album.CoverPhotoID,
			&hidden,
			&album.Position,
			&createdAt,
			&updatedAt,
			&album.OwnerUserID,
		); err != nil {
			return nil, fmt.Errorf("scan managed album: %w", err)
		}
		album.IsHidden = hidden != 0
		album.CreatedAt = unixSecondsToISOString(createdAt)
		album.UpdatedAt = unixSecondsToISOString(updatedAt)
		album.PhotoIDs = []string{}
		albums = append(albums, album)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate managed albums: %w", err)
	}
	if len(albums) == 0 {
		return albums, nil
	}

	owners, err := r.ownerMap(ctx, albums)
	if err != nil {
		return nil, err
	}
	photoIDs, err := r.photoIDsByAlbum(ctx)
	if err != nil {
		return nil, err
	}
	for index := range albums {
		album := &albums[index]
		album.Owner = owners[album.OwnerUserID]
		if ids, ok := photoIDs[album.ID]; ok {
			album.PhotoIDs = ids
		}
	}
	return albums, nil
}

func (r *Repository) FindByID(ctx context.Context, id int64) (Album, error) {
	var album Album
	var hidden int64
	var createdAt int64
	var updatedAt int64
	err := r.db.QueryRowContext(ctx, `
		SELECT id, title, description, cover_photo_id, is_hidden, position,
		       created_at, updated_at, owner_user_id
		FROM albums
		WHERE id = ?
	`, id).Scan(
		&album.ID,
		&album.Title,
		&album.Description,
		&album.CoverPhotoID,
		&hidden,
		&album.Position,
		&createdAt,
		&updatedAt,
		&album.OwnerUserID,
	)
	if err != nil {
		return Album{}, err
	}
	album.IsHidden = hidden != 0
	album.CreatedAt = unixSecondsToISOString(createdAt)
	album.UpdatedAt = unixSecondsToISOString(updatedAt)
	album.PhotoIDs = []string{}
	owners, err := r.ownerMap(ctx, []Album{album})
	if err != nil {
		return Album{}, err
	}
	album.Owner = owners[album.OwnerUserID]
	photoIDs, err := r.photoIDsForAlbum(ctx, id)
	if err != nil {
		return Album{}, err
	}
	album.PhotoIDs = photoIDs
	return album, nil
}

func (r *Repository) CountPublic(ctx context.Context) (int64, error) {
	var count int64
	if err := r.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM albums WHERE is_hidden = 0
	`).Scan(&count); err != nil {
		return 0, fmt.Errorf("count public albums: %w", err)
	}
	return count, nil
}

// ListByPhoto returns albums containing photoID in the same order as the
// Node route. Anonymous callers see public albums only; an authenticated user
// also sees their own hidden albums, while administrators see all albums.
func (r *Repository) ListByPhoto(
	ctx context.Context,
	photoID string,
	userID *int64,
	isAdmin bool,
) ([]PhotoAlbum, error) {
	query := `
		SELECT a.id, a.title, a.description, a.cover_photo_id,
		       a.created_at, a.updated_at
		FROM albums AS a
		INNER JOIN album_photos AS ap ON a.id = ap.album_id
		WHERE ap.photo_id = ?
	`
	args := []any{photoID}
	if !isAdmin {
		if userID == nil {
			query += " AND a.is_hidden = 0"
		} else {
			query += " AND (a.is_hidden = 0 OR a.owner_user_id = ?)"
			args = append(args, *userID)
		}
	}
	query += " ORDER BY ap.position ASC, a.id ASC"

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list albums for photo %s: %w", photoID, err)
	}
	defer rows.Close()

	result := make([]PhotoAlbum, 0)
	for rows.Next() {
		var (
			album     PhotoAlbum
			createdAt int64
			updatedAt int64
		)
		if err := rows.Scan(
			&album.ID,
			&album.Title,
			&album.Description,
			&album.CoverPhotoID,
			&createdAt,
			&updatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan albums for photo %s: %w", photoID, err)
		}
		album.CreatedAt = unixSecondsToISOString(createdAt)
		album.UpdatedAt = unixSecondsToISOString(updatedAt)
		result = append(result, album)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate albums for photo %s: %w", photoID, err)
	}
	return result, nil
}

func (r *Repository) IsPublicWithinLimit(
	ctx context.Context,
	id int64,
	limit int64,
) (bool, error) {
	if limit <= 0 {
		return false, nil
	}
	var found int64
	err := r.db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM (
			SELECT id
			FROM albums
			WHERE is_hidden = 0
			ORDER BY position ASC, id ASC
			LIMIT ?
		) AS visible
		WHERE visible.id = ?
	`, limit, id).Scan(&found)
	if err != nil {
		return false, fmt.Errorf("check public album access: %w", err)
	}
	return found > 0, nil
}

func (r *Repository) ownerMap(ctx context.Context, albums []Album) (map[int64]*Owner, error) {
	owners := make(map[int64]*Owner)
	for _, album := range albums {
		if _, ok := owners[album.OwnerUserID]; ok {
			continue
		}
		var owner Owner
		if err := r.db.QueryRowContext(ctx, `
			SELECT id, name, avatar, is_admin FROM users WHERE id = ?
		`, album.OwnerUserID).Scan(&owner.ID, &owner.Username, &owner.Avatar, &owner.IsAdmin); err != nil {
			return nil, fmt.Errorf("load album owner %d: %w", album.OwnerUserID, err)
		}
		owners[album.OwnerUserID] = &owner
	}
	return owners, nil
}

func (r *Repository) photoIDsByAlbum(ctx context.Context) (map[int64][]string, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT album_id, photo_id FROM album_photos
		ORDER BY album_id ASC, position ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("list album photos: %w", err)
	}
	defer rows.Close()

	result := make(map[int64][]string)
	for rows.Next() {
		var albumID int64
		var photoID string
		if err := rows.Scan(&albumID, &photoID); err != nil {
			return nil, fmt.Errorf("scan album photo: %w", err)
		}
		result[albumID] = append(result[albumID], photoID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate album photos: %w", err)
	}
	return result, nil
}

func (r *Repository) photoIDsForAlbum(ctx context.Context, albumID int64) ([]string, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT photo_id
		FROM album_photos
		WHERE album_id = ?
		ORDER BY position ASC
	`, albumID)
	if err != nil {
		return nil, fmt.Errorf("list album %d photos: %w", albumID, err)
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var photoID string
		if err := rows.Scan(&photoID); err != nil {
			return nil, fmt.Errorf("scan album %d photo: %w", albumID, err)
		}
		ids = append(ids, photoID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate album %d photos: %w", albumID, err)
	}
	return ids, nil
}

func unixSecondsToISOString(value int64) string {
	return time.Unix(value, 0).UTC().Format("2006-01-02T15:04:05.000Z")
}
