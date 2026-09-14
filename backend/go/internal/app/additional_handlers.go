package app

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"

	"github.com/swzyt/chronoframe/backend/go/internal/media"
	"github.com/swzyt/chronoframe/backend/go/internal/platform/httpx"
	"github.com/swzyt/chronoframe/backend/go/internal/uploads"
)

func (a *Application) photoCreate(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	body, ok := decodePhotoCreateBody(w, r)
	if !ok {
		return
	}
	if body.FileName == "" {
		httpx.Error(w, http.StatusBadRequest, "Missing Required Parameter")
		return
	}
	provider, err := a.mediaProvider(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Storage provider unavailable")
		return
	}
	contentHash := body.ContentHash
	objectKey := joinStorageKey(provider.StoragePrefix(), "users", fmt.Sprint(user.ID), body.FileName)

	var duplicateWarning *duplicatePhotoRecord
	if !body.SkipDuplicateCheck &&
		a.settingBool(r.Context(), "system", "upload.duplicateCheck.enabled", true) {
		existing, duplicateErr := a.findUploadDuplicate(r.Context(), provider, user.ID, objectKey, body.FileName, body.ContentType, contentHash)
		if duplicateErr != nil {
			httpx.Error(w, http.StatusInternalServerError, "Failed to prepare upload")
			return
		}
		if existing != nil {
			switch uploadDuplicateCheckMode(a.settingString(r.Context(), "system", "upload.duplicateCheck.mode")) {
			case "block":
				httpx.ErrorWithData(w, http.StatusConflict, "File Already Exists", map[string]any{
					"duplicate":     true,
					"existingPhoto": existing.Map(true),
					"title":         "File Already Exists",
					"message":       fmt.Sprintf("Photo %q already exists and duplicate uploads are not allowed", body.FileName),
				})
				return
			case "skip":
				httpx.JSON(w, http.StatusOK, map[string]any{
					"skipped":       true,
					"duplicate":     true,
					"existingPhoto": existing.Map(true),
					"fileKey":       objectKey,
					"title":         "Duplicate File Skipped",
					"message":       fmt.Sprintf("Photo %q already exists and has been automatically skipped", body.FileName),
					"info":          fmt.Sprintf("Existing photo taken on %s", duplicateDateTaken(existing)),
				})
				return
			case "warn":
				duplicateWarning = existing
			}
		}
	}

	objectKey, err = a.uniqueUploadStorageKey(r.Context(), objectKey)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to prepare upload")
		return
	}

	if signedURL, signed, signedErr := provider.SignedUploadURL(r.Context(), objectKey, 3600, body.ContentType); signedErr != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to prepare upload")
		return
	} else if signed {
		response := uploadPrepareResponse{
			SignedURL:   signedURL,
			FileKey:     objectKey,
			ContentHash: nullableString(contentHash),
			ExpiresIn:   3600,
		}
		if duplicateWarning != nil {
			response.Duplicate = true
			response.ExistingPhoto = duplicateWarning.Map(true)
			response.WarningInfo = map[string]any{
				"title":   "Duplicate File Detected",
				"message": fmt.Sprintf("Photo %q already exists. Continuing will overwrite the existing photo", body.FileName),
				"warning": "Overwrite the existing photo file",
				"info":    fmt.Sprintf("Existing photo: %s, taken on %s", duplicateTitle(duplicateWarning, body.FileName), duplicateDateTaken(duplicateWarning)),
			}
		}
		httpx.JSON(w, http.StatusOK, response)
		return
	}

	response := uploadPrepareResponse{
		SignedURL:   "/api/photos/upload?key=" + encodeURIComponent(objectKey),
		FileKey:     objectKey,
		ContentHash: nullableString(contentHash),
		ExpiresIn:   3600,
	}
	if duplicateWarning != nil {
		response.Duplicate = true
		response.ExistingPhoto = duplicateWarning.Map(true)
		response.WarningInfo = map[string]any{
			"title":   "Duplicate File Detected",
			"message": fmt.Sprintf("Photo %q already exists. Continuing will overwrite the existing photo", body.FileName),
			"warning": "Overwrite the existing photo file",
			"info":    fmt.Sprintf("Existing photo: %s, taken on %s", duplicateTitle(duplicateWarning, body.FileName), duplicateDateTaken(duplicateWarning)),
		}
	}
	httpx.JSON(w, http.StatusOK, response)
}

func (a *Application) photoUpload(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	if nodeQueryIsArray(r.URL.Query(), "key") {
		httpx.Error(w, http.StatusInternalServerError, "Server Error")
		return
	}
	key := strings.TrimLeft(r.URL.Query().Get("key"), "/")
	if key == "" {
		httpx.Error(w, http.StatusBadRequest, "Upload key is required")
		return
	}
	provider, err := a.mediaProvider(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Storage provider unavailable")
		return
	}
	if user.IsAdmin == 0 && !isUserUploadStorageKey(provider, user.ID, key) {
		httpx.Error(w, http.StatusNotFound, "Storage object not found")
		return
	}
	contentType := uploadContentType(r)
	body, ok := a.checkedUploadBody(w, r, contentType)
	if !ok {
		return
	}
	if _, err := provider.Put(r.Context(), key, body.reader, body.size, contentType); err != nil {
		if isUploadTooLargeError(err) {
			httpx.Error(w, http.StatusRequestEntityTooLarge, "File too large")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "Upload failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "key": key})
}

func (a *Application) photoDuplicateCheck(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	body, ok := decodePhotoDuplicateCheckBody(w, r)
	if !ok {
		return
	}
	if !body.HasFileNames && !body.HasStorageKeys && !body.HasContentHashes {
		httpx.ErrorWithData(w, http.StatusBadRequest, "Missing Required Parameter", missingRequiredParameterData{
			Title:   "Missing Required Parameter",
			Message: "Please provide fileNames, storageKeys or contentHashes parameter",
		})
		return
	}
	results := make([]any, 0)
	for _, hash := range body.ContentHashes {
		normalized := normalizeContentHash(hash)
		photo, err := a.duplicatePhotoByContentHash(r.Context(), user.ID, normalized)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "Upload failed")
			return
		}
		results = append(results, duplicateContentHashResult{
			ContentHash:           hash,
			NormalizedContentHash: nullableString(normalized),
			Exists:                photo != nil,
			Photo:                 duplicatePhotoMap(photo, true),
		})
	}
	var provider *media.Provider
	for _, name := range body.FileNames {
		if provider == nil {
			var providerErr error
			provider, providerErr = a.mediaProvider(r.Context())
			if providerErr != nil {
				httpx.Error(w, http.StatusServiceUnavailable, "Storage provider unavailable")
				return
			}
		}
		key := joinStorageKey(provider.StoragePrefix(), "users", fmt.Sprint(user.ID), name)
		id := mediaIDForUploadDuplicate(key)
		photo, err := a.duplicatePhotoByID(r.Context(), user.ID, id, false)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "Upload failed")
			return
		}
		results = append(results, duplicateFileNameResult{
			FileName:   name,
			StorageKey: key,
			PhotoID:    id,
			Exists:     photo != nil,
			Photo:      duplicatePhotoMap(photo, false),
		})
	}
	for _, key := range body.StorageKeys {
		id := mediaIDForUploadDuplicate(key)
		photo, err := a.duplicatePhotoByID(r.Context(), user.ID, id, false)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "Upload failed")
			return
		}
		results = append(results, duplicateStorageKeyResult{
			StorageKey: key,
			PhotoID:    id,
			Exists:     photo != nil,
			Photo:      duplicatePhotoMap(photo, false),
		})
	}
	duplicates := 0
	for _, result := range results {
		if duplicateCheckResultExists(result) {
			duplicates++
		}
	}
	httpx.JSON(w, http.StatusOK, duplicateCheckResponse{
		Success:         true,
		Results:         results,
		DuplicatesFound: duplicates,
		Summary: duplicateCheckSummary{
			Title:   "Check Complete",
			Message: fmt.Sprintf("Checked %d files, found %d duplicates", len(results), duplicates),
		},
	})
}

type photoDuplicateCheckRequest struct {
	FileNames        []string
	StorageKeys      []string
	ContentHashes    []string
	HasFileNames     bool
	HasStorageKeys   bool
	HasContentHashes bool
}

func decodeOptionalJSONBody(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	decoder.UseNumber()
	if err := decodeSingleJSONValue(decoder, target); err != nil {
		if errors.Is(err, io.EOF) {
			return true
		}
		writeInvalidJSONBody(w)
		return false
	}
	return true
}

func decodeRequiredJSONObjectBody(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	return decodeRequiredJSONObjectBodyWithIssueOrdering(w, r, false)
}

func decodeRequiredJSONObjectBodyCodeFirst(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	return decodeRequiredJSONObjectBodyWithIssueOrdering(w, r, true)
}

func decodeRequiredJSONObjectBodyWithIssueOrdering(w http.ResponseWriter, r *http.Request, codeFirst bool) (map[string]json.RawMessage, bool) {
	var raw json.RawMessage
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	decoder.UseNumber()
	if err := decodeSingleJSONValue(decoder, &raw); err != nil {
		if errors.Is(err, io.EOF) {
			if codeFirst {
				writeSettingZodValidationError(w, zodInvalidTypeCodeFirstIssue([]any{}, "object", "undefined"))
			} else {
				writeMissingObjectBodyZodValidationError(w)
			}
			return nil, false
		}
		writeInvalidJSONBody(w)
		return nil, false
	}
	received := zodReceivedType(raw)
	if received != "object" {
		issue := zodInvalidTypeIssue([]any{}, "object", received)
		if codeFirst {
			issue = zodInvalidTypeCodeFirstIssue([]any{}, "object", received)
		}
		writeSettingZodValidationError(w, issue)
		return nil, false
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		httpx.Error(w, http.StatusBadRequest, "Validation Error")
		return nil, false
	}
	return object, true
}

func decodePhotoDuplicateCheckBody(w http.ResponseWriter, r *http.Request) (photoDuplicateCheckRequest, bool) {
	var raw json.RawMessage
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	decoder.UseNumber()
	if err := decodeSingleJSONValue(decoder, &raw); err != nil {
		if errors.Is(err, io.EOF) {
			writeMissingObjectBodyZodValidationError(w)
			return photoDuplicateCheckRequest{}, false
		}
		writeInvalidJSONBody(w)
		return photoDuplicateCheckRequest{}, false
	}
	received := zodReceivedType(raw)
	if received != "object" {
		writeSettingZodValidationError(w, zodInvalidTypeIssue([]any{}, "object", received))
		return photoDuplicateCheckRequest{}, false
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		httpx.Error(w, http.StatusBadRequest, "Validation Error")
		return photoDuplicateCheckRequest{}, false
	}

	var issues []zodValidationIssue
	fileNames := decodeOptionalJSONStringArray(object, "fileNames", &issues)
	storageKeys := decodeOptionalJSONStringArray(object, "storageKeys", &issues)
	contentHashes := decodeOptionalJSONStringArray(object, "contentHashes", &issues)
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return photoDuplicateCheckRequest{}, false
	}
	return photoDuplicateCheckRequest{
		FileNames:        fileNames,
		StorageKeys:      storageKeys,
		ContentHashes:    contentHashes,
		HasFileNames:     object["fileNames"] != nil,
		HasStorageKeys:   object["storageKeys"] != nil,
		HasContentHashes: object["contentHashes"] != nil,
	}, true
}

func decodeOptionalJSONStringArray(
	object map[string]json.RawMessage,
	field string,
	issues *[]zodValidationIssue,
) []string {
	raw, exists := object[field]
	if !exists {
		return nil
	}
	if zodReceivedType(raw) != "array" {
		*issues = append(*issues, zodInvalidTypeIssue([]any{field}, "array", zodReceivedType(raw)))
		return nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		*issues = append(*issues, zodInvalidTypeIssue([]any{field}, "array", zodReceivedType(raw)))
		return nil
	}
	values := make([]string, 0, len(items))
	for index, item := range items {
		if zodReceivedType(item) != "string" {
			*issues = append(*issues, zodInvalidTypeIssue([]any{field, index}, "string", zodReceivedType(item)))
			continue
		}
		var value string
		if err := json.Unmarshal(item, &value); err != nil {
			*issues = append(*issues, zodInvalidTypeIssue([]any{field, index}, "string", zodReceivedType(item)))
			continue
		}
		values = append(values, value)
	}
	return values
}

func decodeJSONStringField(object map[string]json.RawMessage, field string) (string, bool, bool) {
	raw, exists := object[field]
	if !exists {
		return "", false, false
	}
	if zodReceivedType(raw) != "string" {
		return "", true, false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", true, false
	}
	return value, true, true
}

func decodeJSONBoolField(object map[string]json.RawMessage, field string) (bool, bool, bool) {
	raw, exists := object[field]
	if !exists {
		return false, false, false
	}
	if zodReceivedType(raw) != "boolean" {
		return false, true, false
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, true, false
	}
	return value, true, true
}

type uploadPrepareResponse struct {
	SignedURL     string `json:"signedUrl"`
	FileKey       string `json:"fileKey"`
	ContentHash   any    `json:"contentHash"`
	ExpiresIn     int    `json:"expiresIn"`
	Duplicate     bool   `json:"duplicate,omitempty"`
	ExistingPhoto any    `json:"existingPhoto,omitempty"`
	WarningInfo   any    `json:"warningInfo,omitempty"`
}

type duplicateCheckResponse struct {
	Success         bool                  `json:"success"`
	Results         []any                 `json:"results"`
	DuplicatesFound int                   `json:"duplicatesFound"`
	Summary         duplicateCheckSummary `json:"summary"`
}

type duplicateCheckSummary struct {
	Title   string `json:"title"`
	Message string `json:"message"`
}

type missingRequiredParameterData struct {
	Title   string `json:"title"`
	Message string `json:"message"`
}

type duplicateContentHashResult struct {
	ContentHash           string `json:"contentHash"`
	NormalizedContentHash any    `json:"normalizedContentHash"`
	Exists                bool   `json:"exists"`
	Photo                 any    `json:"photo"`
}

type duplicateFileNameResult struct {
	FileName   string `json:"fileName"`
	StorageKey string `json:"storageKey"`
	PhotoID    string `json:"photoId"`
	Exists     bool   `json:"exists"`
	Photo      any    `json:"photo"`
}

type duplicateStorageKeyResult struct {
	StorageKey string `json:"storageKey"`
	PhotoID    string `json:"photoId"`
	Exists     bool   `json:"exists"`
	Photo      any    `json:"photo"`
}

func duplicateCheckResultExists(result any) bool {
	switch value := result.(type) {
	case duplicateContentHashResult:
		return value.Exists
	case duplicateFileNameResult:
		return value.Exists
	case duplicateStorageKeyResult:
		return value.Exists
	default:
		return false
	}
}

type duplicatePhotoRecord struct {
	ID           string
	Title        sql.NullString
	StorageKey   sql.NullString
	OriginalURL  sql.NullString
	ThumbnailURL sql.NullString
	DateTaken    sql.NullString
	FileSize     sql.NullInt64
	Width        sql.NullInt64
	Height       sql.NullInt64
	ContentHash  sql.NullString
}

func (r *duplicatePhotoRecord) Map(includeContentHash bool) map[string]any {
	if r == nil {
		return nil
	}
	value := map[string]any{
		"id":           r.ID,
		"title":        nullStringValue(r.Title),
		"storageKey":   nullStringValue(r.StorageKey),
		"originalUrl":  nullStringValue(r.OriginalURL),
		"thumbnailUrl": nullStringValue(r.ThumbnailURL),
		"dateTaken":    nullStringValue(r.DateTaken),
		"fileSize":     nullInt64Value(r.FileSize),
		"width":        nullInt64Value(r.Width),
		"height":       nullInt64Value(r.Height),
	}
	if includeContentHash {
		value["contentHash"] = nullStringValue(r.ContentHash)
	}
	return value
}

func duplicatePhotoMap(record *duplicatePhotoRecord, includeContentHash bool) any {
	if record == nil {
		return nil
	}
	return record.Map(includeContentHash)
}

func (a *Application) findUploadDuplicate(
	ctx context.Context,
	provider *media.Provider,
	userID int64,
	objectKey string,
	fileName string,
	contentType string,
	contentHash string,
) (*duplicatePhotoRecord, error) {
	existing, err := a.duplicatePhotoByContentHash(ctx, userID, contentHash)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		photoID := mediaIDForUploadDuplicate(objectKey)
		legacy, legacyErr := a.duplicatePhotoByID(ctx, userID, photoID, true)
		if legacyErr != nil {
			return nil, legacyErr
		}
		if legacy != nil {
			if contentHash == "" {
				existing = legacy
			} else {
				matches, matchErr := a.legacyPhotoMatchesContentHash(ctx, provider, legacy, contentHash)
				if matchErr != nil {
					return nil, matchErr
				}
				if matches {
					legacy.ContentHash = sql.NullString{String: contentHash, Valid: true}
					existing = legacy
				}
			}
		}
	}
	if existing != nil && isVideoUploadFile(fileName, contentType) &&
		existing.StorageKey.Valid && isLikelyImageKey(existing.StorageKey.String) {
		return nil, nil
	}
	return existing, nil
}

func (a *Application) legacyPhotoMatchesContentHash(
	ctx context.Context,
	provider *media.Provider,
	record *duplicatePhotoRecord,
	contentHash string,
) (bool, error) {
	if contentHash == "" || record == nil || !record.StorageKey.Valid ||
		strings.TrimSpace(record.StorageKey.String) == "" ||
		(record.ContentHash.Valid && strings.TrimSpace(record.ContentHash.String) != "") {
		return false, nil
	}
	raw, _, err := provider.Get(ctx, record.StorageKey.String)
	if errors.Is(err, media.ErrNotFound) {
		return false, nil
	}
	if err != nil || len(raw) == 0 {
		return false, err
	}
	if sha256Hex(raw) != contentHash {
		return false, nil
	}
	_, err = a.database.SQL().ExecContext(ctx,
		"UPDATE photos SET content_hash = ? WHERE id = ?",
		contentHash,
		record.ID,
	)
	if err != nil {
		return false, err
	}
	return true, nil
}

func (a *Application) duplicatePhotoByContentHash(
	ctx context.Context,
	userID int64,
	contentHash string,
) (*duplicatePhotoRecord, error) {
	if contentHash == "" {
		return nil, nil
	}
	return a.findDuplicatePhoto(ctx, `
		SELECT id,title,storage_key,original_url,thumbnail_url,date_taken,file_size,width,height,content_hash
		FROM photos
		WHERE owner_user_id = ? AND content_hash = ? AND content_hash IS NOT NULL
		LIMIT 1
	`, userID, contentHash)
}

func (a *Application) duplicatePhotoByID(
	ctx context.Context,
	userID int64,
	photoID string,
	includeContentHash bool,
) (*duplicatePhotoRecord, error) {
	if strings.TrimSpace(photoID) == "" {
		return nil, nil
	}
	query := `
		SELECT id,title,storage_key,original_url,thumbnail_url,date_taken,file_size,width,height,content_hash
		FROM photos
		WHERE id = ? AND owner_user_id = ?
		LIMIT 1
	`
	record, err := a.findDuplicatePhoto(ctx, query, photoID, userID)
	if err != nil || record == nil || includeContentHash {
		return record, err
	}
	record.ContentHash = sql.NullString{}
	return record, nil
}

func (a *Application) findDuplicatePhoto(
	ctx context.Context,
	query string,
	args ...any,
) (*duplicatePhotoRecord, error) {
	var record duplicatePhotoRecord
	err := a.database.SQL().QueryRowContext(ctx, query, args...).Scan(
		&record.ID,
		&record.Title,
		&record.StorageKey,
		&record.OriginalURL,
		&record.ThumbnailURL,
		&record.DateTaken,
		&record.FileSize,
		&record.Width,
		&record.Height,
		&record.ContentHash,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func (a *Application) uniqueUploadStorageKey(ctx context.Context, storageKey string) (string, error) {
	candidate := storageKey
	for attempt := 0; ; attempt++ {
		exists, err := a.uploadStorageKeyExists(ctx, candidate)
		if err != nil || !exists {
			return candidate, err
		}
		suffix := strconv.FormatInt(a.now().UnixMilli(), 36)
		if attempt > 0 {
			suffix = fmt.Sprintf("%s-%d", suffix, attempt+1)
		}
		candidate = appendStorageKeySuffix(storageKey, suffix)
	}
}

func (a *Application) uploadStorageKeyExists(ctx context.Context, storageKey string) (bool, error) {
	var photoExists int64
	if err := a.database.SQL().QueryRowContext(ctx,
		"SELECT EXISTS(SELECT 1 FROM photos WHERE storage_key = ?)",
		storageKey,
	).Scan(&photoExists); err != nil {
		return false, err
	}
	if photoExists != 0 {
		return true, nil
	}
	var taskExists int64
	if err := a.database.SQL().QueryRowContext(ctx, `
		SELECT EXISTS(
			SELECT 1
			FROM pipeline_queue
			WHERE json_extract(payload, '$.storageKey') = ?
			  AND status IN ('pending', 'in-stages', 'completed')
		)
	`, storageKey).Scan(&taskExists); err != nil {
		return false, err
	}
	return taskExists != 0, nil
}

func appendStorageKeySuffix(storageKey string, suffix string) string {
	extension := path.Ext(storageKey)
	directory, file := path.Split(storageKey)
	name := strings.TrimSuffix(file, extension)
	return path.Join(directory, name+"-"+suffix+extension)
}

func joinStorageKey(parts ...string) string {
	nonEmpty := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			nonEmpty = append(nonEmpty, part)
		}
	}
	return strings.Join(nonEmpty, "/")
}

func mediaIDForUploadDuplicate(storageKey string) string {
	if strings.EqualFold(path.Ext(storageKey), ".mp4") {
		return generateSafeVideoID(storageKey)
	}
	return generateSafePhotoID(storageKey)
}

func uploadDuplicateCheckMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "block", "warn", "skip":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "skip"
	}
}

func isVideoUploadFile(fileName string, contentType string) bool {
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "video/") {
		return true
	}
	switch strings.ToLower(path.Ext(fileName)) {
	case ".mov", ".mp4":
		return true
	default:
		return false
	}
}

func isLikelyImageKey(storageKey string) bool {
	switch strings.ToLower(path.Ext(storageKey)) {
	case ".avif", ".bmp", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp":
		return true
	default:
		return false
	}
}

func normalizeStorageKeyForAuth(key string) string {
	value := strings.ReplaceAll(key, "\\", "/")
	value = strings.TrimLeft(value, "/")
	for strings.Contains(value, "//") {
		value = strings.ReplaceAll(value, "//", "/")
	}
	return value
}

func isUserUploadStorageKey(provider interface{ StoragePrefix() string }, userID int64, storageKey string) bool {
	prefix := joinStorageKey(provider.StoragePrefix(), "users", fmt.Sprint(userID))
	return strings.HasPrefix(normalizeStorageKeyForAuth(storageKey), prefix+"/")
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullStringValue(value sql.NullString) any {
	if !value.Valid {
		return nil
	}
	return value.String
}

func nullInt64Value(value sql.NullInt64) any {
	if !value.Valid {
		return nil
	}
	return value.Int64
}

func duplicateDateTaken(record *duplicatePhotoRecord) string {
	if record == nil || !record.DateTaken.Valid || strings.TrimSpace(record.DateTaken.String) == "" {
		return "unknown date"
	}
	return record.DateTaken.String
}

func duplicateTitle(record *duplicatePhotoRecord, fallback string) string {
	if record == nil || !record.Title.Valid || strings.TrimSpace(record.Title.String) == "" {
		return fallback
	}
	return record.Title.String
}

func encodeURIComponent(value string) string {
	var builder strings.Builder
	for _, char := range []byte(value) {
		if isURIComponentUnescaped(char) {
			builder.WriteByte(char)
			continue
		}
		builder.WriteString(fmt.Sprintf("%%%02X", char))
	}
	return builder.String()
}

func isURIComponentUnescaped(char byte) bool {
	return (char >= 'A' && char <= 'Z') ||
		(char >= 'a' && char <= 'z') ||
		(char >= '0' && char <= '9') ||
		char == '-' || char == '_' || char == '.' || char == '!' ||
		char == '~' || char == '*' || char == '\'' || char == '(' || char == ')'
}

func (a *Application) photoExifReindex(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.photos == nil || a.database == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	body, ok := decodeExifReindexBody(w, r)
	if !ok {
		return
	}
	action, _ := body.Action.(string)
	if action == "single-reindex" && jsonJavaScriptTruthy(body.PhotoID) {
		photoIDBinding, valid := sqliteBindingValue(body.PhotoID)
		if !valid {
			httpx.Error(w, http.StatusInternalServerError, "Failed to reindex EXIF data")
			return
		}
		var photoID string
		err := a.database.SQL().QueryRowContext(r.Context(),
			"SELECT id FROM photos WHERE id = ? LIMIT 1", photoIDBinding,
		).Scan(&photoID)
		if errors.Is(err, sql.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "Photo not found")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "Failed to reindex EXIF data")
			return
		}
		photo, err := a.photos.FindByID(r.Context(), photoID)
		if err != nil || photo.StorageKey == nil {
			httpx.Error(w, http.StatusInternalServerError, "Failed to reindex EXIF data")
			return
		}
		provider, providerErr := a.mediaProvider(r.Context())
		if providerErr != nil {
			httpx.Error(w, http.StatusInternalServerError, "Failed to reindex EXIF data")
			return
		}
		raw, _, providerErr := provider.Get(r.Context(), *photo.StorageKey)
		if providerErr != nil {
			httpx.Error(w, http.StatusNotFound, "File not found in storage")
			return
		}
		exif, exifErr := extractExif(r.Context(), *photo.StorageKey, raw)
		if exifErr != nil {
			httpx.Error(w, http.StatusInternalServerError, "Failed to reindex EXIF data")
			return
		}
		if err := a.applyExifUpdate(r.Context(), photoID, *photo.StorageKey, exif); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "Failed to reindex EXIF data")
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{
			"success": true, "message": "EXIF 数据已成功重新索引", "photoId": body.PhotoID,
		})
		return
	}
	if action != "batch-reindex" {
		httpx.Error(w, http.StatusBadRequest, "Invalid action parameter")
		return
	}
	provider, providerErr := a.mediaProvider(r.Context())
	if providerErr != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to reindex EXIF data")
		return
	}
	ids, filterIDs, idsValid := exifReindexCandidateIDs(body.PhotoIDs)
	if !idsValid {
		httpx.Error(w, http.StatusInternalServerError, "Failed to reindex EXIF data")
		return
	}
	query := `SELECT id, storage_key FROM photos WHERE storage_key IS NOT NULL`
	args := []any{}
	if filterIDs {
		placeholders := make([]string, len(ids))
		args = make([]any, len(ids))
		for index, id := range ids {
			placeholders[index], args[index] = "?", id
		}
		query += " AND id IN (" + strings.Join(placeholders, ",") + ")"
	}
	rows, err := a.database.SQL().QueryContext(r.Context(), query, args...)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to reindex EXIF data")
		return
	}
	defer rows.Close()
	type item struct {
		id  string
		key string
	}
	items := make([]item, 0)
	for rows.Next() {
		var value item
		var key sql.NullString
		if err := rows.Scan(&value.id, &key); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "Failed to reindex EXIF data")
			return
		}
		if key.Valid {
			value.key = key.String
			items = append(items, value)
		}
	}
	if err := rows.Err(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to reindex EXIF data")
		return
	}
	if len(items) == 0 {
		httpx.JSON(w, http.StatusOK, map[string]any{
			"message": "没有找到需要重新索引的照片",
			"results": map[string]any{
				"total": 0, "processed": 0, "updated": 0, "errors": []any{},
			},
		})
		return
	}
	processed, updated := 0, 0
	errResults := make([]map[string]string, 0)
	for _, item := range items {
		processed++
		raw, _, getErr := provider.Get(r.Context(), item.key)
		if getErr != nil {
			errResults = append(errResults, map[string]string{"photoId": item.id, "error": "File not found in storage"})
			continue
		}
		exif, exifErr := extractExif(r.Context(), item.key, raw)
		if exifErr != nil {
			errResults = append(errResults, map[string]string{"photoId": item.id, "error": exifErr.Error()})
			continue
		}
		if updateErr := a.applyExifUpdate(r.Context(), item.id, item.key, exif); updateErr != nil {
			errResults = append(errResults, map[string]string{"photoId": item.id, "error": updateErr.Error()})
			continue
		}
		updated++
	}
	result := map[string]any{
		"total": len(items), "processed": processed, "updated": updated,
	}
	if len(errResults) > 0 {
		result["errors"] = errResults
	}
	if processed > 0 {
		result["statistics"] = map[string]any{
			"successRate": fmt.Sprintf("%.1f%%", float64(processed-len(errResults))/float64(processed)*100),
		}
	} else {
		result["statistics"] = map[string]any{"successRate": "0%"}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"message": "EXIF 重新索引完成", "results": result,
	})
}

func (a *Application) livePhotoManage(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.photos == nil || a.database == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	body, ok := decodeLivePhotoManageBody(w, r)
	if !ok {
		return
	}
	if !jsonJavaScriptTruthy(body.Action) {
		httpx.Error(w, http.StatusBadRequest, "Action is required")
		return
	}
	action, actionIsString := body.Action.(string)
	if !actionIsString {
		writeLivePhotoInvalidAction(w)
		return
	}
	switch action {
	case "scan":
		httpx.JSON(w, http.StatusOK, map[string]any{"message": "Scan completed", "results": emptyLivePhotoScanResult()})
	case "detect":
		photoIDs, idsOK := livePhotoCandidateIDs(body.PhotoIDs)
		if !idsOK {
			writeLivePhotoManagementError(w)
			return
		}
		photos, queryErr := a.livePhotoCandidates(r.Context(), photoIDs)
		if queryErr != nil {
			writeLivePhotoManagementError(w)
			return
		}
		provider, providerErr := a.mediaProvider(r.Context())
		if providerErr != nil {
			httpx.JSON(w, http.StatusOK, map[string]any{
				"message": "Batch LivePhoto detection completed",
				"results": map[string]any{
					"total": len(photos), "processed": len(photos),
					"found": 0, "results": []map[string]any{},
				},
			})
			return
		}
		results := make([]map[string]any, 0)
		for _, photo := range photos {
			if photo.StorageKey == nil {
				continue
			}
			videoKey, size, found := a.findLivePhotoVideo(r.Context(), provider, *photo.StorageKey)
			if found {
				results = append(results, map[string]any{
					"photoId": photo.ID, "storageKey": *photo.StorageKey,
					"found": true, "videoKey": videoKey, "videoSize": size,
				})
			}
		}
		httpx.JSON(w, http.StatusOK, map[string]any{
			"message": "Batch LivePhoto detection completed",
			"results": map[string]any{
				"total": len(photos), "processed": len(photos),
				"found": len(results), "results": results,
			},
		})
	case "process":
		if !jsonJavaScriptTruthy(body.VideoKey) {
			httpx.Error(w, http.StatusBadRequest, "videoKey is required for process action")
			return
		}
		videoKey, videoKeyIsString := body.VideoKey.(string)
		if !videoKeyIsString {
			httpx.JSON(w, http.StatusOK, map[string]any{
				"message": "Failed to process LivePhoto",
				"success": false, "videoKey": body.VideoKey,
			})
			return
		}
		provider, providerErr := a.mediaProvider(r.Context())
		if providerErr != nil {
			httpx.JSON(w, http.StatusOK, map[string]any{
				"message": "Failed to process LivePhoto",
				"success": false, "videoKey": body.VideoKey,
			})
			return
		}
		contents, _, getErr := provider.Get(r.Context(), videoKey)
		if getErr != nil || !isLivePhotoVideoKey(videoKey, int64(len(contents))) {
			httpx.JSON(w, http.StatusOK, map[string]any{
				"message": "Failed to process LivePhoto",
				"success": false, "videoKey": body.VideoKey,
			})
			return
		}
		photoID, found := a.findPhotoForLiveVideo(r.Context(), videoKey)
		if !found {
			httpx.JSON(w, http.StatusOK, map[string]any{
				"message": "Failed to process LivePhoto",
				"success": false, "videoKey": body.VideoKey,
			})
			return
		}
		publicURL := a.publicStorageURL(provider, videoKey)
		if _, updateErr := a.database.SQL().ExecContext(r.Context(), `
			UPDATE photos
			SET is_live_photo = 1, live_photo_video_url = ?, live_photo_video_key = ?
			WHERE id = ?
		`, publicURL, videoKey, photoID); updateErr != nil {
			httpx.JSON(w, http.StatusOK, map[string]any{
				"message": "Failed to process LivePhoto",
				"success": false, "videoKey": body.VideoKey,
			})
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{
			"message": "LivePhoto processed successfully",
			"success": true, "videoKey": body.VideoKey,
		})
	case "update-photo":
		if !jsonJavaScriptTruthy(body.PhotoID) {
			httpx.Error(w, http.StatusBadRequest, "photoId is required for update-photo action")
			return
		}
		photoID, photoIDIsString := body.PhotoID.(string)
		if !photoIDIsString {
			if _, isNumber := body.PhotoID.(json.Number); isNumber {
				httpx.Error(w, http.StatusNotFound, "Photo not found")
			} else {
				writeLivePhotoManagementError(w)
			}
			return
		}
		photo, err := a.photos.FindByID(r.Context(), photoID)
		if errors.Is(err, sql.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "Photo not found")
			return
		}
		if err != nil {
			writeLivePhotoManagementError(w)
			return
		}
		if photo.StorageKey == nil {
			httpx.JSON(w, http.StatusOK, map[string]any{
				"message": "No matching video found for this photo",
				"success": false, "photoId": body.PhotoID,
			})
			return
		}
		provider, providerErr := a.mediaProvider(r.Context())
		if providerErr != nil {
			writeLivePhotoManagementError(w)
			return
		}
		videoKey, _, found := a.findLivePhotoVideo(r.Context(), provider, *photo.StorageKey)
		if !found {
			httpx.JSON(w, http.StatusOK, map[string]any{
				"message": "No matching video found for this photo",
				"success": false, "photoId": body.PhotoID,
			})
			return
		}
		publicURL := a.publicStorageURL(provider, videoKey)
		_, updateErr := a.database.SQL().ExecContext(r.Context(), `
			UPDATE photos
			SET is_live_photo = 1, live_photo_video_url = ?, live_photo_video_key = ?
			WHERE id = ?
		`, publicURL, videoKey, photoID)
		if updateErr != nil {
			writeLivePhotoManagementError(w)
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{
			"message": "Photo updated to LivePhoto successfully",
			"success": true, "photoId": body.PhotoID, "videoKey": videoKey,
		})
	default:
		writeLivePhotoInvalidAction(w)
	}
}

func (a *Application) publicUploadPrepare(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	share, _, err := a.uploads.FindUsable(r.Context(), token, a.now())
	if err != nil {
		uploadShareError(w, err)
		return
	}
	body, ok := decodePublicUploadPrepareBody(w, r)
	if !ok {
		return
	}
	provider, providerErr := a.mediaProvider(r.Context())
	if providerErr != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Storage provider unavailable")
		return
	}
	key, err := a.buildUploadShareStorageKey(provider, share.OwnerUserID, share.ID, body.FileName)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to prepare upload")
		return
	}
	contentHash := normalizeContentHash(body.ContentHash)
	if a.settingBool(r.Context(), "system", "upload.duplicateCheck.enabled", true) {
		existing, duplicateErr := a.findUploadDuplicate(r.Context(), provider, share.OwnerUserID, key, body.FileName, body.ContentType, contentHash)
		if duplicateErr != nil {
			httpx.Error(w, http.StatusInternalServerError, "Failed to prepare upload")
			return
		}
		if existing != nil {
			httpx.ErrorWithData(w, http.StatusConflict, "File Already Exists", map[string]any{
				"duplicate":     true,
				"existingPhoto": existing.Map(true),
				"title":         "File Already Exists",
				"message":       fmt.Sprintf("Photo %q already exists and duplicate uploads are not allowed", body.FileName),
			})
			return
		}
	}
	if signedURL, signed, signedErr := provider.SignedUploadURL(r.Context(), key, 3600, body.ContentType); signedErr != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to prepare upload")
		return
	} else if signed {
		httpx.JSON(w, http.StatusOK, uploadPrepareResponse{
			SignedURL:   signedURL,
			FileKey:     key,
			ContentHash: nullableString(contentHash),
			ExpiresIn:   3600,
		})
		return
	}
	httpx.JSON(w, http.StatusOK, uploadPrepareResponse{
		SignedURL:   fmt.Sprintf("/api/upload-shares/public/%s/upload?key=%s", encodeURIComponent(token), encodeURIComponent(key)),
		FileKey:     key,
		ContentHash: nullableString(contentHash),
		ExpiresIn:   3600,
	})
}

type publicUploadPrepareRequest struct {
	FileName    string
	ContentType string
	ContentHash string
}

func decodePublicUploadPrepareBody(w http.ResponseWriter, r *http.Request) (publicUploadPrepareRequest, bool) {
	object, ok := decodeRequiredJSONObjectBody(w, r)
	if !ok {
		return publicUploadPrepareRequest{}, false
	}

	var issues []zodValidationIssue
	fileName, exists, valid := decodeJSONStringField(object, "fileName")
	switch {
	case !exists || !valid:
		issues = append(issues, zodInvalidTypeIssue([]any{"fileName"}, "string", zodReceivedType(object["fileName"])))
	case len(fileName) < 1:
		issues = append(issues, zodTooSmallStringIssue([]any{"fileName"}, 1))
	case len(fileName) > 255:
		issues = append(issues, zodTooBigStringIssue([]any{"fileName"}, 255))
	}
	contentType, exists, valid := decodeJSONStringField(object, "contentType")
	if exists && !valid {
		issues = append(issues, zodInvalidTypeIssue([]any{"contentType"}, "string", zodReceivedType(object["contentType"])))
	}
	contentHash, exists, valid := decodeJSONStringField(object, "contentHash")
	if exists && !valid {
		issues = append(issues, zodInvalidTypeIssue([]any{"contentHash"}, "string", zodReceivedType(object["contentHash"])))
	}
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return publicUploadPrepareRequest{}, false
	}
	return publicUploadPrepareRequest{
		FileName:    fileName,
		ContentType: contentType,
		ContentHash: contentHash,
	}, true
}

func (a *Application) buildUploadShareStorageKey(provider interface{ StoragePrefix() string }, ownerUserID int64, shareID int64, fileName string) (string, error) {
	extension := strings.ToLower(path.Ext(fileName))
	if !safeUploadExtension(extension) {
		extension = ""
	}
	baseName := strings.TrimSuffix(path.Base(fileName), path.Ext(fileName))
	if baseName == "" {
		baseName = "upload"
	}
	safeBaseName := sanitizeFileName(baseName, 80, "upload", 1)
	randomSuffix, err := randomHex(6)
	if err != nil {
		return "", err
	}
	return joinStorageKey(
		provider.StoragePrefix(),
		"users",
		fmt.Sprint(ownerUserID),
		"guest-uploads",
		fmt.Sprint(shareID),
		a.now().UTC().Format("2006-01-02"),
		safeBaseName+"-"+randomSuffix+extension,
	), nil
}

func safeUploadExtension(value string) bool {
	if len(value) < 2 || len(value) > 13 || value[0] != '.' {
		return false
	}
	for _, char := range value[1:] {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') {
			return false
		}
	}
	return true
}

func randomHex(byteLength int) (string, error) {
	buffer := make([]byte, byteLength)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func (a *Application) publicUploadTask(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	share, _, err := a.uploads.FindUsable(r.Context(), token, a.now())
	if err != nil {
		uploadShareError(w, err)
		return
	}
	payload, ok := decodePublicUploadTaskBody(w, r)
	if !ok {
		return
	}
	key, _ := payload["storageKey"].(string)
	provider, providerErr := a.mediaProvider(r.Context())
	if providerErr != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Storage provider unavailable")
		return
	}
	if !isUploadShareStorageKey(provider, share.OwnerUserID, share.ID, key) {
		httpx.Error(w, http.StatusNotFound, "Storage object not found")
		return
	}
	if _, providerErr = provider.Meta(r.Context(), key); providerErr != nil {
		httpx.Error(w, http.StatusNotFound, "Storage object not found")
		return
	}
	priority := int64(1)
	if payload["type"] == "live-photo-video" {
		priority = 0
	}
	taskID, claimed, err := a.enqueuePublicUploadShareTask(r.Context(), share, payload, priority, 3)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to add task")
		return
	}
	if !claimed {
		refreshed, _, usableErr := a.uploads.FindUsable(r.Context(), token, a.now())
		if usableErr != nil {
			uploadShareError(w, usableErr)
			return
		}
		taskID, claimed, err = a.enqueuePublicUploadShareTask(r.Context(), refreshed, payload, priority, 3)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "Failed to add task")
			return
		}
		if !claimed {
			httpx.Error(w, http.StatusConflict, "Upload link changed, please retry")
			return
		}
	}
	httpx.JSON(w, http.StatusOK, queueAddTaskResponse{
		Success: true, TaskID: taskID, Message: "Task added to queue successfully",
		Payload: payload,
	})
}

func decodePublicUploadTaskBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	object, ok := decodeRequiredJSONObjectBody(w, r)
	if !ok {
		return nil, false
	}
	payloadRaw, exists := object["payload"]
	if !exists || zodReceivedType(payloadRaw) != "object" {
		writeSettingZodValidationError(
			w,
			zodInvalidTypeCodeFirstIssue([]any{"payload"}, "object", zodReceivedType(payloadRaw)),
		)
		return nil, false
	}
	var payloadObject map[string]json.RawMessage
	if err := json.Unmarshal(payloadRaw, &payloadObject); err != nil {
		httpx.Error(w, http.StatusBadRequest, "Validation Error")
		return nil, false
	}
	taskType, exists, valid := decodeJSONStringField(payloadObject, "type")
	if !exists || !valid || !validPublicUploadTaskType(taskType) {
		writeSettingZodValidationError(
			w,
			zodInvalidDiscriminatorIssue(
				[]any{"payload", "type"},
				"type",
				"photo",
				"live-photo-video",
				"video",
			),
		)
		return nil, false
	}
	storageKey, exists, valid := decodeJSONStringField(payloadObject, "storageKey")
	var issues []zodValidationIssue
	switch {
	case !exists || !valid:
		issues = append(issues, zodInvalidTypeIssue([]any{"payload", "storageKey"}, "string", zodReceivedType(payloadObject["storageKey"])))
	case len(storageKey) < 1:
		issues = append(issues, zodTooSmallStringIssue([]any{"payload", "storageKey"}, 1))
	}

	var contentHash string
	var hasContentHash bool
	if taskType == "photo" || taskType == "video" {
		var validContentHash bool
		contentHash, hasContentHash, validContentHash = decodeJSONStringField(payloadObject, "contentHash")
		if hasContentHash {
			switch {
			case !validContentHash:
				issues = append(issues, zodInvalidTypeIssue([]any{"payload", "contentHash"}, "string", zodReceivedType(payloadObject["contentHash"])))
			case normalizeContentHash(contentHash) == "":
				issues = append(issues, zodInvalidFormatIssue(
					[]any{"payload", "contentHash"},
					"regex",
					"/^[a-f0-9]{64}$/i",
					"Invalid string: must match pattern /^[a-f0-9]{64}$/i",
				))
			}
		}
	}
	var eraseLocation bool
	var hasEraseLocation bool
	if taskType == "photo" {
		var validEraseLocation bool
		eraseLocation, hasEraseLocation, validEraseLocation = decodeJSONBoolField(payloadObject, "eraseLocation")
		if hasEraseLocation && !validEraseLocation {
			issues = append(issues, zodInvalidTypeIssue([]any{"payload", "eraseLocation"}, "boolean", zodReceivedType(payloadObject["eraseLocation"])))
		}
	}
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return nil, false
	}

	payload := map[string]any{"type": taskType, "storageKey": storageKey}
	switch taskType {
	case "photo":
		if hasContentHash {
			payload["contentHash"] = contentHash
		}
		if hasEraseLocation {
			payload["eraseLocation"] = eraseLocation
		}
	case "video":
		if hasContentHash {
			payload["contentHash"] = contentHash
		}
	}
	return payload, true
}

func validPublicUploadTaskType(value string) bool {
	return value == "photo" || value == "live-photo-video" || value == "video"
}

func (a *Application) enqueuePublicUploadShareTask(
	ctx context.Context,
	share uploads.Share,
	payload map[string]any,
	priority int64,
	maxAttempts int64,
) (int64, bool, error) {
	tx, err := a.database.SQL().BeginTx(ctx, nil)
	if err != nil {
		return 0, false, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	now := a.now().Unix()
	result, err := tx.ExecContext(ctx, `
		UPDATE upload_shares
		SET upload_count = upload_count + 1,
			last_used_at = ?,
			updated_at = ?
		WHERE id = ?
		  AND is_active = 1
		  AND (expires_at IS NULL OR expires_at > ?)
		  AND (max_uploads IS NULL OR upload_count < max_uploads)
	`, now, now, share.ID, now)
	if err != nil {
		return 0, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, false, err
	}
	if affected == 0 {
		return 0, false, nil
	}
	taskID, err := enqueueTaskWithExecutor(ctx, tx, payload, float64(priority), float64(maxAttempts), share.OwnerUserID)
	if err != nil {
		return 0, false, err
	}
	if err := tx.Commit(); err != nil {
		return 0, false, err
	}
	committed = true
	return taskID, true, nil
}

func (a *Application) publicUploadObject(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	share, _, err := a.uploads.FindUsable(r.Context(), token, a.now())
	if err != nil {
		uploadShareError(w, err)
		return
	}
	provider, providerErr := a.mediaProvider(r.Context())
	if providerErr != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Storage provider unavailable")
		return
	}
	if nodeQueryIsArray(r.URL.Query(), "key") {
		httpx.Error(w, http.StatusInternalServerError, "Server Error")
		return
	}
	key := strings.TrimLeft(r.URL.Query().Get("key"), "/")
	if key == "" {
		httpx.Error(w, http.StatusBadRequest, "Missing Required Parameter")
		return
	}
	if !isUploadShareStorageKey(provider, share.OwnerUserID, share.ID, key) {
		httpx.Error(w, http.StatusNotFound, "Storage object not found")
		return
	}
	contentType := uploadContentType(r)
	body, ok := a.checkedUploadBody(w, r, contentType)
	if !ok {
		return
	}
	if _, providerErr := provider.Put(r.Context(), key, body.reader, body.size, contentType); providerErr != nil {
		if isUploadTooLargeError(providerErr) {
			httpx.Error(w, http.StatusRequestEntityTooLarge, "File too large")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "Upload failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "key": key})
}

func uploadShareError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, uploads.ErrExpired):
		httpx.Error(w, http.StatusGone, "Upload link expired")
	case errors.Is(err, uploads.ErrLimitReached):
		httpx.Error(w, http.StatusTooManyRequests, "Upload link limit reached")
	default:
		httpx.Error(w, http.StatusNotFound, "Upload link not found")
	}
}
