package app

import (
	"context"
	"database/sql"
	"errors"
	"path"
	"strings"

	"github.com/swzyt/chronoframe/backend/go/internal/media"
)

type livePhotoCandidate struct {
	ID         string
	StorageKey *string
}

type livePhotoScanResult struct {
	Processed int      `json:"processed"`
	Matched   int      `json:"matched"`
	Errors    []string `json:"errors"`
}

func emptyLivePhotoScanResult() livePhotoScanResult {
	return livePhotoScanResult{Errors: []string{}}
}

func livePhotoVideoKeysForImage(imageKey string) []string {
	base := strings.TrimSuffix(path.Base(imageKey), path.Ext(imageKey))
	dir := path.Dir(imageKey)
	return []string{
		path.Join(dir, base+".MOV"),
		path.Join(dir, base+".mov"),
	}
}

func livePhotoImageKeysForVideo(videoKey string) []string {
	base := strings.TrimSuffix(path.Base(videoKey), path.Ext(videoKey))
	dir := path.Dir(videoKey)
	keys := []string{
		path.Join(dir, base+".HEIC"),
		path.Join(dir, base+".heic"),
		path.Join(dir, base+".HEIF"),
		path.Join(dir, base+".heif"),
		path.Join(dir, base+".JPG"),
		path.Join(dir, base+".jpg"),
		path.Join(dir, base+".JPEG"),
		path.Join(dir, base+".jpeg"),
	}
	for index := range keys {
		keys[index] = strings.ReplaceAll(keys[index], "\\", "/")
	}
	return keys
}

func isLivePhotoVideoKey(key string, size int64) bool {
	return strings.EqualFold(path.Ext(key), ".mov") && size >= 0 && size <= 100*1024*1024
}

func (a *Application) findLivePhotoVideo(
	ctx context.Context,
	provider *media.Provider,
	imageKey string,
) (string, int64, bool) {
	for _, videoKey := range livePhotoVideoKeysForImage(imageKey) {
		contents, _, err := provider.Get(ctx, videoKey)
		size := int64(len(contents))
		if err == nil && isLivePhotoVideoKey(videoKey, size) {
			return videoKey, size, true
		}
	}
	return "", 0, false
}

func (a *Application) findPhotoForLiveVideo(
	ctx context.Context,
	videoKey string,
) (string, bool) {
	// Node queries each candidate independently and returns the first match in
	// HEIC/HEIF/JPG/JPEG case-variant order. An unordered SQL IN query can pick
	// a different row when multiple same-basename records exist.
	for _, key := range livePhotoImageKeysForVideo(videoKey) {
		var id string
		err := a.database.SQL().QueryRowContext(ctx,
			"SELECT id FROM photos WHERE storage_key = ? LIMIT 1",
			key,
		).Scan(&id)
		if err == nil {
			return id, true
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return "", false
		}
	}
	return "", false
}

func (a *Application) livePhotoCandidates(
	ctx context.Context,
	ids []any,
) ([]livePhotoCandidate, error) {
	query := "SELECT id, storage_key FROM photos WHERE is_live_photo = 0"
	args := []any{}
	if len(ids) > 0 {
		placeholders := make([]string, len(ids))
		args = make([]any, len(ids))
		for index, id := range ids {
			placeholders[index], args[index] = "?", id
		}
		query += " AND id IN (" + strings.Join(placeholders, ",") + ")"
	}
	rows, err := a.database.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]livePhotoCandidate, 0)
	for rows.Next() {
		var item livePhotoCandidate
		var key sql.NullString
		if err := rows.Scan(&item.ID, &key); err != nil {
			return nil, err
		}
		if key.Valid {
			item.StorageKey = &key.String
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (a *Application) publicStorageURL(provider *media.Provider, key string) string {
	if provider == nil {
		return ""
	}
	return provider.PublicURL(key)
}
