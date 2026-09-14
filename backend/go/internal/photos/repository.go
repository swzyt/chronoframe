package photos

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/auth"
	"github.com/swzyt/chronoframe/backend/go/internal/media"
)

type Record struct {
	ID                string
	Title             *string
	Description       *string
	Width             *int64
	Height            *int64
	AspectRatio       *float64
	MediaType         string
	Duration          *float64
	VideoCodec        *string
	AudioCodec        *string
	VideoPlaybackKey  *string
	DateTaken         *string
	StorageKey        *string
	ContentHash       *string
	ThumbnailKey      *string
	DisplayKey        *string
	FileSize          *int64
	LastModified      *string
	OriginalURL       *string
	ThumbnailURL      *string
	ThumbnailHash     *string
	Tags              any
	Exif              any
	Latitude          *float64
	Longitude         *float64
	Country           *string
	City              *string
	LocationName      *string
	IsLivePhoto       int64
	LivePhotoVideoURL *string
	LivePhotoVideoKey *string
	OwnerUserID       int64
}

type Marker struct {
	ID            string
	Title         *string
	Latitude      float64
	Longitude     float64
	ThumbnailKey  *string
	ThumbnailHash *string
	DateTaken     *string
	City          *string
	Exif          any
}

type Repository struct {
	db *sql.DB
}

type ManageListOptions struct {
	UserID    int64
	IsAdmin   bool
	Page      int64
	PageSize  int64
	Paginated bool
	Search    string
	MediaType string
}

type AlbumSummary struct {
	ID          int64  `json:"id"`
	Title       string `json:"title"`
	IsHidden    bool   `json:"isHidden"`
	OwnerUserID int64  `json:"ownerUserId"`
}

type ManageListResult struct {
	Items      []Record
	Total      int64
	TotalPages int64
}

var ReactionTypes = [...]string{
	"like",
	"love",
	"amazing",
	"funny",
	"wow",
	"sad",
	"fire",
	"sparkle",
}

func NewSQLiteRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

func (r *Repository) ListPublic(ctx context.Context, limit int64) ([]Record, error) {
	query := `
		SELECT id, title, description, width, height, aspect_ratio, media_type,
		       duration, video_codec, audio_codec, video_playback_key, date_taken,
		       storage_key, content_hash, thumbnail_key, display_key, file_size,
		       last_modified, original_url, thumbnail_url, thumbnail_hash, tags,
		       exif, latitude, longitude, country, city, location_name,
		       is_live_photo, live_photo_video_url, live_photo_video_key, owner_user_id
		FROM photos
		WHERE NOT EXISTS (
			SELECT 1
			FROM album_photos AS hidden_album_photos
			INNER JOIN albums AS hidden_albums
			  ON hidden_albums.id = hidden_album_photos.album_id
			WHERE hidden_album_photos.photo_id = photos.id
			  AND hidden_albums.is_hidden = 1
		)
		ORDER BY last_modified DESC, date_taken DESC
	`
	args := []any{}
	if limit > 0 {
		query += " LIMIT ?"
		args = append(args, limit)
	}
	return r.query(ctx, query, args...)
}

func (r *Repository) ListByIDs(
	ctx context.Context,
	ids []string,
) ([]Record, error) {
	if len(ids) == 0 {
		return []Record{}, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for index, id := range ids {
		placeholders[index] = "?"
		args[index] = id
	}
	return r.query(ctx, `
		SELECT id, title, description, width, height, aspect_ratio, media_type,
		       duration, video_codec, audio_codec, video_playback_key, date_taken,
		       storage_key, content_hash, thumbnail_key, display_key, file_size,
		       last_modified, original_url, thumbnail_url, thumbnail_hash, tags,
		       exif, latitude, longitude, country, city, location_name,
		       is_live_photo, live_photo_video_url, live_photo_video_key, owner_user_id
		FROM photos
		WHERE id IN (`+strings.Join(placeholders, ",")+`)
	`, args...)
}

func (r *Repository) FindByID(ctx context.Context, id string) (Record, error) {
	records, err := r.query(ctx, `
		SELECT id, title, description, width, height, aspect_ratio, media_type,
		       duration, video_codec, audio_codec, video_playback_key, date_taken,
		       storage_key, content_hash, thumbnail_key, display_key, file_size,
		       last_modified, original_url, thumbnail_url, thumbnail_hash, tags,
		       exif, latitude, longitude, country, city, location_name,
		       is_live_photo, live_photo_video_url, live_photo_video_key, owner_user_id
		FROM photos
		WHERE id = ?
	`, id)
	if err != nil {
		return Record{}, err
	}
	if len(records) == 0 {
		return Record{}, sql.ErrNoRows
	}
	return records[0], nil
}

func (r *Repository) ReactionCounts(
	ctx context.Context,
	ids []string,
) (map[string]map[string]int64, error) {
	result := make(map[string]map[string]int64, len(ids))
	placeholders := make([]string, 0, len(ids))
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		if _, exists := result[id]; exists {
			continue
		}
		counts := make(map[string]int64, len(ReactionTypes))
		for _, reactionType := range ReactionTypes {
			counts[reactionType] = 0
		}
		result[id] = counts
		// Node preserves an empty string when ids is a repeated query value and
		// returns an all-zero bucket for it. It does not need to participate in
		// the SQL IN clause, but it must remain in the response map.
		if id == "" {
			continue
		}
		placeholders = append(placeholders, "?")
		args = append(args, id)
	}
	if len(placeholders) == 0 {
		return result, nil
	}

	rows, err := r.db.QueryContext(ctx, `
		SELECT photo_id, reaction_type, COUNT(*)
		FROM photo_reactions
		WHERE photo_id IN (`+strings.Join(placeholders, ",")+`)
		GROUP BY photo_id, reaction_type
	`, args...)
	if err != nil {
		return nil, fmt.Errorf("list photo reaction counts: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			photoID      string
			reactionType string
			count        int64
		)
		if err := rows.Scan(&photoID, &reactionType, &count); err != nil {
			return nil, fmt.Errorf("scan photo reaction count: %w", err)
		}
		if counts, exists := result[photoID]; exists {
			counts[reactionType] = count
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate photo reaction counts: %w", err)
	}
	return result, nil
}

func (r *Repository) ReactionForFingerprint(
	ctx context.Context,
	photoID string,
	fingerprint string,
) (*string, error) {
	var reactionType string
	err := r.db.QueryRowContext(ctx, `
		SELECT reaction_type
		FROM photo_reactions
		WHERE photo_id = ? AND fingerprint = ?
		LIMIT 1
	`, photoID, fingerprint).Scan(&reactionType)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find reaction for photo %s: %w", photoID, err)
	}
	return &reactionType, nil
}

func (r *Repository) CountPublic(ctx context.Context) (int64, error) {
	var count int64
	err := r.db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM photos
		WHERE NOT EXISTS (
			SELECT 1
			FROM album_photos AS hidden_album_photos
			INNER JOIN albums AS hidden_albums
			  ON hidden_albums.id = hidden_album_photos.album_id
			WHERE hidden_album_photos.photo_id = photos.id
			  AND hidden_albums.is_hidden = 1
		)
	`).Scan(&count)
	return count, err
}

func (r *Repository) ListPublicMarkers(
	ctx context.Context,
	limit int64,
	bounds *Bounds,
) ([]Marker, error) {
	query := `
		SELECT id, title, latitude, longitude, thumbnail_key,
		       thumbnail_hash, date_taken, city, exif
		FROM photos
		WHERE latitude IS NOT NULL
		  AND longitude IS NOT NULL
		  AND NOT EXISTS (
			SELECT 1
			FROM album_photos AS hidden_album_photos
			INNER JOIN albums AS hidden_albums
			  ON hidden_albums.id = hidden_album_photos.album_id
			WHERE hidden_album_photos.photo_id = photos.id
			  AND hidden_albums.is_hidden = 1
		  )
	`
	args := make([]any, 0, 7)
	if bounds != nil {
		if bounds.West <= bounds.East {
			query += `
			  AND longitude >= ?
			  AND longitude <= ?
			`
			args = append(args, bounds.West, bounds.East)
		} else {
			query += `
			  AND (longitude >= ? OR longitude <= ?)
			`
			args = append(args, bounds.West, bounds.East)
		}
		query += `
		  AND latitude >= ?
		  AND latitude <= ?
		`
		args = append(args, bounds.South, bounds.North)
	}
	query += " ORDER BY last_modified DESC, date_taken DESC"
	if limit > 0 {
		query += " LIMIT ?"
		args = append(args, limit)
	}

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list public photo markers: %w", err)
	}
	defer rows.Close()

	result := make([]Marker, 0)
	for rows.Next() {
		var (
			marker Marker
			exif   sql.NullString
		)
		if err := rows.Scan(
			&marker.ID,
			&marker.Title,
			&marker.Latitude,
			&marker.Longitude,
			&marker.ThumbnailKey,
			&marker.ThumbnailHash,
			&marker.DateTaken,
			&marker.City,
			&exif,
		); err != nil {
			return nil, fmt.Errorf("scan public photo marker: %w", err)
		}
		marker.Exif = parseJSON(exif)
		result = append(result, marker)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate public photo markers: %w", err)
	}
	return result, nil
}

func (r *Repository) ListRecentForStatus(
	ctx context.Context,
	userID int64,
	isAdmin bool,
	limit int64,
) ([]Record, error) {
	query := `
		SELECT id, title, description, width, height, aspect_ratio, media_type,
		       duration, video_codec, audio_codec, video_playback_key, date_taken,
		       storage_key, content_hash, thumbnail_key, display_key, file_size,
		       last_modified, original_url, thumbnail_url, thumbnail_hash, tags,
		       exif, latitude, longitude, country, city, location_name,
		       is_live_photo, live_photo_video_url, live_photo_video_key, owner_user_id
		FROM photos
	`
	args := []any{}
	if !isAdmin {
		query += " WHERE owner_user_id = ?"
		args = append(args, userID)
	}
	query += " ORDER BY last_modified ASC LIMIT ?"
	args = append(args, limit)
	return r.query(ctx, query, args...)
}

// ListManage implements the administrator/user photo inventory used by the
// dashboard. It intentionally returns the same raw photo projection as the
// Node handler; response decoration (owners, albums and pagination metadata)
// stays in the application layer.
func (r *Repository) ListManage(
	ctx context.Context,
	options ManageListOptions,
) (ManageListResult, error) {
	conditions := make([]string, 0, 3)
	args := make([]any, 0, 5)
	if !options.IsAdmin {
		conditions = append(conditions, "owner_user_id = ?")
		args = append(args, options.UserID)
	}
	if options.MediaType == "image" || options.MediaType == "video" {
		conditions = append(conditions, "media_type = ?")
		args = append(args, options.MediaType)
	}
	if strings.TrimSpace(options.Search) != "" {
		escaped := strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(
			options.Search, `\`, `\\`), `%`, `\%`), `_`, `\_`)
		pattern := "%" + escaped + "%"
		conditions = append(conditions, `(
			id LIKE ? OR title LIKE ? OR description LIKE ? OR city LIKE ?
			OR country LIKE ? OR location_name LIKE ? OR storage_key LIKE ?
		)`)
		for index := 0; index < 7; index++ {
			args = append(args, pattern)
		}
	}

	where := ""
	if len(conditions) > 0 {
		where = " WHERE " + strings.Join(conditions, " AND ")
	}

	result := ManageListResult{}
	if options.Paginated {
		if err := r.db.QueryRowContext(ctx,
			"SELECT COUNT(*) FROM photos"+where, args...,
		).Scan(&result.Total); err != nil {
			return ManageListResult{}, fmt.Errorf("count managed photos: %w", err)
		}
		pageSize := options.PageSize
		if pageSize <= 0 {
			pageSize = 50
		}
		result.TotalPages = (result.Total + pageSize - 1) / pageSize
		if result.TotalPages < 1 {
			result.TotalPages = 1
		}
	}

	query := `
		SELECT id, title, description, width, height, aspect_ratio, media_type,
		       duration, video_codec, audio_codec, video_playback_key, date_taken,
		       storage_key, content_hash, thumbnail_key, display_key, file_size,
		       last_modified, original_url, thumbnail_url, thumbnail_hash, tags,
		       exif, latitude, longitude, country, city, location_name,
		       is_live_photo, live_photo_video_url, live_photo_video_key, owner_user_id
		FROM photos` + where + `
		ORDER BY COALESCE(last_modified, '') DESC,
		         COALESCE(date_taken, '') DESC,
		         id DESC`
	if options.Paginated {
		page := options.Page
		if page < 1 {
			page = 1
		}
		pageSize := options.PageSize
		if pageSize <= 0 {
			pageSize = 50
		}
		query += " LIMIT ? OFFSET ?"
		args = append(args, pageSize, (page-1)*pageSize)
	}
	items, err := r.query(ctx, query, args...)
	if err != nil {
		return ManageListResult{}, fmt.Errorf("list managed photos: %w", err)
	}
	result.Items = items
	return result, nil
}

func (r *Repository) AlbumsForPhotos(
	ctx context.Context,
	photoIDs []string,
) (map[string][]AlbumSummary, error) {
	result := make(map[string][]AlbumSummary, len(photoIDs))
	if len(photoIDs) == 0 {
		return result, nil
	}
	unique := make([]string, 0, len(photoIDs))
	seen := make(map[string]struct{}, len(photoIDs))
	for _, id := range photoIDs {
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
		result[id] = []AlbumSummary{}
	}
	if len(unique) == 0 {
		return result, nil
	}
	placeholders := make([]string, len(unique))
	args := make([]any, len(unique))
	for index, id := range unique {
		placeholders[index] = "?"
		args[index] = id
	}
	rows, err := r.db.QueryContext(ctx, `
		SELECT ap.photo_id, a.id, a.title, a.is_hidden, a.owner_user_id
		FROM album_photos AS ap
		INNER JOIN albums AS a ON a.id = ap.album_id
		WHERE ap.photo_id IN (`+strings.Join(placeholders, ",")+`)
		ORDER BY ap.photo_id ASC, ap.position ASC, a.id ASC
	`, args...)
	if err != nil {
		return nil, fmt.Errorf("list photo albums: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			photoID string
			album   AlbumSummary
			hidden  int64
		)
		if err := rows.Scan(
			&photoID, &album.ID, &album.Title, &hidden, &album.OwnerUserID,
		); err != nil {
			return nil, fmt.Errorf("scan photo album: %w", err)
		}
		album.IsHidden = hidden != 0
		result[photoID] = append(result[photoID], album)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate photo albums: %w", err)
	}
	return result, nil
}

func (r *Repository) ListByAlbum(ctx context.Context, albumID int64) ([]Record, error) {
	return r.query(ctx, `
		SELECT p.id, p.title, p.description, p.width, p.height, p.aspect_ratio, p.media_type,
		       p.duration, p.video_codec, p.audio_codec, p.video_playback_key, p.date_taken,
		       p.storage_key, p.content_hash, p.thumbnail_key, p.display_key, p.file_size,
		       p.last_modified, p.original_url, p.thumbnail_url, p.thumbnail_hash, p.tags,
		       p.exif, p.latitude, p.longitude, p.country, p.city, p.location_name,
		       p.is_live_photo, p.live_photo_video_url, p.live_photo_video_key, p.owner_user_id
		FROM photos AS p
		INNER JOIN album_photos AS ap ON p.id = ap.photo_id
		WHERE ap.album_id = ?
		ORDER BY ap.position ASC
	`, albumID)
}

type Bounds struct {
	West  float64
	East  float64
	South float64
	North float64
}

func (r *Repository) query(
	ctx context.Context,
	query string,
	args ...any,
) ([]Record, error) {
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query photos: %w", err)
	}
	defer rows.Close()

	result := make([]Record, 0)
	for rows.Next() {
		var (
			record Record
			tags   sql.NullString
			exif   sql.NullString
		)
		if err := rows.Scan(
			&record.ID,
			&record.Title,
			&record.Description,
			&record.Width,
			&record.Height,
			&record.AspectRatio,
			&record.MediaType,
			&record.Duration,
			&record.VideoCodec,
			&record.AudioCodec,
			&record.VideoPlaybackKey,
			&record.DateTaken,
			&record.StorageKey,
			&record.ContentHash,
			&record.ThumbnailKey,
			&record.DisplayKey,
			&record.FileSize,
			&record.LastModified,
			&record.OriginalURL,
			&record.ThumbnailURL,
			&record.ThumbnailHash,
			&tags,
			&exif,
			&record.Latitude,
			&record.Longitude,
			&record.Country,
			&record.City,
			&record.LocationName,
			&record.IsLivePhoto,
			&record.LivePhotoVideoURL,
			&record.LivePhotoVideoKey,
			&record.OwnerUserID,
		); err != nil {
			return nil, fmt.Errorf("scan photo: %w", err)
		}
		record.Tags = parseJSON(tags)
		record.Exif = parseJSON(exif)
		result = append(result, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate photos: %w", err)
	}
	return result, nil
}

func parseJSON(value sql.NullString) any {
	if !value.Valid || strings.TrimSpace(value.String) == "" {
		return nil
	}
	var parsed any
	if err := json.Unmarshal([]byte(value.String), &parsed); err != nil {
		return nil
	}
	return parsed
}

func PublicPhoto(
	record Record,
	owner *auth.User,
	accessVersion string,
) (map[string]any, error) {
	originalKey := record.StorageKey
	if record.VideoPlaybackKey != nil && *record.VideoPlaybackKey != "" {
		originalKey = record.VideoPlaybackKey
	}
	originalURL := originalProxyURL(record.OriginalURL, originalKey)
	displayURL := originalURL
	if record.MediaType != "video" {
		displayURL = stringPointer("/display/" + url.PathEscape(record.ID))
	}

	photo := map[string]any{
		"id":                record.ID,
		"title":             record.Title,
		"description":       record.Description,
		"width":             record.Width,
		"height":            record.Height,
		"aspectRatio":       record.AspectRatio,
		"mediaType":         record.MediaType,
		"duration":          record.Duration,
		"videoCodec":        record.VideoCodec,
		"audioCodec":        record.AudioCodec,
		"dateTaken":         record.DateTaken,
		"contentHash":       record.ContentHash,
		"fileSize":          record.FileSize,
		"lastModified":      record.LastModified,
		"thumbnailHash":     record.ThumbnailHash,
		"tags":              record.Tags,
		"exif":              record.Exif,
		"latitude":          record.Latitude,
		"longitude":         record.Longitude,
		"country":           record.Country,
		"city":              record.City,
		"locationName":      record.LocationName,
		"isLivePhoto":       record.IsLivePhoto,
		"originalUrl":       originalURL,
		"displayUrl":        displayURL,
		"thumbnailUrl":      nil,
		"livePhotoVideoUrl": nil,
		"owner":             nil,
		"ogThumbnailUrl":    nil,
	}
	if record.ThumbnailKey != nil && *record.ThumbnailKey != "" {
		photo["thumbnailUrl"] = "/image/" + encodeStorageKey(*record.ThumbnailKey)
		photo["livePhotoVideoUrl"] = nil
		token, err := media.CreateOGMediaToken(record.ID, *record.ThumbnailKey, accessVersion)
		if err != nil {
			return nil, err
		}
		photo["ogThumbnailUrl"] = "/og-media/" + url.PathEscape(record.ID) +
			"?token=" + url.QueryEscape(token)
	}
	if record.LivePhotoVideoKey != nil && *record.LivePhotoVideoKey != "" {
		photo["livePhotoVideoUrl"] = "/image/" + encodeStorageKey(*record.LivePhotoVideoKey)
	}
	if owner != nil {
		photo["owner"] = map[string]any{
			"id":       owner.ID,
			"username": owner.Username,
			"avatar":   owner.Avatar,
			"isAdmin":  owner.IsAdmin,
		}
	}
	return photo, nil
}

func (r *Repository) Owners(
	ctx context.Context,
	records []Record,
) (map[int64]*auth.User, error) {
	owners := make(map[int64]*auth.User)
	for _, record := range records {
		if _, exists := owners[record.OwnerUserID]; exists {
			continue
		}
		var (
			user      auth.User
			createdAt int64
			isActive  int64
		)
		if err := r.db.QueryRowContext(ctx, `
			SELECT id, name, email, avatar, created_at, is_admin, is_active, auth_version
			FROM users
			WHERE id = ?
		`, record.OwnerUserID).Scan(
			&user.ID,
			&user.Username,
			&user.Email,
			&user.Avatar,
			&createdAt,
			&user.IsAdmin,
			&isActive,
			&user.AuthVersion,
		); err != nil {
			return nil, fmt.Errorf("load photo owner %d: %w", record.OwnerUserID, err)
		}
		user.CreatedAt = time.Unix(createdAt, 0).UTC().Format("2006-01-02T15:04:05.000Z")
		user.IsActive = isActive != 0
		owners[record.OwnerUserID] = &user
	}
	return owners, nil
}

func originalProxyURL(original *string, storageKey *string) *string {
	if original != nil {
		if strings.HasPrefix(*original, "/image/") {
			return original
		}
		if strings.HasPrefix(*original, "/storage/") {
			value := "/image/" + encodeStorageKey(strings.TrimPrefix(*original, "/storage/"))
			return &value
		}
	}
	if storageKey == nil || *storageKey == "" {
		return nil
	}
	value := "/image/" + encodeStorageKey(*storageKey)
	return &value
}

func encodeStorageKey(key string) string {
	parts := strings.Split(strings.TrimPrefix(key, "/"), "/")
	for index, part := range parts {
		parts[index] = encodeStorageSegment(part)
	}
	return strings.Join(parts, "/")
}

// Node's encodeURI leaves the RFC3986 sub-delimiters "!'()*" readable while
// escaping spaces and path-breaking bytes. url.PathEscape is stricter and
// escapes parentheses, which makes otherwise identical photo URLs differ
// between the two backends.
func encodeStorageSegment(value string) string {
	escaped := url.PathEscape(value)
	replacer := strings.NewReplacer(
		"%21", "!",
		"%27", "'",
		"%28", "(",
		"%29", ")",
		"%2A", "*",
		"%2a", "*",
	)
	return replacer.Replace(escaped)
}

func stringPointer(value string) *string {
	return &value
}
