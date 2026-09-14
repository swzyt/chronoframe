package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/auth"
	"github.com/swzyt/chronoframe/backend/go/internal/media"
	"github.com/swzyt/chronoframe/backend/go/internal/photos"
	"github.com/swzyt/chronoframe/backend/go/internal/platform/httpx"
	"github.com/swzyt/chronoframe/backend/go/internal/platform/redisx"
	"github.com/swzyt/chronoframe/backend/go/internal/settings"
	"github.com/swzyt/chronoframe/backend/go/internal/uploads"
)

const (
	photoReactionRateLimitWindow = time.Minute
	photoReactionRateLimitMax    = 10
)

var heicStorageExtensions = [...]string{".heic", ".heif", ".hif"}

var errQueueClearQueryShape = errors.New("queue clear query contains an array value")

func (a *Application) photoUpdate(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	photoID := r.PathValue("photoID")
	if photoID == "" {
		httpx.Error(w, http.StatusBadRequest, "Photo ID is required")
		return
	}
	body, ok := decodePhotoUpdateBody(w, r)
	if !ok {
		return
	}
	if body.Title == nil && body.Description == nil && body.Tags == nil &&
		!body.Location.Present && !body.Rating.Present {
		httpx.Error(w, http.StatusBadRequest, "No changes to apply")
		return
	}
	photo, err := a.photos.FindByID(r.Context(), photoID)
	if err != nil || !(user.IsAdmin != 0 || photo.OwnerUserID == user.ID) {
		httpx.Error(w, http.StatusNotFound, "Photo not found")
		return
	}
	if photo.StorageKey == nil || strings.TrimSpace(*photo.StorageKey) == "" {
		httpx.Error(w, http.StatusBadRequest, "Unable to process: missing storage information")
		return
	}
	provider, providerErr := a.mediaProvider(r.Context())
	if providerErr != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to update photo metadata")
		return
	}
	originalBuffer, _, providerErr := provider.Get(r.Context(), *photo.StorageKey)
	if providerErr != nil || len(originalBuffer) == 0 {
		httpx.Error(w, http.StatusNotFound, "Photo file is missing")
		return
	}
	exifUpdates := make(map[string]any)
	normalizedTitle := body.Title
	if body.Title != nil {
		var exifValue any
		if *body.Title != "" {
			exifValue = *body.Title
		}
		exifUpdates["Title"] = exifValue
		exifUpdates["XPTitle"] = exifValue
	}
	normalizedDescription := body.Description
	if body.Description != nil {
		var exifValue any
		if *body.Description != "" {
			exifValue = *body.Description
		}
		exifUpdates["Description"] = exifValue
		exifUpdates["ImageDescription"] = exifValue
		exifUpdates["CaptionAbstract"] = exifValue
		exifUpdates["XPComment"] = exifValue
		exifUpdates["UserComment"] = exifValue
	}
	var normalizedTags []string
	tagsDefined := false
	if body.Tags != nil {
		tags, _ := normalizeTags(*body.Tags)
		normalizedTags = tags
		tagsDefined = true
		var exifValue any
		if len(tags) > 0 {
			exifValue = tags
		}
		exifUpdates["Subject"] = exifValue
		exifUpdates["Keywords"] = exifValue
		if len(tags) > 0 {
			exifUpdates["XPKeywords"] = strings.Join(tags, "; ")
		} else {
			exifUpdates["XPKeywords"] = nil
		}
	}
	locationDefined := body.Location.Present
	locationCleared := body.Location.Present && body.Location.Value == nil
	var locationValue photoUpdateLocation
	if body.Location.Present {
		if locationCleared {
			locationCleared = true
			exifUpdates["GPSLatitude"] = nil
			exifUpdates["GPSLatitudeRef"] = nil
			exifUpdates["GPSLongitude"] = nil
			exifUpdates["GPSLongitudeRef"] = nil
			exifUpdates["GPSPosition"] = nil
		} else {
			locationValue = *body.Location.Value
			latitudeAbs := locationValue.Latitude
			if latitudeAbs < 0 {
				latitudeAbs = -latitudeAbs
			}
			longitudeAbs := locationValue.Longitude
			if longitudeAbs < 0 {
				longitudeAbs = -longitudeAbs
			}
			exifUpdates["GPSLatitude"] = latitudeAbs
			if locationValue.Latitude >= 0 {
				exifUpdates["GPSLatitudeRef"] = "N"
			} else {
				exifUpdates["GPSLatitudeRef"] = "S"
			}
			exifUpdates["GPSLongitude"] = longitudeAbs
			if locationValue.Longitude >= 0 {
				exifUpdates["GPSLongitudeRef"] = "E"
			} else {
				exifUpdates["GPSLongitudeRef"] = "W"
			}
			// exiftool-vendored overwrites GPSPosition from the numeric
			// GPSLatitude/GPSLongitude values supplied above. Those values are
			// absolute, even when the explicit ref is S/W.
			exifUpdates["GPSPosition"] = strconv.FormatFloat(latitudeAbs, 'f', -1, 64) + "," +
				strconv.FormatFloat(longitudeAbs, 'f', -1, 64)
		}
	}
	if body.Rating.Present {
		if body.Rating.Value == nil {
			exifUpdates["Rating"] = nil
		} else {
			exifUpdates["Rating"] = *body.Rating.Value
		}
	}

	updatedBuffer, updateErr := rewriteExifMetadata(r.Context(), *photo.StorageKey, originalBuffer, exifUpdates)
	if updateErr != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to update photo metadata")
		return
	}
	if _, updateErr := provider.Put(r.Context(), *photo.StorageKey, bytes.NewReader(updatedBuffer), int64(len(updatedBuffer)), ""); updateErr != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to update photo metadata")
		return
	}
	updatedExif, updateErr := extractExif(r.Context(), *photo.StorageKey, updatedBuffer)
	if updateErr != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to update photo metadata")
		return
	}
	exifJSON, updateErr := json.Marshal(updatedExif)
	if updateErr != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to update photo metadata")
		return
	}

	sets, args := make([]string, 0, 12), make([]any, 0, 12)
	sets = append(sets, "exif = ?", "file_size = ?", "last_modified = ?")
	args = append(args, string(exifJSON), len(updatedBuffer), javascriptDateISOString(a.now()))
	if normalizedTitle != nil {
		sets, args = append(sets, "title = ?"), append(args, albumEmptyStringAsNil(normalizedTitle))
	}
	if normalizedDescription != nil {
		sets, args = append(sets, "description = ?"), append(args, albumEmptyStringAsNil(normalizedDescription))
	}
	if tagsDefined {
		encoded, _ := json.Marshal(normalizedTags)
		sets, args = append(sets, "tags = ?"), append(args, string(encoded))
	}
	if locationDefined {
		if locationCleared {
			sets = append(sets, "latitude = NULL", "longitude = NULL", "country = NULL", "city = NULL", "location_name = NULL")
		} else {
			sets = append(sets, "latitude = ?", "longitude = ?", "country = NULL", "city = NULL", "location_name = NULL")
			args = append(args, locationValue.Latitude, locationValue.Longitude)
		}
	}
	args = append(args, photoID)
	if _, err := a.database.SQL().ExecContext(r.Context(),
		"UPDATE photos SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to update photo metadata")
		return
	}
	if locationDefined && !locationCleared {
		if _, err := a.enqueueTask(r.Context(), map[string]any{
			"type":      "photo-reverse-geocoding",
			"photoId":   photoID,
			"latitude":  locationValue.Latitude,
			"longitude": locationValue.Longitude,
		}, 1, 3, photo.OwnerUserID); err != nil && a.logger != nil {
			a.logger.Warn("failed to enqueue reverse geocoding after photo update", "photoId", photoID, "error", err)
		}
	}
	photo, err = a.photos.FindByID(r.Context(), photoID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"success": true,
		"photo":   privatePhotoRecord(photo),
	})
}

func normalizeTags(input []string) ([]string, bool) {
	if len(input) > 64 {
		return nil, false
	}
	result := make([]string, 0, len(input))
	seen := map[string]struct{}{}
	for _, value := range input {
		value = jsTrimSpace(value)
		if jsStringLength(value) > 128 {
			return nil, false
		}
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, value)
	}
	return result, true
}

func (a *Application) photoDelete(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	// Node resolves the provider before validating the route parameter. A
	// broken active storage configuration must abort the whole request rather
	// than deleting only the database row.
	provider, providerErr := a.mediaProvider(r.Context())
	if providerErr != nil {
		writeUnhandledRequestError(w)
		return
	}
	// Router parameters are identifiers, not user-entered labels. Node keeps
	// their decoded bytes intact, including whitespace, before the database
	// lookup. Trimming here changes a missing-photo 404 into an access 401.
	photoID := r.PathValue("photoID")
	if photoID == "" || !a.photoOwned(r.Context(), photoID, user) {
		httpx.Error(w, http.StatusNotFound, "Photo not found")
		return
	}
	photo, err := a.photos.FindByID(r.Context(), photoID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "Photo not found")
		return
	}
	keys := photoDeleteStorageKeys(photo)
	if len(keys) > 0 {
		// The Node route has one outer try/catch: failure of the primary or a
		// generated object stops later deletions. The converted HEIC JPEG is the
		// sole nested best-effort deletion.
		if deleteErr := provider.Delete(r.Context(), keys[0]); deleteErr == nil {
			index := 1
			if _, hasJPEG := convertedHEICJPEGKey(keys[0]); hasJPEG && index < len(keys) {
				_ = provider.Delete(r.Context(), keys[index])
				index++
			}
			for ; index < len(keys); index++ {
				if deleteErr := provider.Delete(r.Context(), keys[index]); deleteErr != nil {
					break
				}
			}
		}
	}
	if _, err := a.database.SQL().ExecContext(r.Context(), "DELETE FROM photos WHERE id = ?", photoID); err != nil {
		writeUnhandledRequestError(w)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"statusCode": 200, "statusMessage": "Photo deleted successfully",
	})
}

func photoDeleteStorageKeys(photo photos.Record) []string {
	storageKey := stringPointerValue(photo.StorageKey)
	if storageKey == "" {
		return nil
	}
	keys := []string{storageKey}
	if jpegKey, ok := convertedHEICJPEGKey(storageKey); ok {
		keys = append(keys, jpegKey)
	}
	for _, value := range []string{
		stringPointerValue(photo.ThumbnailKey),
		stringPointerValue(photo.DisplayKey),
		stringPointerValue(photo.LivePhotoVideoKey),
		stringPointerValue(photo.VideoPlaybackKey),
	} {
		if value != "" {
			keys = append(keys, value)
		}
	}
	return keys
}

func convertedHEICJPEGKey(storageKey string) (string, bool) {
	lowerStorageKey := strings.ToLower(storageKey)
	for _, extension := range heicStorageExtensions {
		if strings.HasSuffix(lowerStorageKey, extension) {
			return storageKey[:len(storageKey)-len(extension)] + ".jpeg", true
		}
	}
	return "", false
}

func stringPointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (a *Application) photoOwned(ctx context.Context, photoID string, user *auth.User) bool {
	if user == nil {
		return false
	}
	var owner int64
	if err := a.database.SQL().QueryRowContext(ctx, "SELECT owner_user_id FROM photos WHERE id = ?", photoID).Scan(&owner); err != nil {
		return false
	}
	return user.IsAdmin != 0 || owner == user.ID
}

func (a *Application) photoAlbumsUpdate(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	// Router parameters are identifiers, not user-entered labels. Node keeps
	// their decoded bytes intact, including whitespace, before the database
	// lookup. Trimming here changes a missing-photo 404 into an access 401.
	photoID := r.PathValue("photoID")
	if photoID == "" || !a.photoOwned(r.Context(), photoID, user) {
		httpx.Error(w, http.StatusNotFound, "Photo not found")
		return
	}
	body, ok := decodePhotoAlbumsUpdateBody(w, r)
	if !ok {
		return
	}
	if !a.replacePhotoAlbums(r.Context(), photoID, body.AlbumIDs, user) {
		httpx.Error(w, http.StatusNotFound, "Album not found")
		return
	}
	a.writePhotoAlbumResponse(w, r, photoID, http.StatusOK)
}

type photoAlbumsUpdateBody struct {
	AlbumIDs []int64
}

type photoAlbumsBulkUpdateBody struct {
	PhotoIDs []string
	AlbumIDs []int64
	Mode     string
}

func decodePhotoAlbumsUpdateBody(w http.ResponseWriter, r *http.Request) (photoAlbumsUpdateBody, bool) {
	var raw map[string]json.RawMessage
	if !decodeJSONBody(w, r, &raw) {
		return photoAlbumsUpdateBody{}, false
	}
	var albumIDs []int64
	if value, exists := raw["albumIds"]; exists {
		parsed, issues := decodePositiveInt64Array(value, "albumIds")
		if len(issues) > 0 {
			writeSettingZodValidationError(w, issues...)
			return photoAlbumsUpdateBody{}, false
		}
		albumIDs = parsed
	}
	return photoAlbumsUpdateBody{AlbumIDs: albumIDs}, true
}

func decodePhotoAlbumsBulkUpdateBody(w http.ResponseWriter, r *http.Request) (photoAlbumsBulkUpdateBody, bool) {
	raw, ok := decodeRequiredJSONObjectBody(w, r)
	if !ok {
		return photoAlbumsBulkUpdateBody{}, false
	}
	issues := make([]zodValidationIssue, 0)
	photoIDs := make([]string, 0)
	rawPhotoIDs, exists := raw["photoIds"]
	if !exists || zodReceivedType(rawPhotoIDs) != "array" {
		issues = append(issues, zodInvalidTypeIssue(
			[]any{"photoIds"}, "array", zodReceivedType(rawPhotoIDs),
		))
	} else {
		var values []json.RawMessage
		if err := json.Unmarshal(rawPhotoIDs, &values); err != nil {
			issues = append(issues, zodInvalidTypeIssue(
				[]any{"photoIds"}, "array", zodReceivedType(rawPhotoIDs),
			))
		} else {
			seen := make(map[string]struct{}, len(values))
			for index, value := range values {
				path := []any{"photoIds", index}
				if zodReceivedType(value) != "string" {
					issues = append(issues, zodInvalidTypeIssue(path, "string", zodReceivedType(value)))
					continue
				}
				var photoID string
				if err := json.Unmarshal(value, &photoID); err != nil {
					issues = append(issues, zodInvalidTypeIssue(path, "string", zodReceivedType(value)))
					continue
				}
				if photoID == "" {
					issues = append(issues, zodTooSmallStringIssue(path, 1))
					continue
				}
				if _, duplicate := seen[photoID]; duplicate {
					continue
				}
				seen[photoID] = struct{}{}
				photoIDs = append(photoIDs, photoID)
			}
			if len(values) < 1 {
				issues = append(issues, zodTooSmallArrayIssue(
					[]any{"photoIds"},
					1,
					"Too small: expected array to have >=1 items",
				))
			}
		}
	}
	albumIDs := []int64{}
	if rawAlbumIDs, exists := raw["albumIds"]; exists {
		parsed, albumIssues := decodePositiveInt64Array(rawAlbumIDs, "albumIds")
		issues = append(issues, albumIssues...)
		albumIDs = parsed
	}
	mode := "replace"
	if rawMode, exists := raw["mode"]; exists {
		if zodReceivedType(rawMode) != "string" || json.Unmarshal(rawMode, &mode) != nil || !validPhotoAlbumMode(mode) {
			issues = append(issues, zodEnumValidationIssue(zodEnumIssue{
				path: []any{"mode"}, values: []string{"replace", "add", "remove"},
			}))
		}
	}
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return photoAlbumsBulkUpdateBody{}, false
	}
	return photoAlbumsBulkUpdateBody{PhotoIDs: photoIDs, AlbumIDs: albumIDs, Mode: mode}, true
}

func jsonRawIsNull(raw json.RawMessage) bool {
	return strings.EqualFold(strings.TrimSpace(string(raw)), "null")
}

func decodePositiveInt64Array(raw json.RawMessage, field string) ([]int64, []zodValidationIssue) {
	return decodePositiveInt64ArrayValues(raw, field, true)
}

func decodePositiveInt64ArrayPreserve(raw json.RawMessage, field string) ([]int64, []zodValidationIssue) {
	return decodePositiveInt64ArrayValues(raw, field, false)
}

func decodePositiveInt64ArrayValues(raw json.RawMessage, field string, uniqueOnly bool) ([]int64, []zodValidationIssue) {
	if jsonRawIsNull(raw) {
		return nil, []zodValidationIssue{zodInvalidTypeIssue([]any{field}, "array", "null")}
	}
	if zodReceivedType(raw) != "array" {
		return nil, []zodValidationIssue{zodInvalidTypeIssue([]any{field}, "array", zodReceivedType(raw))}
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, []zodValidationIssue{zodInvalidTypeIssue([]any{field}, "array", zodReceivedType(raw))}
	}
	result := make([]int64, 0, len(values))
	seen := map[int64]struct{}{}
	for index, value := range values {
		path := []any{field, index}
		if zodReceivedType(value) != "number" {
			return nil, []zodValidationIssue{zodInvalidTypeIssue(path, "number", zodReceivedType(value))}
		}
		var decoded json.Number
		if err := json.Unmarshal(value, &decoded); err != nil {
			return nil, []zodValidationIssue{zodInvalidTypeIssue(path, "number", zodReceivedType(value))}
		}
		parsed, err := strconv.ParseFloat(decoded.String(), 64)
		if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) || math.Trunc(parsed) != parsed {
			return nil, []zodValidationIssue{zodInvalidIntIssue(path)}
		}
		if parsed > float64(maxSafeInteger) || parsed < float64(-maxSafeInteger) {
			return nil, []zodValidationIssue{zodInvalidIntIssue(path)}
		}
		if parsed <= 0 {
			return nil, []zodValidationIssue{zodPositiveNumberIssue(path)}
		}
		albumID := int64(parsed)
		if uniqueOnly {
			if _, exists := seen[albumID]; exists {
				continue
			}
			seen[albumID] = struct{}{}
		}
		result = append(result, albumID)
	}
	return result, nil
}

func validPhotoAlbumMode(mode string) bool {
	return mode == "replace" || mode == "add" || mode == "remove"
}

func (a *Application) replacePhotoAlbums(ctx context.Context, photoID string, albumIDs []int64, user *auth.User) bool {
	for _, id := range albumIDs {
		if !a.albumOwned(ctx, id, user) {
			return false
		}
	}
	currentByPhoto, err := a.currentManageablePhotoAlbumIDs(ctx, []string{photoID}, user)
	if err != nil {
		return false
	}
	current := currentByPhoto[photoID]
	nextSet := int64Set(albumIDs)
	tx, err := a.database.SQL().BeginTx(ctx, nil)
	if err != nil {
		return false
	}
	defer tx.Rollback()

	for _, id := range current {
		if _, err := tx.ExecContext(ctx,
			"DELETE FROM album_photos WHERE photo_id = ? AND album_id = ?",
			photoID, id); err != nil {
			return false
		}
		if _, keep := nextSet[id]; !keep {
			if _, err := tx.ExecContext(ctx,
				"UPDATE albums SET cover_photo_id = NULL, updated_at = unixepoch() WHERE id = ? AND cover_photo_id = ?",
				id, photoID); err != nil {
				return false
			}
		}
	}
	nextPositions := map[int64]float64{}
	for _, id := range albumIDs {
		next, err := nextAlbumPosition(ctx, tx, id, nextPositions)
		if err != nil {
			return false
		}
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO album_photos(album_id,photo_id,position,added_at) VALUES(?,?,?,unixepoch())",
			id, photoID, next); err != nil {
			return false
		}
	}
	return tx.Commit() == nil
}

func (a *Application) photoAlbumsBulkUpdate(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	body, ok := decodePhotoAlbumsBulkUpdateBody(w, r)
	if !ok {
		return
	}
	for _, photoID := range body.PhotoIDs {
		if !a.photoOwned(r.Context(), photoID, user) {
			httpx.Error(w, http.StatusNotFound, "Photo not found")
			return
		}
	}
	for _, albumID := range body.AlbumIDs {
		if !a.albumOwned(r.Context(), albumID, user) {
			httpx.Error(w, http.StatusNotFound, "Album not found")
			return
		}
	}
	if err := a.applyPhotoAlbumsBulkUpdate(r.Context(), body.PhotoIDs, body.AlbumIDs, body.Mode, user); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"success": true, "updatedCount": len(body.PhotoIDs), "mode": body.Mode,
	})
}

func (a *Application) currentManageablePhotoAlbumIDs(ctx context.Context, photoIDs []string, user *auth.User) (map[string][]int64, error) {
	result := make(map[string][]int64, len(photoIDs))
	if len(photoIDs) == 0 {
		return result, nil
	}
	placeholders := make([]string, len(photoIDs))
	args := make([]any, len(photoIDs))
	for index, photoID := range photoIDs {
		placeholders[index] = "?"
		args[index] = photoID
	}
	query := `
		SELECT ap.photo_id, ap.album_id
		FROM album_photos AS ap
		INNER JOIN albums AS a ON a.id = ap.album_id
		WHERE ap.photo_id IN (` + strings.Join(placeholders, ",") + `)
	`
	if user == nil || user.IsAdmin == 0 {
		query += " AND a.owner_user_id = ?"
		if user == nil {
			args = append(args, int64(-1))
		} else {
			args = append(args, user.ID)
		}
	}
	query += " ORDER BY ap.position ASC, a.id ASC"
	rows, err := a.database.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var photoID string
		var albumID int64
		if err := rows.Scan(&photoID, &albumID); err != nil {
			return nil, err
		}
		result[photoID] = append(result[photoID], albumID)
	}
	return result, rows.Err()
}

func (a *Application) applyPhotoAlbumsBulkUpdate(
	ctx context.Context,
	photoIDs []string,
	albumIDs []int64,
	mode string,
	user *auth.User,
) error {
	currentByPhoto, err := a.currentManageablePhotoAlbumIDs(ctx, photoIDs, user)
	if err != nil {
		return err
	}
	tx, err := a.database.SQL().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	clearCoverAlbumIDs := map[int64]struct{}{}
	nextPositions := map[int64]float64{}
	nextAlbumSet := int64Set(albumIDs)
	for _, photoID := range photoIDs {
		currentSet := int64Set(currentByPhoto[photoID])
		switch mode {
		case "replace":
			for _, albumID := range currentByPhoto[photoID] {
				if _, keep := nextAlbumSet[albumID]; !keep {
					clearCoverAlbumIDs[albumID] = struct{}{}
				}
				if _, err := tx.ExecContext(ctx,
					"DELETE FROM album_photos WHERE photo_id = ? AND album_id = ?",
					photoID, albumID); err != nil {
					return err
				}
			}
		case "remove":
			for _, albumID := range albumIDs {
				if _, exists := currentSet[albumID]; exists {
					clearCoverAlbumIDs[albumID] = struct{}{}
				}
				if _, err := tx.ExecContext(ctx,
					"DELETE FROM album_photos WHERE photo_id = ? AND album_id = ?",
					photoID, albumID); err != nil {
					return err
				}
			}
		}

		if mode == "replace" || mode == "add" {
			for _, albumID := range albumIDs {
				if _, err := tx.ExecContext(ctx,
					"DELETE FROM album_photos WHERE photo_id = ? AND album_id = ?",
					photoID, albumID); err != nil {
					return err
				}
				next, err := nextAlbumPosition(ctx, tx, albumID, nextPositions)
				if err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx,
					"INSERT INTO album_photos(album_id,photo_id,position,added_at) VALUES(?,?,?,unixepoch())",
					albumID, photoID, next); err != nil {
					return err
				}
			}
		}
	}
	for albumID := range clearCoverAlbumIDs {
		for _, photoID := range photoIDs {
			if _, err := tx.ExecContext(ctx,
				"UPDATE albums SET cover_photo_id = NULL, updated_at = unixepoch() WHERE id = ? AND cover_photo_id = ?",
				albumID, photoID); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func int64Set(values []int64) map[int64]struct{} {
	result := make(map[int64]struct{}, len(values))
	for _, value := range values {
		result[value] = struct{}{}
	}
	return result
}

func nextAlbumPosition(ctx context.Context, tx *sql.Tx, albumID int64, positions map[int64]float64) (float64, error) {
	if current, ok := positions[albumID]; ok {
		next := current + 10
		positions[albumID] = next
		return next, nil
	}
	var maxPosition sql.NullFloat64
	if err := tx.QueryRowContext(ctx,
		"SELECT max(position) FROM album_photos WHERE album_id = ?",
		albumID).Scan(&maxPosition); err != nil {
		return 0, err
	}
	next := 1000010.0
	if maxPosition.Valid {
		next = maxPosition.Float64 + 10
	}
	positions[albumID] = next
	return next, nil
}

func (a *Application) writePhotoAlbumResponse(w http.ResponseWriter, r *http.Request, photoID string, status int) {
	albumMap, err := a.photoAlbumSummaryMap(r.Context(), []string{photoID})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	albums := albumMap[photoID]
	ids := make([]int64, 0, len(albums))
	for _, album := range albums {
		if id, ok := album["id"].(int64); ok {
			ids = append(ids, id)
		}
	}
	httpx.JSON(w, status, map[string]any{"photoId": photoID, "albums": albums, "albumIds": ids})
}

func (a *Application) photoAlbumSummaryMap(ctx context.Context, photoIDs []string) (map[string][]map[string]any, error) {
	result := make(map[string][]map[string]any, len(photoIDs))
	if len(photoIDs) == 0 {
		return result, nil
	}
	placeholders := make([]string, len(photoIDs))
	args := make([]any, len(photoIDs))
	for index, photoID := range photoIDs {
		placeholders[index] = "?"
		args[index] = photoID
	}
	rows, err := a.database.SQL().QueryContext(ctx, `
		SELECT ap.photo_id, a.id, a.title, a.is_hidden, a.owner_user_id
		FROM album_photos AS ap
		INNER JOIN albums AS a ON a.id = ap.album_id
		WHERE ap.photo_id IN (`+strings.Join(placeholders, ",")+`)
		ORDER BY ap.position ASC, a.id ASC
	`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seen := map[string]struct{}{}
	for rows.Next() {
		var (
			photoID     string
			albumID     int64
			title       string
			hidden      int64
			ownerUserID int64
		)
		if err := rows.Scan(&photoID, &albumID, &title, &hidden, &ownerUserID); err != nil {
			return nil, err
		}
		key := photoID + ":" + strconv.FormatInt(albumID, 10)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result[photoID] = append(result[photoID], map[string]any{
			"id": albumID, "title": title, "isHidden": hidden != 0, "ownerUserId": ownerUserID,
		})
	}
	return result, rows.Err()
}

func (a *Application) photoReactionMutation(w http.ResponseWriter, r *http.Request) {
	if a.database == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	// Router parameters are identifiers, not user-entered labels. Node keeps
	// their decoded bytes intact, including whitespace, before the database
	// lookup. Trimming here changes a missing-photo 404 into an access 401.
	photoID := r.PathValue("photoID")
	if photoID == "" || !a.requirePublicPhotoAccess(w, r, photoID) {
		httpx.Error(w, http.StatusUnauthorized, "Site access required to view more photos")
		return
	}
	fingerprint := requestFingerprint(r)
	if r.Method == http.MethodDelete {
		result, err := a.database.SQL().ExecContext(r.Context(),
			"DELETE FROM photo_reactions WHERE photo_id = ? AND fingerprint = ?", photoID, fingerprint)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		affected, _ := result.RowsAffected()
		if affected == 0 {
			httpx.ErrorWithMessageData(w, http.StatusNotFound, "Server Error", "Reaction not found", nil)
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"success": true, "action": "deleted"})
		return
	}
	reactionType, ok := decodePhotoReactionBody(w, r)
	if !ok {
		return
	}
	if !validReactionType(reactionType) {
		httpx.ErrorWithMessageData(
			w,
			http.StatusBadRequest,
			"Server Error",
			"Invalid reaction type",
			nil,
		)
		return
	}
	canReact, err := a.photoReactionRateLimitAllows(r.Context(), fingerprint)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if !canReact {
		httpx.ErrorWithMessageData(
			w,
			http.StatusTooManyRequests,
			"Server Error",
			"Too many reactions. Please try again later.",
			nil,
		)
		return
	}
	photoExists, err := a.photoExistsForReaction(r.Context(), photoID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if !photoExists {
		httpx.ErrorWithMessageData(
			w,
			http.StatusNotFound,
			"Server Error",
			"Photo not found",
			nil,
		)
		return
	}
	var existingID int64
	err = a.database.SQL().QueryRowContext(r.Context(),
		"SELECT id FROM photo_reactions WHERE photo_id = ? AND fingerprint = ?",
		photoID, fingerprint).Scan(&existingID)
	action := "created"
	if err == nil {
		_, err = a.database.SQL().ExecContext(r.Context(),
			"UPDATE photo_reactions SET reaction_type = ?, updated_at = unixepoch() WHERE id = ?",
			reactionType, existingID)
		action = "updated"
	} else if errors.Is(err, sql.ErrNoRows) {
		_, err = a.database.SQL().ExecContext(r.Context(), `
			INSERT INTO photo_reactions(photo_id,reaction_type,fingerprint,ip_address,user_agent,created_at,updated_at)
			VALUES(?,?,?,?,?,unixepoch(),unixepoch())
		`, photoID, reactionType, fingerprint, requestIP(r), r.UserAgent())
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"success": true, "action": action, "reactionType": reactionType})
}

func (a *Application) photoReactionRateLimitAllows(ctx context.Context, fingerprint string) (bool, error) {
	now := time.Now()
	if a.now != nil {
		now = a.now()
	}
	windowStart := now.Add(-photoReactionRateLimitWindow).Unix()
	var count int64
	if err := a.database.SQL().QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM photo_reactions
		WHERE fingerprint = ? AND created_at > ?
	`, fingerprint, windowStart).Scan(&count); err != nil {
		return false, err
	}
	return count < photoReactionRateLimitMax, nil
}

func (a *Application) photoExistsForReaction(ctx context.Context, photoID string) (bool, error) {
	var exists int64
	err := a.database.SQL().QueryRowContext(ctx, `
		SELECT 1
		FROM photos
		WHERE id = ?
		LIMIT 1
	`, photoID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func validReactionType(value string) bool {
	switch value {
	case "like", "love", "amazing", "funny", "wow", "sad", "fire", "sparkle":
		return true
	default:
		return false
	}
}

func (a *Application) queueAddTask(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	body, ok := decodeQueueAddTaskBody(w, r)
	if !ok {
		return
	}
	if err := a.requireQueuePayloadAccess(r.Context(), user, body.Payload); err != nil {
		if accessErr, ok := isQueueAccessError(err); ok {
			httpx.Error(w, accessErr.status, accessErr.message)
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	taskID, err := a.enqueueTask(r.Context(), body.Payload, body.Priority, body.MaxAttempts, user.ID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to add task to queue")
		return
	}
	httpx.JSON(w, http.StatusOK, queueAddTaskResponse{
		Success: true, TaskID: taskID, Message: "Task added to queue successfully",
		Payload: body.Payload,
	})
}

func (a *Application) queueAddTasks(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	tasks, ok := decodeQueueAddTasksBody(w, r)
	if !ok {
		return
	}
	results := make([]queueAddTasksResult, 0, len(tasks))
	errorsList := make([]queueAddTasksError, 0)
	for index, task := range tasks {
		if err := a.requireQueuePayloadAccess(r.Context(), user, task.Payload); err != nil {
			errorsList = append(errorsList, queueAddTasksError{Index: index, Payload: task.Payload, Error: err.Error(), Success: false})
			continue
		}
		id, err := a.enqueueTask(r.Context(), task.Payload, task.Priority, task.MaxAttempts, user.ID)
		if err != nil {
			errorsList = append(errorsList, queueAddTasksError{Index: index, Payload: task.Payload, Error: err.Error(), Success: false})
			continue
		}
		results = append(results, queueAddTasksResult{Index: index, TaskID: id, Payload: task.Payload, Success: true})
	}
	httpx.JSON(w, http.StatusOK, queueAddTasksResponse{
		Success:      len(errorsList) == 0,
		TotalTasks:   len(tasks),
		SuccessCount: len(results),
		ErrorCount:   len(errorsList),
		Results:      results,
		Errors:       errorsList,
		Message:      fmt.Sprintf("Processed %d tasks: %d successful, %d failed", len(tasks), len(results), len(errorsList)),
	})
}

type queueAddTaskResponse struct {
	Success bool           `json:"success"`
	TaskID  int64          `json:"taskId"`
	Message string         `json:"message"`
	Payload map[string]any `json:"payload"`
}

type queueAddTasksResponse struct {
	Success      bool                  `json:"success"`
	TotalTasks   int                   `json:"totalTasks"`
	SuccessCount int                   `json:"successCount"`
	ErrorCount   int                   `json:"errorCount"`
	Results      []queueAddTasksResult `json:"results"`
	Errors       []queueAddTasksError  `json:"errors,omitempty"`
	Message      string                `json:"message"`
}

type queueAddTasksResult struct {
	Index   int            `json:"index"`
	TaskID  int64          `json:"taskId"`
	Payload map[string]any `json:"payload"`
	Success bool           `json:"success"`
}

type queueAddTasksError struct {
	Index   int            `json:"index"`
	Payload map[string]any `json:"payload"`
	Error   string         `json:"error"`
	Success bool           `json:"success"`
}

type queueRetryTask struct {
	ID      int64
	Status  string
	Payload map[string]any
}

func queueRetryPayloadSummary(payload map[string]any) map[string]any {
	result := make(map[string]any, 2)
	if value, ok := payload["type"]; ok {
		result["type"] = value
	}
	if value, ok := payload["storageKey"]; ok {
		result["storageKey"] = value
	}
	return result
}

func queueRetryTaskSummary(task queueRetryTask) map[string]any {
	result := queueRetryPayloadSummary(task.Payload)
	result["id"] = task.ID
	return result
}

func queueRetrySkippedTaskSummary(task queueRetryTask) map[string]any {
	return map[string]any{
		"id":     task.ID,
		"status": task.Status,
		"reason": "Task is not in failed status (current: " + task.Status + ")",
	}
}

func decodeQueueRetryPayload(raw string) (map[string]any, error) {
	payload := map[string]any{}
	if strings.TrimSpace(raw) == "" {
		return payload, nil
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, err
	}
	if payload == nil {
		payload = map[string]any{}
	}
	return payload, nil
}

func (a *Application) queueRetryTasks(ctx context.Context, retryAll bool, ids []int64) ([]queueRetryTask, error) {
	query := "SELECT id, status, payload FROM pipeline_queue"
	args := make([]any, 0, len(ids))
	if retryAll {
		query += " WHERE status = 'failed'"
	} else {
		if len(ids) == 0 {
			return nil, nil
		}
		placeholders := make([]string, len(ids))
		for index, id := range ids {
			placeholders[index] = "?"
			args = append(args, id)
		}
		query += " WHERE id IN (" + strings.Join(placeholders, ",") + ")"
	}
	query += " ORDER BY id ASC"

	rows, err := a.database.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tasks := make([]queueRetryTask, 0)
	for rows.Next() {
		var task queueRetryTask
		var rawPayload string
		if err := rows.Scan(&task.ID, &task.Status, &rawPayload); err != nil {
			return nil, err
		}
		task.Payload, err = decodeQueueRetryPayload(rawPayload)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return tasks, nil
}

func (a *Application) resetQueueTasksForRetry(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for index, id := range ids {
		placeholders[index] = "?"
		args[index] = id
	}
	_, err := a.database.SQL().ExecContext(ctx,
		`UPDATE pipeline_queue
		 SET status='pending',
		     status_stage=NULL,
		     error_message=NULL,
		     attempts=0,
		     available_at=unixepoch(),
		     claimed_by=NULL,
		     claim_token=NULL,
		     claim_expires_at=NULL
		 WHERE id IN (`+strings.Join(placeholders, ",")+`)`,
		args...,
	)
	return err
}

type contextSQLExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func (a *Application) enqueueTask(ctx context.Context, payload map[string]any, priority, maxAttempts float64, ownerID int64) (int64, error) {
	return enqueueTaskWithExecutor(ctx, a.database.SQL(), payload, priority, maxAttempts, ownerID)
}

func enqueueTaskWithExecutor(ctx context.Context, executor contextSQLExecer, payload map[string]any, priority, maxAttempts float64, ownerID int64) (int64, error) {
	if len(payload) == 0 || math.IsInf(priority, 0) || math.IsNaN(priority) || priority < 0 || priority > 9 ||
		math.IsInf(maxAttempts, 0) || math.IsNaN(maxAttempts) || maxAttempts < 1 || maxAttempts > 5 {
		return 0, errors.New("invalid queue task")
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	result, err := executor.ExecContext(ctx, `
		INSERT INTO pipeline_queue(payload,priority,attempts,max_attempts,status,created_at,owner_user_id)
		VALUES(?,?,0,?,'pending',unixepoch(),?)
	`, string(encoded), priority, maxAttempts, ownerID)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

type queueRetryBody struct {
	TaskID int64
}

func decodeQueueRetryBody(w http.ResponseWriter, r *http.Request) (queueRetryBody, bool) {
	object, ok := decodeRequiredJSONObjectBody(w, r)
	if !ok {
		return queueRetryBody{}, false
	}
	raw, exists := object["taskId"]
	if !exists || zodReceivedType(raw) != "number" {
		writeSettingZodValidationError(
			w,
			zodInvalidTypeIssue([]any{"taskId"}, "number", zodReceivedType(raw)),
		)
		return queueRetryBody{}, false
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err != nil {
		writeSettingZodValidationError(
			w,
			zodInvalidTypeIssue([]any{"taskId"}, "number", zodReceivedType(raw)),
		)
		return queueRetryBody{}, false
	}
	parsed, err := strconv.ParseFloat(number.String(), 64)
	if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) ||
		math.Trunc(parsed) != parsed || parsed > float64(maxSafeInteger) || parsed < float64(-maxSafeInteger) {
		writeSettingZodValidationError(w, zodInvalidIntIssue([]any{"taskId"}))
		return queueRetryBody{}, false
	}
	if parsed <= 0 {
		writeSettingZodValidationError(w, zodPositiveNumberIssue([]any{"taskId"}))
		return queueRetryBody{}, false
	}
	return queueRetryBody{TaskID: int64(parsed)}, true
}

type queueRetryBatchBody struct {
	TaskIDs  []int64
	RetryAll bool
}

func decodeQueueRetryBatchBody(w http.ResponseWriter, r *http.Request) (queueRetryBatchBody, bool) {
	object, ok := decodeRequiredJSONObjectBody(w, r)
	if !ok {
		return queueRetryBatchBody{}, false
	}
	var issues []zodValidationIssue
	var taskIDs []int64
	if raw, exists := object["taskIds"]; exists {
		var fieldIssues []zodValidationIssue
		taskIDs, fieldIssues = decodePositiveInt64ArrayPreserve(raw, "taskIds")
		issues = append(issues, fieldIssues...)
	}
	retryAll := false
	if value, exists, valid := decodeJSONBoolField(object, "retryAll"); exists {
		if !valid {
			issues = append(issues, zodInvalidTypeIssue([]any{"retryAll"}, "boolean", zodReceivedType(object["retryAll"])))
		} else {
			retryAll = value
		}
	}
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return queueRetryBatchBody{}, false
	}
	return queueRetryBatchBody{TaskIDs: taskIDs, RetryAll: retryAll}, true
}

func (a *Application) queueRetry(w http.ResponseWriter, r *http.Request) {
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	body, ok := decodeQueueRetryBody(w, r)
	if !ok {
		return
	}
	id := body.TaskID
	tasks, err := a.queueRetryTasks(r.Context(), false, []int64{id})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to retry task")
		return
	}
	if len(tasks) == 0 {
		httpx.Error(w, http.StatusNotFound, "Task not found")
		return
	}
	task := tasks[0]
	if task.Status != "failed" {
		httpx.Error(w, http.StatusBadRequest, "Task is not in failed status, current status: "+task.Status)
		return
	}
	if err := a.resetQueueTasksForRetry(r.Context(), []int64{id}); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to retry task")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"success": true, "message": fmt.Sprintf("Task %d has been reset and will be retried", id),
		"taskId": id, "payload": queueRetryPayloadSummary(task.Payload),
	})
}

func (a *Application) queueRetryBatch(w http.ResponseWriter, r *http.Request) {
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	body, ok := decodeQueueRetryBatchBody(w, r)
	if !ok {
		return
	}
	if !body.RetryAll && len(body.TaskIDs) == 0 {
		httpx.Error(w, http.StatusBadRequest, "Either taskIds array or retryAll flag must be provided")
		return
	}
	tasks, err := a.queueRetryTasks(r.Context(), body.RetryAll, body.TaskIDs)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to batch retry tasks")
		return
	}
	failedTasks := make([]queueRetryTask, 0)
	nonFailedTasks := make([]queueRetryTask, 0)
	for _, task := range tasks {
		if task.Status == "failed" {
			failedTasks = append(failedTasks, task)
		} else {
			nonFailedTasks = append(nonFailedTasks, task)
		}
	}
	if len(failedTasks) == 0 {
		skippedCount := 0
		if !body.RetryAll {
			skippedCount = len(body.TaskIDs)
		}
		httpx.JSON(w, http.StatusOK, map[string]any{
			"success": true, "message": "No failed tasks found to retry",
			"retriedCount": 0, "skippedCount": skippedCount,
		})
		return
	}
	failedIDs := make([]int64, 0, len(failedTasks))
	retriedTasks := make([]map[string]any, 0, len(failedTasks))
	for _, task := range failedTasks {
		failedIDs = append(failedIDs, task.ID)
		retriedTasks = append(retriedTasks, queueRetryTaskSummary(task))
	}
	if err := a.resetQueueTasksForRetry(r.Context(), failedIDs); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to batch retry tasks")
		return
	}
	skippedTasks := make([]map[string]any, 0, len(nonFailedTasks))
	for _, task := range nonFailedTasks {
		skippedTasks = append(skippedTasks, queueRetrySkippedTaskSummary(task))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"success": true, "message": fmt.Sprintf("Successfully reset %d failed tasks for retry", len(failedTasks)),
		"retriedCount": len(failedTasks), "skippedCount": len(nonFailedTasks),
		"retriedTasks": retriedTasks, "skippedTasks": skippedTasks,
	})
}

type queueClearOptions struct {
	IncludeCompleted bool
	IncludeFailed    bool
	OlderThanDays    *int64
	ThresholdUnix    int64
	ThresholdDate    string
}

func queueClearIncludeFlag(query map[string][]string, key string) bool {
	values, ok := query[key]
	if !ok {
		return true
	}
	if len(values) == 0 {
		return false
	}
	return values[0] == "true"
}

func parseQueueClearOptions(query map[string][]string, now time.Time) (queueClearOptions, error) {
	for _, key := range []string{"includeCompleted", "includeFailed", "olderThanDays"} {
		if len(query[key]) > 1 {
			return queueClearOptions{}, errQueueClearQueryShape
		}
	}
	options := queueClearOptions{
		IncludeCompleted: queueClearIncludeFlag(query, "includeCompleted"),
		IncludeFailed:    queueClearIncludeFlag(query, "includeFailed"),
	}
	if !options.IncludeCompleted && !options.IncludeFailed {
		return options, errors.New("At least one of includeCompleted or includeFailed must be true")
	}
	if values := query["olderThanDays"]; len(values) > 0 && values[0] != "" {
		days, ok := parseJavaScriptParseInt64(values[0])
		if !ok || days < 0 {
			return options, errors.New("olderThanDays must be a non-negative integer")
		}
		thresholdUnix, thresholdDate := queueClearThreshold(now, days)
		options.OlderThanDays = &days
		options.ThresholdUnix = thresholdUnix
		options.ThresholdDate = thresholdDate
	}
	return options, nil
}

// parseJavaScriptParseInt64 mirrors JavaScript parseInt(value) for the
// non-negative day ranges that can be represented by SQLite timestamps. It
// trims ECMAScript whitespace, honors an optional sign and 0x prefix, and
// stops at the first invalid digit instead of requiring the whole string to
// be an integer.
func parseJavaScriptParseInt64(value string) (int64, bool) {
	trimmed := jsTrimSpace(value)
	if trimmed == "" {
		return 0, false
	}

	sign := int64(1)
	if trimmed[0] == '+' || trimmed[0] == '-' {
		if trimmed[0] == '-' {
			sign = -1
		}
		trimmed = trimmed[1:]
	}
	base := int64(10)
	if len(trimmed) >= 2 && trimmed[0] == '0' && (trimmed[1] == 'x' || trimmed[1] == 'X') {
		base = 16
		trimmed = trimmed[2:]
	}

	var parsed int64
	digits := 0
	for _, character := range trimmed {
		var digit int64
		switch {
		case character >= '0' && character <= '9':
			digit = int64(character - '0')
		case base == 16 && character >= 'a' && character <= 'f':
			digit = int64(character-'a') + 10
		case base == 16 && character >= 'A' && character <= 'F':
			digit = int64(character-'A') + 10
		default:
			return sign * parsed, digits > 0
		}
		if digit >= base || parsed > (math.MaxInt64-digit)/base {
			return 0, false
		}
		parsed = parsed*base + digit
		digits++
	}
	return sign * parsed, digits > 0
}

// parseJavaScriptParseInt10Int64 mirrors parseInt(value, 10). Storage config
// routes use an explicit decimal radix, so a numeric prefix is accepted while
// hexadecimal notation stops after the leading zero.
func parseJavaScriptParseInt10Int64(value string) (int64, bool) {
	trimmed := jsTrimSpace(value)
	if trimmed == "" {
		return 0, false
	}

	negative := false
	if trimmed[0] == '+' || trimmed[0] == '-' {
		negative = trimmed[0] == '-'
		trimmed = trimmed[1:]
	}
	limit := uint64(math.MaxInt64)
	if negative {
		limit++
	}
	var parsed uint64
	digits := 0
	for _, character := range trimmed {
		if character < '0' || character > '9' {
			break
		}
		digit := uint64(character - '0')
		if parsed > (limit-digit)/10 {
			return 0, false
		}
		parsed = parsed*10 + digit
		digits++
	}
	if digits == 0 {
		return 0, false
	}
	if negative {
		if parsed == uint64(math.MaxInt64)+1 {
			return math.MinInt64, true
		}
		return -int64(parsed), true
	}
	return int64(parsed), true
}

func queueClearThreshold(now time.Time, days int64) (int64, string) {
	thresholdUnix := queueClearThresholdUnix(now.Unix(), days)
	millisecondNanos := int64(now.Nanosecond()/1_000_000) * int64(time.Millisecond)
	thresholdDate := time.Unix(thresholdUnix, millisecondNanos).UTC().Format("2006-01-02T15:04:05.000Z")
	return thresholdUnix, thresholdDate
}

func queueClearThresholdUnix(nowUnix int64, days int64) int64 {
	const secondsPerDay int64 = 24 * 60 * 60
	if days > math.MaxInt64/secondsPerDay {
		return math.MinInt64
	}
	delta := days * secondsPerDay
	if nowUnix < math.MinInt64+delta {
		return math.MinInt64
	}
	return nowUnix - delta
}

func queueClearWhere(options queueClearOptions) (string, []any) {
	statuses := make([]string, 0, 2)
	if options.IncludeCompleted {
		statuses = append(statuses, "completed")
	}
	if options.IncludeFailed {
		statuses = append(statuses, "failed")
	}
	args := make([]any, len(statuses))
	placeholders := make([]string, len(statuses))
	for i, status := range statuses {
		args[i], placeholders[i] = status, "?"
	}
	where := "status IN (" + strings.Join(placeholders, ",") + ")"
	if options.OlderThanDays != nil {
		where += " AND created_at < ?"
		args = append(args, options.ThresholdUnix)
	}
	return where, args
}

func (a *Application) clearQueueTasks(ctx context.Context, options queueClearOptions) (map[string]any, error) {
	where, args := queueClearWhere(options)
	rows, err := a.database.SQL().QueryContext(ctx, "SELECT status FROM pipeline_queue WHERE "+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var completed int64
	var failed int64
	for rows.Next() {
		var status string
		if err := rows.Scan(&status); err != nil {
			return nil, err
		}
		switch status {
		case "completed":
			completed++
		case "failed":
			failed++
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	breakdown := map[string]any{
		"completed": completed,
		"failed":    failed,
	}
	deletedCount := completed + failed
	if deletedCount == 0 {
		return map[string]any{
			"success":      true,
			"message":      "No tasks found to clear",
			"deletedCount": int64(0),
			"breakdown":    breakdown,
		}, nil
	}

	if _, err := a.database.SQL().ExecContext(ctx, "DELETE FROM pipeline_queue WHERE "+where, args...); err != nil {
		return nil, err
	}

	response := map[string]any{
		"success":      true,
		"message":      fmt.Sprintf("Successfully cleared %d non-active tasks", deletedCount),
		"deletedCount": deletedCount,
		"breakdown":    breakdown,
	}
	if options.OlderThanDays != nil {
		response["filter"] = map[string]any{
			"olderThanDays": *options.OlderThanDays,
			"thresholdDate": options.ThresholdDate,
		}
	}
	return response, nil
}

func (a *Application) queueClear(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.database == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	options, err := parseQueueClearOptions(r.URL.Query(), a.now())
	if err != nil {
		if errors.Is(err, errQueueClearQueryShape) {
			httpx.Error(w, http.StatusInternalServerError, "Failed to clear tasks")
			return
		}
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	response, err := a.clearQueueTasks(r.Context(), options)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "queue clear failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Failed to clear tasks")
		return
	}
	httpx.JSON(w, http.StatusOK, response)
}

func (a *Application) settingUpdate(w http.ResponseWriter, r *http.Request) {
	admin, err := a.auth.RequireAdmin(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	namespace, key := r.PathValue("namespace"), r.PathValue("key")
	if !isKnownSettingNamespace(namespace) || !isKnownSettingKey(key) {
		issues := make([]zodEnumIssue, 0, 2)
		if !isKnownSettingNamespace(namespace) {
			issues = append(issues, invalidSettingNamespaceIssue())
		}
		if !isKnownSettingKey(key) {
			issues = append(issues, invalidSettingKeyIssue())
		}
		writeSettingParamValidationError(w, issues...)
		return
	}
	body, ok := decodeRequiredJSONObjectBody(w, r)
	if !ok {
		return
	}
	rawValue, ok := body["value"]
	if !ok {
		writeSettingZodValidationError(
			w,
			zodInvalidTypeIssue([]any{"value"}, "nonoptional", "undefined"),
		)
		return
	}
	input, err := decodeRawJSONValue(rawValue)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "Validation Error")
		return
	}
	value, err := a.setSetting(r.Context(), namespace, key, input, &admin.ID)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"namespace": namespace, "key": key, "value": value})
}

func (a *Application) settingsBatchUpdate(w http.ResponseWriter, r *http.Request) {
	admin, err := a.auth.RequireAdmin(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	body, ok := decodeRequiredJSONObjectBody(w, r)
	if !ok {
		return
	}
	rawUpdates, ok := body["updates"]
	if !ok {
		writeSettingZodValidationError(
			w,
			zodInvalidTypeIssue([]any{"updates"}, "array", "undefined"),
		)
		return
	}
	if jsonRawValueTypeName(rawUpdates) != "array" {
		writeSettingZodValidationError(
			w,
			zodInvalidTypeIssue([]any{"updates"}, "array", jsonRawValueTypeName(rawUpdates)),
		)
		return
	}
	var rawEntries []json.RawMessage
	if err := json.Unmarshal(rawUpdates, &rawEntries); err != nil {
		httpx.Error(w, http.StatusBadRequest, "Validation Error")
		return
	}
	type settingBatchUpdateEntry struct {
		Namespace string
		Key       string
		Value     any
	}
	updates := make([]settingBatchUpdateEntry, 0, len(rawEntries))
	issues := make([]zodValidationIssue, 0)
	for index, rawEntry := range rawEntries {
		entryType := jsonRawValueTypeName(rawEntry)
		if entryType != "object" {
			issues = append(issues, zodInvalidTypeIssue([]any{"updates", index}, "object", entryType))
			continue
		}
		var rawObject map[string]json.RawMessage
		if err := json.Unmarshal(rawEntry, &rawObject); err != nil {
			httpx.Error(w, http.StatusBadRequest, "Validation Error")
			return
		}
		namespace, namespaceOK := decodeRawJSONString(rawObject["namespace"])
		key, keyOK := decodeRawJSONString(rawObject["key"])
		rawValue, valueOK := rawObject["value"]
		entryValid := true
		if !namespaceOK || !isKnownSettingNamespace(namespace) {
			issues = append(
				issues,
				zodEnumValidationIssue(invalidSettingNamespaceIssueAt("updates", index, "namespace")),
			)
			entryValid = false
		}
		if !keyOK || !isKnownSettingKey(key) {
			issues = append(
				issues,
				zodEnumValidationIssue(invalidSettingKeyIssueAt("updates", index, "key")),
			)
			entryValid = false
		}
		if !valueOK {
			issues = append(
				issues,
				zodInvalidTypeIssue([]any{"updates", index, "value"}, "nonoptional", "undefined"),
			)
			entryValid = false
		}
		if !entryValid {
			continue
		}
		value, err := decodeRawJSONValue(rawValue)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "Validation Error")
			return
		}
		updates = append(updates, settingBatchUpdateEntry{
			Namespace: namespace,
			Key:       key,
			Value:     value,
		})
	}
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return
	}
	updated := 0
	errs := make([]map[string]any, 0)
	for _, update := range updates {
		if _, err := a.setSetting(r.Context(), update.Namespace, update.Key, update.Value, &admin.ID); err != nil {
			errs = append(errs, map[string]any{"namespace": update.Namespace, "key": update.Key, "error": err.Error()})
			continue
		}
		updated++
	}
	if len(errs) > 0 {
		httpx.JSON(w, http.StatusOK, map[string]any{"success": false, "updated": updated, "errors": errs})
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"success": true, "updated": updated})
}

func decodeRawJSONValue(raw json.RawMessage) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}

func decodeRawJSONString(raw json.RawMessage) (string, bool) {
	if jsonRawValueTypeName(raw) != "string" {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func jsonRawValueTypeName(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return "undefined"
	}
	switch trimmed[0] {
	case '{':
		return "object"
	case '[':
		return "array"
	case '"':
		return "string"
	case 't', 'f':
		return "boolean"
	case 'n':
		return "null"
	default:
		if trimmed[0] == '-' || (trimmed[0] >= '0' && trimmed[0] <= '9') {
			return "number"
		}
		return "unknown"
	}
}

func (a *Application) storageConfigCreate(w http.ResponseWriter, r *http.Request) {
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	body, ok := decodeStorageConfigMutationBody(w, r, true)
	if !ok {
		return
	}
	normalizedConfig, ok := normalizeStorageConfigForCreate(body.Provider, body.Config)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "Validation Error")
		return
	}
	encoded, _ := json.Marshal(normalizedConfig)
	result, err := a.database.SQL().ExecContext(r.Context(), `
		INSERT INTO settings_storage_providers(name,provider,config,created_at,updated_at)
		VALUES(?,?,?,unixepoch(),unixepoch())
	`, body.Name, body.Provider, string(encoded))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "Storage configuration could not be created")
		return
	}
	id, _ := result.LastInsertId()
	if current, getErr := a.settings.Value(r.Context(), "storage", "provider"); getErr == nil && settings.DecodeValue(current.Type, current.Value) == nil {
		var count int64
		if countErr := a.database.SQL().QueryRowContext(r.Context(), "SELECT COUNT(*) FROM settings_storage_providers").Scan(&count); countErr != nil {
			httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		if count == 1 {
			if _, setErr := a.setSetting(r.Context(), "storage", "provider", float64(id), nil); setErr != nil {
				httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
				return
			}
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": id})
}

type storageConfigMutationBody struct {
	Name        string
	NamePresent bool
	Provider    string
	Config      map[string]any
}

func decodeStorageConfigMutationBody(w http.ResponseWriter, r *http.Request, create bool) (storageConfigMutationBody, bool) {
	object, ok := decodeRequiredJSONObjectBodyCodeFirst(w, r)
	if !ok {
		return storageConfigMutationBody{}, false
	}
	providerRaw, providerExists := object["provider"]
	provider, providerIsString := decodeRawJSONString(providerRaw)
	if !providerExists || !providerIsString || !validStorageProvider(provider) {
		writeSettingZodValidationError(w, zodInvalidDiscriminatorIssue(
			[]any{"provider"}, "provider", "s3", "local", "openlist",
		))
		return storageConfigMutationBody{}, false
	}

	issues := make([]zodValidationIssue, 0)
	nameRaw, nameExists := object["name"]
	name, nameIsString := decodeRawJSONString(nameRaw)
	if create && !nameExists {
		issues = append(issues, zodInvalidTypeIssue([]any{"name"}, "string", "undefined"))
	} else if nameExists && !nameIsString {
		issues = append(issues, zodInvalidTypeIssue([]any{"name"}, "string", zodReceivedType(object["name"])))
	}

	configRaw, configExists := object["config"]
	config := map[string]any(nil)
	if !configExists || zodReceivedType(configRaw) != "object" {
		issues = append(issues, zodInvalidTypeIssue(
			[]any{"config"}, "object", zodReceivedType(configRaw),
		))
	} else {
		var rawConfig map[string]json.RawMessage
		if err := json.Unmarshal(configRaw, &rawConfig); err != nil {
			writeInvalidJSONBody(w)
			return storageConfigMutationBody{}, false
		}
		issues = append(issues, storageConfigValidationIssues(provider, rawConfig, create)...)
		decoded, err := decodeRawJSONValue(configRaw)
		if err != nil {
			writeInvalidJSONBody(w)
			return storageConfigMutationBody{}, false
		}
		config, _ = decoded.(map[string]any)
	}
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return storageConfigMutationBody{}, false
	}
	return storageConfigMutationBody{
		Name: name, NamePresent: nameExists, Provider: provider, Config: config,
	}, true
}

func storageConfigValidationIssues(provider string, object map[string]json.RawMessage, create bool) []zodValidationIssue {
	issues := make([]zodValidationIssue, 0)
	validateStorageLiteral := func() {
		raw, exists := object["provider"]
		value, valid := decodeRawJSONString(raw)
		if (create && !exists) || (exists && (!valid || value != provider)) {
			issues = append(issues, zodEnumValidationIssue(zodEnumIssue{
				path: []any{"config", "provider"}, values: []string{provider},
			}))
		}
	}
	validateString := func(key string, required bool, nonEmpty bool) {
		raw, exists := object[key]
		if !exists {
			if required {
				issues = append(issues, zodInvalidTypeIssue([]any{"config", key}, "string", "undefined"))
			}
			return
		}
		value, valid := decodeRawJSONString(raw)
		if !valid {
			issues = append(issues, zodInvalidTypeIssue([]any{"config", key}, "string", zodReceivedType(raw)))
			return
		}
		if nonEmpty && value == "" {
			issues = append(issues, zodTooSmallStringIssue([]any{"config", key}, 1))
		}
	}
	validateBool := func(key string) {
		raw, exists := object[key]
		if !exists {
			return
		}
		if _, _, valid := decodeJSONBoolField(object, key); !valid {
			issues = append(issues, zodInvalidTypeIssue([]any{"config", key}, "boolean", zodReceivedType(raw)))
		}
	}
	validateNumber := func(key string) {
		raw, exists := object[key]
		if !exists {
			return
		}
		if zodReceivedType(raw) != "number" {
			issues = append(issues, zodInvalidTypeIssue([]any{"config", key}, "number", zodReceivedType(raw)))
		}
	}

	validateStorageLiteral()
	switch provider {
	case "local":
		validateString("basePath", create, true)
		validateString("baseUrl", false, false)
		validateString("prefix", false, false)
	case "s3":
		validateString("bucket", create, false)
		validateString("region", false, false)
		validateString("endpoint", create, false)
		validateString("prefix", false, false)
		validateString("cdnUrl", false, false)
		validateString("accessKeyId", create, false)
		validateString("secretAccessKey", create, false)
		validateBool("forcePathStyle")
		validateNumber("maxKeys")
	case "openlist":
		validateString("baseUrl", create, true)
		validateString("rootPath", create, true)
		validateString("token", create, true)
		validateString("uploadEndpoint", false, false)
		validateString("downloadEndpoint", false, false)
		validateString("listEndpoint", false, false)
		validateString("deleteEndpoint", false, false)
		validateString("metaEndpoint", false, false)
		validateString("pathField", false, false)
		validateString("cdnUrl", false, false)
	}
	return issues
}

func validStorageProvider(value string) bool {
	return value == "local" || value == "s3" || value == "openlist"
}

func decodeStorageConfigName(raw json.RawMessage) (string, bool, bool) {
	if len(raw) == 0 {
		return "", false, true
	}
	if strings.TrimSpace(string(raw)) == "null" {
		return "", true, false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", true, false
	}
	return value, true, true
}

func normalizeStorageConfigForCreate(provider string, config map[string]any) (map[string]any, bool) {
	if !storageConfigProviderLiteral(config, provider, true, nil) {
		return nil, false
	}
	switch provider {
	case "local":
		return normalizeLocalStorageConfigForCreate(config)
	case "s3":
		return normalizeS3StorageConfigForCreate(config)
	case "openlist":
		return normalizeOpenListStorageConfigForCreate(config)
	default:
		return nil, false
	}
}

func normalizeStorageConfigForUpdate(provider string, config map[string]any) (map[string]any, bool) {
	switch provider {
	case "local":
		return normalizeLocalStorageConfigForUpdate(config)
	case "s3":
		return normalizeS3StorageConfigForUpdate(config)
	case "openlist":
		return normalizeOpenListStorageConfigForUpdate(config)
	default:
		return nil, false
	}
}

func normalizeLocalStorageConfigForCreate(config map[string]any) (map[string]any, bool) {
	out := map[string]any{"provider": "local"}
	if !copyStorageConfigString(out, config, "basePath", true) ||
		!copyStorageConfigOptionalString(out, config, "baseUrl", false) ||
		!copyStorageConfigOptionalString(out, config, "prefix", false) {
		return nil, false
	}
	return out, true
}

func normalizeLocalStorageConfigForUpdate(config map[string]any) (map[string]any, bool) {
	out := make(map[string]any)
	if !storageConfigProviderLiteral(config, "local", false, out) ||
		!copyStorageConfigOptionalString(out, config, "basePath", true) ||
		!copyStorageConfigOptionalString(out, config, "baseUrl", false) ||
		!copyStorageConfigOptionalString(out, config, "prefix", false) {
		return nil, false
	}
	return out, true
}

func normalizeS3StorageConfigForCreate(config map[string]any) (map[string]any, bool) {
	out := map[string]any{"provider": "s3"}
	if !copyStorageConfigString(out, config, "bucket", false) ||
		!copyStorageConfigStringWithDefault(out, config, "region", "auto") ||
		!copyStorageConfigString(out, config, "endpoint", false) ||
		!copyStorageConfigStringWithDefault(out, config, "prefix", "/photos") ||
		!copyStorageConfigOptionalString(out, config, "cdnUrl", false) ||
		!copyStorageConfigString(out, config, "accessKeyId", false) ||
		!copyStorageConfigString(out, config, "secretAccessKey", false) ||
		!copyStorageConfigOptionalBool(out, config, "forcePathStyle") ||
		!copyStorageConfigOptionalNumber(out, config, "maxKeys") {
		return nil, false
	}
	return out, true
}

func normalizeS3StorageConfigForUpdate(config map[string]any) (map[string]any, bool) {
	out := make(map[string]any)
	if !storageConfigProviderLiteral(config, "s3", false, out) ||
		!copyStorageConfigOptionalString(out, config, "bucket", false) ||
		!copyStorageConfigStringWithDefault(out, config, "region", "auto") ||
		!copyStorageConfigOptionalString(out, config, "endpoint", false) ||
		!copyStorageConfigStringWithDefault(out, config, "prefix", "/photos") ||
		!copyStorageConfigOptionalString(out, config, "cdnUrl", false) ||
		!copyStorageConfigOptionalString(out, config, "accessKeyId", false) ||
		!copyStorageConfigOptionalString(out, config, "secretAccessKey", false) ||
		!copyStorageConfigOptionalBool(out, config, "forcePathStyle") ||
		!copyStorageConfigOptionalNumber(out, config, "maxKeys") {
		return nil, false
	}
	return out, true
}

func normalizeOpenListStorageConfigForCreate(config map[string]any) (map[string]any, bool) {
	out := map[string]any{"provider": "openlist"}
	if !copyStorageConfigString(out, config, "baseUrl", true) ||
		!copyStorageConfigString(out, config, "rootPath", true) ||
		!copyStorageConfigString(out, config, "token", true) ||
		!copyStorageConfigStringWithDefault(out, config, "uploadEndpoint", "/api/fs/put") ||
		!copyStorageConfigOptionalString(out, config, "downloadEndpoint", false) ||
		!copyStorageConfigOptionalString(out, config, "listEndpoint", false) ||
		!copyStorageConfigStringWithDefault(out, config, "deleteEndpoint", "/api/fs/remove") ||
		!copyStorageConfigStringWithDefault(out, config, "metaEndpoint", "/api/fs/get") ||
		!copyStorageConfigStringWithDefault(out, config, "pathField", "path") ||
		!copyStorageConfigOptionalString(out, config, "cdnUrl", false) {
		return nil, false
	}
	return out, true
}

func normalizeOpenListStorageConfigForUpdate(config map[string]any) (map[string]any, bool) {
	out := make(map[string]any)
	if !storageConfigProviderLiteral(config, "openlist", false, out) ||
		!copyStorageConfigOptionalString(out, config, "baseUrl", true) ||
		!copyStorageConfigOptionalString(out, config, "rootPath", true) ||
		!copyStorageConfigOptionalString(out, config, "token", true) ||
		!copyStorageConfigStringWithDefault(out, config, "uploadEndpoint", "/api/fs/put") ||
		!copyStorageConfigOptionalString(out, config, "downloadEndpoint", false) ||
		!copyStorageConfigOptionalString(out, config, "listEndpoint", false) ||
		!copyStorageConfigStringWithDefault(out, config, "deleteEndpoint", "/api/fs/remove") ||
		!copyStorageConfigStringWithDefault(out, config, "metaEndpoint", "/api/fs/get") ||
		!copyStorageConfigStringWithDefault(out, config, "pathField", "path") ||
		!copyStorageConfigOptionalString(out, config, "cdnUrl", false) {
		return nil, false
	}
	return out, true
}

func storageConfigProviderLiteral(config map[string]any, expected string, required bool, out map[string]any) bool {
	raw, exists := config["provider"]
	if !exists {
		return !required
	}
	value, ok := raw.(string)
	if !ok || value != expected {
		return false
	}
	if out != nil {
		out["provider"] = value
	}
	return true
}

func copyStorageConfigString(out map[string]any, config map[string]any, key string, requireNonEmpty bool) bool {
	raw, exists := config[key]
	if !exists {
		return false
	}
	value, ok := raw.(string)
	if !ok || (requireNonEmpty && value == "") {
		return false
	}
	out[key] = value
	return true
}

func copyStorageConfigOptionalString(out map[string]any, config map[string]any, key string, requireNonEmpty bool) bool {
	raw, exists := config[key]
	if !exists {
		return true
	}
	value, ok := raw.(string)
	if !ok || (requireNonEmpty && value == "") {
		return false
	}
	out[key] = value
	return true
}

func copyStorageConfigStringWithDefault(out map[string]any, config map[string]any, key string, fallback string) bool {
	raw, exists := config[key]
	if !exists {
		out[key] = fallback
		return true
	}
	value, ok := raw.(string)
	if !ok {
		return false
	}
	out[key] = value
	return true
}

func copyStorageConfigOptionalBool(out map[string]any, config map[string]any, key string) bool {
	raw, exists := config[key]
	if !exists {
		return true
	}
	value, ok := raw.(bool)
	if !ok {
		return false
	}
	out[key] = value
	return true
}

func copyStorageConfigOptionalNumber(out map[string]any, config map[string]any, key string) bool {
	raw, exists := config[key]
	if !exists {
		return true
	}
	switch value := raw.(type) {
	case json.Number:
		parsed, err := value.Float64()
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return false
		}
		out[key] = value
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
		out[key] = value
	case float32:
		parsed := float64(value)
		if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return false
		}
		out[key] = value
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		out[key] = value
	default:
		return false
	}
	return true
}

func (a *Application) storageConfigUpdate(w http.ResponseWriter, r *http.Request) {
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	id, ok := parseJavaScriptParseInt10Int64(r.PathValue("id"))
	if !ok {
		httpx.Error(w, http.StatusNotFound, "Storage configuration not found")
		return
	}
	// The Node handler resolves the provider row before decoding the PUT body.
	// That ordering is observable: an invalid body for a missing id is a 404,
	// not a validation 400. Keep the independent implementation wire-compatible.
	var exists int
	if err := a.database.SQL().QueryRowContext(r.Context(), `
		SELECT 1 FROM settings_storage_providers WHERE id = ?
	`, id).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "Storage configuration not found")
		} else {
			httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		}
		return
	}
	body, ok := decodeStorageConfigMutationBody(w, r, false)
	if !ok {
		return
	}
	normalizedConfig, ok := normalizeStorageConfigForUpdate(body.Provider, body.Config)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "Validation Error")
		return
	}
	encoded, _ := json.Marshal(normalizedConfig)
	sets, args := []string{"provider = ?", "config = ?"}, []any{body.Provider, string(encoded)}
	if body.NamePresent {
		sets, args = append(sets, "name = ?"), append(args, body.Name)
	}
	sets = append(sets, "updated_at = unixepoch()")
	args = append(args, id)
	if _, err := a.database.SQL().ExecContext(r.Context(), "UPDATE settings_storage_providers SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...); err != nil {
		httpx.Error(w, http.StatusBadRequest, "Storage configuration could not be updated")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *Application) storageConfigDelete(w http.ResponseWriter, r *http.Request) {
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	id, ok := parseJavaScriptParseInt10Int64(r.PathValue("id"))
	if !ok {
		httpx.Error(w, http.StatusNotFound, "Storage configuration not found")
		return
	}
	result, err := a.database.SQL().ExecContext(r.Context(), "DELETE FROM settings_storage_providers WHERE id = ?", id)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "Storage configuration not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *Application) uploadShareCreate(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	body, ok := decodeUploadShareCreateBody(w, r)
	if !ok {
		return
	}
	token, err := nextUploadShareToken(
		r.Context(),
		a.database.SQL(),
		redisx.GenerateToken,
	)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	now := a.now()
	result, err := a.database.SQL().ExecContext(r.Context(), `
		INSERT INTO upload_shares(token_hash,token,owner_user_id,created_by_user_id,label,is_active,upload_count,max_uploads,expires_at,created_at,updated_at)
		VALUES(?,?,?,?,?,1,0,?,?,unixepoch(),unixepoch())
	`, uploads.HashToken(token), token, user.ID, user.ID,
		uploadShareNullableStringValue(body.Label),
		uploadShareNullableIntValue(body.MaxUploads),
		now.Add(time.Duration(body.ExpiresInDays)*24*time.Hour).Unix(),
	)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to create upload link")
		return
	}
	id, _ := result.LastInsertId()
	share, err := a.uploadShareByID(r.Context(), id)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, uploads.SerializeShare(share, requestOrigin(r)))
}

func nextUploadShareToken(
	ctx context.Context,
	database *sql.DB,
	generate func() (string, error),
) (string, error) {
	var token string
	for attempt := 0; attempt < 5; attempt++ {
		candidate, err := generate()
		if err != nil {
			return "", err
		}
		token = candidate
		var existingID int64
		err = database.QueryRowContext(
			ctx,
			"SELECT id FROM upload_shares WHERE token_hash = ?",
			uploads.HashToken(token),
		).Scan(&existingID)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			return token, nil
		case err != nil:
			return "", err
		}
	}
	return token, nil
}

func (a *Application) uploadShareList(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	shares, err := a.uploads.ListByOwner(r.Context(), user.ID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	result := make([]map[string]any, 0, len(shares))
	for _, share := range shares {
		result = append(result, uploads.SerializeShare(share, requestOrigin(r)))
	}
	httpx.JSON(w, http.StatusOK, result)
}

func (a *Application) uploadShareUpdate(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	id, validID, queryableID := uploadSharePathID(r.PathValue("id"))
	if !validID {
		httpx.Error(w, http.StatusBadRequest, "Invalid share id")
		return
	}
	body, ok := decodeUploadShareUpdateBody(w, r)
	if !ok {
		return
	}
	if !queryableID {
		httpx.Error(w, http.StatusNotFound, "Upload link not found")
		return
	}
	var owner int64
	if err := a.database.SQL().QueryRowContext(r.Context(), "SELECT owner_user_id FROM upload_shares WHERE id = ?", id).Scan(&owner); err != nil || owner != user.ID {
		httpx.Error(w, http.StatusNotFound, "Upload link not found")
		return
	}
	sets, args := make([]string, 0, 4), make([]any, 0, 4)
	if body.Label.Present {
		sets, args = append(sets, "label = ?"), append(args, uploadShareNullableStringValue(body.Label))
	}
	if body.IsActive != nil {
		sets, args = append(sets, "is_active = ?"), append(args, boolInt(*body.IsActive))
	}
	if body.MaxUploads.Present {
		sets, args = append(sets, "max_uploads = ?"), append(args, uploadShareNullableIntValue(body.MaxUploads))
	}
	sets = append(sets, "updated_at = unixepoch()")
	args = append(args, id)
	if _, err := a.database.SQL().ExecContext(r.Context(), "UPDATE upload_shares SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	share, err := a.uploadShareByID(r.Context(), id)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, uploads.SerializeShare(share, requestOrigin(r)))
}

func (a *Application) uploadShareDelete(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	id, validID, queryableID := uploadSharePathID(r.PathValue("id"))
	if !validID {
		httpx.Error(w, http.StatusBadRequest, "Invalid share id")
		return
	}
	if !queryableID {
		httpx.Error(w, http.StatusNotFound, "Upload link not found")
		return
	}
	result, err := a.database.SQL().ExecContext(r.Context(), "DELETE FROM upload_shares WHERE id = ? AND owner_user_id = ?", id, user.ID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "Upload link not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *Application) uploadShareByID(ctx context.Context, id int64) (uploads.Share, error) {
	// ListByOwner is owner-scoped, so use the repository's shared query through
	// the database and preserve the same serialization fields.
	var share uploads.Share
	var active int64
	var maxUploads, expiresAt, lastUsedAt sql.NullInt64
	var createdAt, updatedAt int64
	err := a.database.SQL().QueryRowContext(ctx, `
		SELECT id,token_hash,token,owner_user_id,created_by_user_id,label,is_active,
		       upload_count,max_uploads,expires_at,last_used_at,created_at,updated_at
		FROM upload_shares WHERE id = ?
	`, id).Scan(&share.ID, &share.TokenHash, &share.Token, &share.OwnerUserID, &share.CreatedByUserID,
		&share.Label, &active, &share.UploadCount, &maxUploads, &expiresAt, &lastUsedAt, &createdAt, &updatedAt)
	if err != nil {
		return uploads.Share{}, err
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
	return share, nil
}

func (a *Application) mediaProvider(ctx context.Context) (*media.Provider, error) {
	return media.NewProvider(ctx, a.settings, a.storage)
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
