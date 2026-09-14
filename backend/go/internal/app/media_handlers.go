package app

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/auth"
	"github.com/swzyt/chronoframe/backend/go/internal/media"
	"github.com/swzyt/chronoframe/backend/go/internal/platform/httpx"
)

type mediaPhoto struct {
	ID                string
	MediaType         string
	StorageKey        *string
	ThumbnailKey      *string
	DisplayKey        *string
	OriginalURL       *string
	ThumbnailURL      *string
	LivePhotoVideoKey *string
	VideoPlaybackKey  *string
	OwnerUserID       int64
}

type shareOGPhoto struct {
	mediaPhoto
	Title        *string
	Description  *string
	City         *string
	LocationName *string
	Exif         map[string]any
}

func (a *Application) imageRoute(w http.ResponseWriter, r *http.Request) {
	key, _ := url.PathUnescape(r.PathValue("key"))
	key = strings.TrimLeft(key, "/")
	if key == "" {
		httpx.Error(w, http.StatusBadRequest, "Invalid key")
		return
	}
	setCookieVaryHeader(w.Header())
	photo, err := a.findMediaPhoto(r, key)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "Photo not found")
		return
	}
	if !a.requirePublicPhotoAccess(w, r, photo.ID) {
		httpx.Error(w, http.StatusUnauthorized, "Site access required to view more photos")
		return
	}
	if sameMediaKey(photo.StorageKey, key) && photo.MediaType != "video" {
		state := a.accessState(w, r, a.optionalUser(w, r) != nil)
		if !state.Granted {
			httpx.Error(w, http.StatusUnauthorized, "Site access required to download original photos")
			return
		}
	}
	a.serveMedia(w, r, key)
}

func (a *Application) storageRoute(w http.ResponseWriter, r *http.Request) {
	key, _ := url.PathUnescape(r.PathValue("key"))
	key = strings.TrimLeft(strings.ReplaceAll(key, "\\", "/"), "/")
	for strings.Contains(key, "//") {
		key = strings.ReplaceAll(key, "//", "/")
	}
	if strings.Contains(key, "..") {
		httpx.Error(w, http.StatusBadRequest, "Invalid path")
		return
	}
	setCookieVaryHeader(w.Header())
	provider, err := a.mediaProvider(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "Not Found")
		return
	}
	photo, err := a.findMediaPhoto(r, key)
	if err != nil || !a.requirePublicPhotoAccess(w, r, photo.ID) {
		httpx.Error(w, http.StatusNotFound, "Not Found")
		return
	}
	if sameMediaKey(photo.StorageKey, key) && photo.MediaType != "video" {
		state := a.accessState(w, r, a.optionalUser(w, r) != nil)
		if !state.Granted {
			httpx.Error(w, http.StatusUnauthorized, "Site access required to download original photos")
			return
		}
	}
	a.serveMediaWithProvider(w, r, provider, key, true)
}

func (a *Application) displayRoute(w http.ResponseWriter, r *http.Request) {
	photo, err := a.findMediaPhotoByID(r, r.PathValue("photoID"))
	setCookieVaryHeader(w.Header())
	if err != nil || photo.MediaType == "video" {
		httpx.Error(w, http.StatusNotFound, "Photo not found")
		return
	}
	if !a.requireDisplayPhotoAccess(w, r, photo) {
		return
	}
	provider, err := a.mediaProvider(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Storage provider unavailable")
		return
	}
	if key := firstMediaKey(photo.DisplayKey); key != "" {
		data, _, err := provider.Get(r.Context(), key)
		if err == nil {
			a.serveBinary(w, r, data, "image/webp", "private, max-age=604800",
				fmt.Sprintf(`W/"display-%s-%d"`, photo.ID, len(data)))
			return
		}
	}
	key := firstMediaKey(photo.StorageKey)
	if key == "" {
		httpx.Error(w, http.StatusNotFound, "Photo file not found")
		return
	}
	source, _, err := provider.Get(r.Context(), key)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "Photo file not found")
		return
	}
	display, err := generateDisplayImage(r.Context(), key, source)
	if err != nil {
		a.logger.WarnContext(r.Context(), "Go display image generation failed",
			"request_id", httpx.RequestID(r.Context()), "photo_id", photo.ID, "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Display image generation failed")
		return
	}
	displayKey := fmt.Sprintf("display/%d/%s.webp", photo.OwnerUserID, photo.ID)
	stored, err := provider.Put(r.Context(), displayKey, bytes.NewReader(display), int64(len(display)), "image/webp")
	if err != nil {
		a.logger.WarnContext(r.Context(), "Go display image storage write failed",
			"request_id", httpx.RequestID(r.Context()), "photo_id", photo.ID, "key", displayKey, "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Display image generation failed")
		return
	}
	storedKey := strings.TrimSpace(stored.Key)
	if storedKey == "" {
		storedKey = displayKey
	}
	if _, err := a.database.SQL().ExecContext(r.Context(),
		"UPDATE photos SET display_key = ? WHERE id = ?",
		storedKey, photo.ID,
	); err != nil {
		a.logger.WarnContext(r.Context(), "Go display image key update failed",
			"request_id", httpx.RequestID(r.Context()), "photo_id", photo.ID, "key", storedKey, "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Display image generation failed")
		return
	}
	a.serveBinary(w, r, display, "image/webp", "private, max-age=604800",
		fmt.Sprintf(`W/"display-%s-%d"`, photo.ID, len(display)))
}

func (a *Application) thumbRoute(w http.ResponseWriter, r *http.Request) {
	raw := r.PathValue("thumbnailURL")
	if raw == "" {
		httpx.Error(w, http.StatusBadRequest, "Invalid thumbnailUrl")
		return
	}
	setCookieVaryHeader(w.Header())
	raw, _ = url.PathUnescape(raw)
	key := ""
	var photo mediaPhoto
	var err error
	if strings.HasPrefix(raw, "/image/") || strings.HasPrefix(raw, "/storage/") {
		key = strings.TrimPrefix(strings.TrimPrefix(raw, "/image/"), "/storage/")
		key, _ = url.PathUnescape(key)
		photo, err = a.findMediaPhoto(r, key)
	} else {
		photo, err = a.findMediaPhotoByURL(r, raw)
	}
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "Photo not found")
		return
	}
	if !a.requirePublicPhotoAccess(w, r, photo.ID) {
		httpx.Error(w, http.StatusUnauthorized, "Site access required to view more photos")
		return
	}
	if key == "" {
		key = firstMediaKey(photo.ThumbnailKey, photo.StorageKey)
	}
	if key == "" {
		httpx.Error(w, http.StatusNotFound, "Photo not found")
		return
	}
	provider, err := a.mediaProvider(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Storage provider unavailable")
		return
	}
	source, _, err := provider.Get(r.Context(), key)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "Photo not found")
		return
	}
	thumbnail, err := generateJPEGThumbnail(r.Context(), key, source)
	if err != nil {
		a.logger.WarnContext(r.Context(), "Go JPEG thumbnail generation failed",
			"request_id", httpx.RequestID(r.Context()), "photo_id", photo.ID, "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Thumbnail generation failed")
		return
	}
	a.serveBinary(w, r, thumbnail, "image/jpeg", "private, max-age=86400", "")
}

func (a *Application) ogMediaRoute(w http.ResponseWriter, r *http.Request) {
	photo, err := a.findMediaPhotoByID(r, r.PathValue("photoID"))
	token := r.URL.Query().Get("token")
	if err != nil || token == "" || nodeQueryIsArray(r.URL.Query(), "token") || photo.ThumbnailKey == nil {
		httpx.Error(w, http.StatusNotFound, "Image not found")
		return
	}
	version := strconv.FormatInt(a.access.Version(r.Context()), 10)
	if !media.VerifyOGMediaToken(photo.ID, *photo.ThumbnailKey, token, version) {
		httpx.Error(w, http.StatusNotFound, "Image not found")
		return
	}
	provider, err := a.mediaProvider(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Storage provider unavailable")
		return
	}
	image, _, err := provider.Get(r.Context(), *photo.ThumbnailKey)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "Image not found")
		return
	}
	a.serveBinary(w, r, image, "image/webp", "private, max-age=86400", "")
}

func (a *Application) shareOGRoute(w http.ResponseWriter, r *http.Request) {
	rawPhotoID := r.PathValue("photoID")
	if !strings.HasSuffix(rawPhotoID, ".png") {
		httpx.Error(w, http.StatusNotFound, "Image not found")
		return
	}
	setCookieVaryHeader(w.Header())
	photoID := strings.TrimSuffix(rawPhotoID, ".png")
	photo, err := a.findMediaPhotoByID(r, photoID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "Image not found")
		return
	}
	if !a.requirePublicPhotoAccess(w, r, photo.ID) {
		httpx.Error(w, http.StatusUnauthorized, "Site access required to view more photos")
		return
	}
	sharePhoto, err := a.findShareOGPhoto(r, photoID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "Image not found")
		return
	}
	image, err := a.generateShareOG(r, sharePhoto)
	if err != nil {
		a.logger.WarnContext(r.Context(), "Go share OG generation failed",
			"request_id", httpx.RequestID(r.Context()), "photo_id", photo.ID, "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Share image generation failed")
		return
	}
	a.serveBinary(w, r, image, "image/png", "private, max-age=86400", "")
}

func (a *Application) findMediaPhoto(_ *http.Request, key string) (mediaPhoto, error) {
	normalized := strings.TrimLeft(strings.ReplaceAll(key, "\\", "/"), "/")
	for strings.Contains(normalized, "//") {
		normalized = strings.ReplaceAll(normalized, "//", "/")
	}
	var photo mediaPhoto
	err := a.database.SQL().QueryRow(`
		SELECT id,media_type,storage_key,thumbnail_key,display_key,original_url,thumbnail_url,
		       live_photo_video_key,video_playback_key,owner_user_id
		FROM photos
		WHERE storage_key = ? OR storage_key = ? OR thumbnail_key = ? OR thumbnail_key = ?
		   OR display_key = ? OR display_key = ? OR live_photo_video_key = ? OR live_photo_video_key = ?
		   OR video_playback_key = ? OR video_playback_key = ?
		   OR original_url = ? OR original_url = ? OR thumbnail_url = ? OR thumbnail_url = ?
		LIMIT 1
	`, normalized, "/"+normalized, normalized, "/"+normalized, normalized, "/"+normalized,
		normalized, "/"+normalized, normalized, "/"+normalized,
		"/image/"+normalized, "/storage/"+normalized, "/image/"+normalized, "/storage/"+normalized).Scan(
		&photo.ID, &photo.MediaType, &photo.StorageKey, &photo.ThumbnailKey, &photo.DisplayKey,
		&photo.OriginalURL, &photo.ThumbnailURL, &photo.LivePhotoVideoKey, &photo.VideoPlaybackKey,
		&photo.OwnerUserID)
	return photo, err
}

func (a *Application) findMediaPhotoByID(_ *http.Request, id string) (mediaPhoto, error) {
	var photo mediaPhoto
	err := a.database.SQL().QueryRow(`
		SELECT id,media_type,storage_key,thumbnail_key,display_key,original_url,thumbnail_url,
		       live_photo_video_key,video_playback_key,owner_user_id
		FROM photos WHERE id = ?
	`, id).Scan(&photo.ID, &photo.MediaType, &photo.StorageKey, &photo.ThumbnailKey, &photo.DisplayKey,
		&photo.OriginalURL, &photo.ThumbnailURL, &photo.LivePhotoVideoKey, &photo.VideoPlaybackKey,
		&photo.OwnerUserID)
	return photo, err
}

func (a *Application) findMediaPhotoByURL(_ *http.Request, value string) (mediaPhoto, error) {
	var photo mediaPhoto
	err := a.database.SQL().QueryRow(`
		SELECT id,media_type,storage_key,thumbnail_key,display_key,original_url,thumbnail_url,
		       live_photo_video_key,video_playback_key,owner_user_id
		FROM photos WHERE original_url = ? OR thumbnail_url = ?
		LIMIT 1
	`, value, value).Scan(&photo.ID, &photo.MediaType, &photo.StorageKey, &photo.ThumbnailKey, &photo.DisplayKey,
		&photo.OriginalURL, &photo.ThumbnailURL, &photo.LivePhotoVideoKey, &photo.VideoPlaybackKey,
		&photo.OwnerUserID)
	return photo, err
}

func sameMediaKey(value *string, key string) bool {
	if value == nil {
		return false
	}
	return strings.TrimLeft(*value, "/") == strings.TrimLeft(key, "/")
}

func firstMediaKey(values ...*string) string {
	for _, value := range values {
		if value != nil && strings.TrimSpace(*value) != "" {
			return strings.TrimLeft(*value, "/")
		}
	}
	return ""
}

func canManageMediaPhoto(user *auth.User, photo mediaPhoto) bool {
	return user != nil && (user.IsAdmin != 0 || user.ID == photo.OwnerUserID)
}

func (a *Application) isPublicMediaPhoto(ctx context.Context, photoID string) (bool, error) {
	if a == nil || a.database == nil {
		return false, nil
	}
	var id string
	err := a.database.SQL().QueryRowContext(ctx, `
		SELECT photos.id
		FROM photos
		WHERE photos.id = ?
		  AND NOT EXISTS (
			SELECT 1
			FROM album_photos AS hidden_album_photos
			INNER JOIN albums AS hidden_albums
			  ON hidden_albums.id = hidden_album_photos.album_id
			WHERE hidden_album_photos.photo_id = photos.id
			  AND hidden_albums.is_hidden = 1
		  )
		LIMIT 1
	`, photoID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (a *Application) requireDisplayPhotoAccess(w http.ResponseWriter, r *http.Request, photo mediaPhoto) bool {
	if canManageMediaPhoto(a.optionalUser(w, r), photo) {
		return true
	}
	public, err := a.isPublicMediaPhoto(r.Context(), photo.ID)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "display photo access lookup failed",
			"request_id", httpx.RequestID(r.Context()), "photo_id", photo.ID, "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return false
	}
	if !public {
		httpx.Error(w, http.StatusNotFound, "Photo not found")
		return false
	}
	if !a.requirePublicPhotoAccess(w, r, photo.ID) {
		httpx.Error(w, http.StatusUnauthorized, "Site access required to view more photos")
		return false
	}
	return true
}

func (a *Application) serveBinary(
	w http.ResponseWriter,
	r *http.Request,
	data []byte,
	contentType string,
	cache string,
	etag string,
) {
	w.Header().Set("Content-Type", contentType)
	setPrivateMediaCacheHeaders(w.Header(), cache)
	if etag != "" {
		w.Header().Set("ETag", etag)
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(data)
}

func (a *Application) findShareOGPhoto(_ *http.Request, id string) (shareOGPhoto, error) {
	var photo shareOGPhoto
	var exif sql.NullString
	err := a.database.SQL().QueryRow(`
		SELECT id,media_type,storage_key,thumbnail_key,display_key,original_url,thumbnail_url,
		       live_photo_video_key,video_playback_key,owner_user_id,
		       title,description,city,location_name,exif
		FROM photos WHERE id = ?
	`, id).Scan(
		&photo.ID, &photo.MediaType, &photo.StorageKey, &photo.ThumbnailKey,
		&photo.DisplayKey, &photo.OriginalURL, &photo.ThumbnailURL,
		&photo.LivePhotoVideoKey, &photo.VideoPlaybackKey, &photo.OwnerUserID,
		&photo.Title, &photo.Description, &photo.City, &photo.LocationName,
		&exif,
	)
	if err != nil {
		return shareOGPhoto{}, err
	}
	photo.Exif = map[string]any{}
	if exif.Valid && strings.TrimSpace(exif.String) != "" {
		_ = json.Unmarshal([]byte(exif.String), &photo.Exif)
	}
	return photo, nil
}

func (a *Application) generateShareOG(r *http.Request, photo shareOGPhoto) ([]byte, error) {
	appTitle := a.settingString(r.Context(), "app", "title")
	if appTitle == "" {
		appTitle = "ChronoFrame"
	}
	headline := "PHOTO"
	if photo.MediaType == "video" {
		headline = "VIDEO"
	}
	title := truncateText(nodeStringOr(photo.Title, appTitle), 16)

	mediaPNG, err := a.loadSharePreviewMedia(r, photo, headline, title)
	if err != nil {
		mediaPNG, err = svgToPNG(r.Context(), fallbackMediaSVG(headline, title))
		if err != nil {
			return svgToPNG(r.Context(), fallbackShareSVG(headline, title, appTitle))
		}
	}

	image, err := composeShareOGImage(r.Context(), mediaPNG, shareOverlaySVG(photo, headline, title, appTitle))
	if err == nil {
		return image, nil
	}
	return svgToPNG(r.Context(), fallbackShareSVG(headline, title, appTitle))
}

func (a *Application) loadSharePreviewMedia(
	r *http.Request,
	photo shareOGPhoto,
	headline string,
	title string,
) ([]byte, error) {
	provider, err := a.mediaProvider(r.Context())
	if err != nil {
		return nil, err
	}
	var lastErr error
	for _, key := range sharePreviewCandidateKeys(photo) {
		source, _, err := provider.Get(r.Context(), key)
		if err != nil {
			lastErr = err
			continue
		}
		media, err := generateShareMedia(r.Context(), key, source)
		if err == nil {
			return media, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("no usable share media")
	}
	return nil, lastErr
}

func sharePreviewCandidateKeys(photo shareOGPhoto) []string {
	if photo.MediaType == "video" {
		return uniqueMediaKeys(
			photo.ThumbnailKey,
			photo.DisplayKey,
			mediaKeyFromProxyURL(photo.ThumbnailURL),
			mediaKeyFromProxyURL(photo.OriginalURL),
			photo.StorageKey,
		)
	}
	return uniqueMediaKeys(
		photo.DisplayKey,
		photo.StorageKey,
		photo.ThumbnailKey,
		mediaKeyFromProxyURL(photo.OriginalURL),
		mediaKeyFromProxyURL(photo.ThumbnailURL),
	)
}

func uniqueMediaKeys(values ...*string) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value == nil {
			continue
		}
		key := strings.TrimLeft(strings.TrimSpace(*value), "/")
		if key == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, key)
	}
	return result
}

func mediaKeyFromProxyURL(value *string) *string {
	if value == nil {
		return nil
	}
	raw := strings.TrimSpace(*value)
	if raw == "" {
		return nil
	}
	pathname := raw
	if parsed, err := url.Parse(raw); err == nil && parsed.Path != "" {
		pathname = parsed.Path
	}
	for _, prefix := range []string{"/image/", "/storage/"} {
		if strings.HasPrefix(pathname, prefix) {
			key, _ := url.PathUnescape(strings.TrimLeft(pathname[len(prefix):], "/"))
			if strings.TrimSpace(key) == "" {
				return nil
			}
			return &key
		}
	}
	return nil
}

func shareOverlaySVG(photo shareOGPhoto, headline string, title string, appTitle string) string {
	description := truncateText(normalizePhotoDescription(pointerString(photo.Description)), 30)
	descriptionLine := ""
	if description != "" {
		descriptionLine = fmt.Sprintf(`<text x="72" y="234" fill="#d4d4d8" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="30" font-weight="700">%s</text>`, escapeSVG(description))
	}
	city := truncateText(nodeStringOr(photo.City, pointerString(photo.LocationName)), 20)
	camera := truncateText(strings.Join(truthyExifStrings(photo.Exif["Make"], photo.Exif["Model"]), " "), 28)
	exposure := truthyExifString(photo.Exif["ExposureTime"])
	aperture := "—"
	if fNumber := truthyExifString(photo.Exif["FNumber"]); fNumber != "" {
		aperture = "f/" + fNumber
	}
	exposureText := "—"
	if exposure != "" {
		exposureText = exposure + "s"
	}
	return fmt.Sprintf(`<svg width="%d" height="%d" viewBox="0 0 %d %d" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="photoFade" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0%%" stop-color="#09090b" stop-opacity="0.92"/>
      <stop offset="38%%" stop-color="#09090b" stop-opacity="0.72"/>
      <stop offset="100%%" stop-color="#09090b" stop-opacity="0"/>
    </linearGradient>
    <filter id="softShadow" x="-20%%" y="-20%%" width="140%%" height="140%%">
      <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="0" y="0" width="860" height="600" fill="url(#photoFade)"/>
  <g filter="url(#softShadow)">
    <text x="72" y="82" fill="#f43f5e" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="34" font-weight="800" letter-spacing="2">%s · %s</text>
    <text x="72" y="174" fill="#ffffff" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="76" font-weight="900">%s</text>
    %s
    <text x="72" y="308" fill="#d4d4d8" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="28" font-weight="700">%s</text>
    <g transform="translate(72,392)" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="30" font-weight="800">
      <rect x="0" y="0" width="142" height="76" rx="24" fill="#ffffff" opacity="0.10"/>
      <text x="26" y="48" fill="#fbbf24">%s</text>
      <rect x="162" y="0" width="142" height="76" rx="24" fill="#ffffff" opacity="0.10"/>
      <text x="188" y="48" fill="#c084fc">%s</text>
      <rect x="324" y="0" width="156" height="76" rx="24" fill="#ffffff" opacity="0.10"/>
      <text x="350" y="48" fill="#34d399">%s</text>
      <rect x="500" y="0" width="128" height="76" rx="24" fill="#ffffff" opacity="0.10"/>
      <text x="526" y="48" fill="#38bdf8">%s</text>
    </g>
  </g>
</svg>`,
		shareOGWidth, shareOGHeight, shareOGWidth, shareOGHeight,
		escapeSVG(headline), escapeSVG(truncateText(appTitle, 28)),
		escapeSVG(title), descriptionLine,
		escapeSVG(strings.Join(nonEmptyStrings(city, camera), "  ·  ")),
		escapeSVG(truncateText(firstNonEmptyText(truthyExifString(photo.Exif["FocalLengthIn35mmFormat"]), "—"), 8)),
		escapeSVG(truncateText(aperture, 8)),
		escapeSVG(truncateText(exposureText, 10)),
		escapeSVG(truncateText(firstNonEmptyText(truthyExifString(photo.Exif["ISO"]), "—"), 8)),
	)
}

func fallbackShareSVG(headline string, title string, appTitle string) string {
	return fmt.Sprintf(`<svg width="%d" height="%d" viewBox="0 0 %d %d" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%%" stop-color="#18181b"/>
      <stop offset="58%%" stop-color="#09090b"/>
      <stop offset="100%%" stop-color="#020617"/>
    </linearGradient>
    <linearGradient id="photoFade" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0%%" stop-color="#09090b" stop-opacity="0.92"/>
      <stop offset="38%%" stop-color="#09090b" stop-opacity="0.72"/>
      <stop offset="100%%" stop-color="#09090b" stop-opacity="0"/>
    </linearGradient>
    <filter id="softShadow" x="-20%%" y="-20%%" width="140%%" height="140%%">
      <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect width="1200" height="600" fill="url(#bg)"/>
  <circle cx="150" cy="90" r="220" fill="#fb7185" opacity="0.12"/>
  <circle cx="430" cy="560" r="260" fill="#38bdf8" opacity="0.08"/>
  <rect x="0" y="0" width="860" height="600" fill="url(#photoFade)"/>
  <g filter="url(#softShadow)">
    <text x="72" y="82" fill="#f43f5e" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="34" font-weight="800" letter-spacing="2">%s · %s</text>
    <text x="72" y="174" fill="#ffffff" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="76" font-weight="900">%s</text>
    <text x="72" y="308" fill="#d4d4d8" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="28" font-weight="700"></text>
    <g transform="translate(72,392)" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="30" font-weight="800">
      <rect x="0" y="0" width="142" height="76" rx="24" fill="#ffffff" opacity="0.10"/>
      <text x="26" y="48" fill="#fbbf24">—</text>
      <rect x="162" y="0" width="142" height="76" rx="24" fill="#ffffff" opacity="0.10"/>
      <text x="188" y="48" fill="#c084fc">—</text>
      <rect x="324" y="0" width="156" height="76" rx="24" fill="#ffffff" opacity="0.10"/>
      <text x="350" y="48" fill="#34d399">—</text>
      <rect x="500" y="0" width="128" height="76" rx="24" fill="#ffffff" opacity="0.10"/>
      <text x="526" y="48" fill="#38bdf8">—</text>
    </g>
  </g>
</svg>`, shareOGWidth, shareOGHeight, shareOGWidth, shareOGHeight,
		escapeSVG(headline), escapeSVG(truncateText(appTitle, 28)), escapeSVG(title))
}

func fallbackMediaSVG(headline string, title string) string {
	var stripes strings.Builder
	for index := 0; index < 16; index++ {
		fmt.Fprintf(&stripes, `<rect x="%d" y="0" width="24" height="%d" fill="#ffffff"/>`, index*54-12, shareOGHeight)
	}
	return fmt.Sprintf(`<svg width="%d" height="%d" viewBox="0 0 %d %d" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="mediaBg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%%" stop-color="#27272a"/>
      <stop offset="50%%" stop-color="#111827"/>
      <stop offset="100%%" stop-color="#020617"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%%" cy="45%%" r="65%%">
      <stop offset="0%%" stop-color="#f43f5e" stop-opacity="0.42"/>
      <stop offset="52%%" stop-color="#38bdf8" stop-opacity="0.16"/>
      <stop offset="100%%" stop-color="#020617" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="600" fill="url(#mediaBg)"/>
  <rect width="1200" height="600" fill="url(#glow)"/>
  <g opacity="0.22">%s</g>
  <g transform="translate(218 178)" fill="none" stroke="#ffffff" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" opacity="0.82">
    <rect x="0" y="0" width="284" height="190" rx="34"/>
    <path d="M38 132 104 78 162 122 196 94 248 140"/>
    <circle cx="214" cy="58" r="20" fill="#ffffff" stroke="none"/>
  </g>
  <text x="360" y="430" fill="#ffffff" opacity="0.82" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="34" font-weight="900" text-anchor="middle">%s</text>
  <text x="360" y="480" fill="#d4d4d8" opacity="0.82" font-family="Inter, Noto Sans SC, Arial, sans-serif" font-size="28" font-weight="700" text-anchor="middle">%s</text>
</svg>`, shareOGWidth, shareOGHeight, shareOGWidth, shareOGHeight,
		stripes.String(), escapeSVG(headline), escapeSVG(title))
}

func nodeStringOr(primary *string, fallback string) string {
	if primary != nil && *primary != "" {
		return *primary
	}
	return fallback
}

func pointerString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func truthyExifStrings(values ...any) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if text := truthyExifString(value); text != "" {
			result = append(result, text)
		}
	}
	return result
}

func truthyExifString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case bool:
		if !typed {
			return ""
		}
	case float64:
		if typed == 0 {
			return ""
		}
	case json.Number:
		if typed == "0" || typed == "-0" {
			return ""
		}
	case string:
		if typed == "" {
			return ""
		}
	}
	return firstString(value)
}

func ptrText(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func firstNonEmptyText(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func nonEmptyStrings(values ...string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func setCookieVaryHeader(header http.Header) {
	header.Set("Vary", "Cookie")
}

func setPrivateMediaCacheHeaders(header http.Header, cache string) {
	header.Set("Cache-Control", cache)
	setCookieVaryHeader(header)
}

func (a *Application) serveMediaWithContentType(w http.ResponseWriter, r *http.Request, key, fallback, cache string) {
	provider, err := a.mediaProvider(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Storage provider unavailable")
		return
	}
	a.serveMediaWithProviderOptions(w, r, provider, key, fallback, cache, false)
}

func (a *Application) serveMedia(w http.ResponseWriter, r *http.Request, key string) {
	provider, err := a.mediaProvider(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Storage provider unavailable")
		return
	}
	a.serveMediaWithProviderOptions(w, r, provider, key, "", "private, max-age=86400", false)
}

func (a *Application) serveMediaWithProvider(w http.ResponseWriter, r *http.Request, provider *media.Provider, key string, localStorageETag bool) {
	a.serveMediaWithProviderOptions(w, r, provider, key, "", "private, max-age=86400", localStorageETag)
}

var byteRangePattern = regexp.MustCompile(`^bytes=(\d*)-(\d*)$`)

type parsedByteRange struct {
	start int64
	end   int64
}

func parseMediaByteRange(value string, size int64) (parsedByteRange, string, bool) {
	match := byteRangePattern.FindStringSubmatch(value)
	if match == nil || (match[1] == "" && match[2] == "") {
		return parsedByteRange{}, "Invalid range", false
	}
	if size <= 0 {
		return parsedByteRange{}, "Range not satisfiable", false
	}
	if match[1] == "" {
		suffixLength, err := strconv.ParseInt(match[2], 10, 64)
		if err != nil {
			return parsedByteRange{}, "Invalid range", false
		}
		if suffixLength <= 0 {
			return parsedByteRange{}, "Range not satisfiable", false
		}
		start := size - suffixLength
		if start < 0 {
			start = 0
		}
		return parsedByteRange{start: start, end: size - 1}, "", true
	}
	start, err := strconv.ParseInt(match[1], 10, 64)
	if err != nil {
		return parsedByteRange{}, "Invalid range", false
	}
	end := size - 1
	if match[2] != "" {
		end, err = strconv.ParseInt(match[2], 10, 64)
		if err != nil {
			return parsedByteRange{}, "Invalid range", false
		}
	}
	if start >= size || start > end {
		return parsedByteRange{}, "Range not satisfiable", false
	}
	if end >= size {
		end = size - 1
	}
	return parsedByteRange{start: start, end: end}, "", true
}

func ifRangeAllowsRange(value string, currentETag string, lastModified time.Time) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return true
	}
	if strings.HasPrefix(value, `"`) || strings.HasPrefix(value, `W/"`) {
		return currentETag != "" && value == currentETag
	}
	if lastModified.IsZero() {
		return false
	}
	parsed, err := http.ParseTime(value)
	if err != nil {
		return false
	}
	return !lastModified.UTC().Truncate(time.Second).After(parsed.UTC())
}

func ifModifiedSinceNotModified(value string, lastModified time.Time) bool {
	if strings.TrimSpace(value) == "" || lastModified.IsZero() {
		return false
	}
	parsed, err := http.ParseTime(value)
	if err != nil {
		return false
	}
	return !lastModified.UTC().Truncate(time.Second).After(parsed.UTC())
}

func (a *Application) serveMediaWithProviderOptions(w http.ResponseWriter, r *http.Request, provider *media.Provider, key, fallbackContentType, cache string, localStorageETag bool) {
	meta, metaErr := provider.Meta(r.Context(), key)
	metaKnown := metaErr == nil && meta.Size >= 0
	lastModified := time.Time{}
	contentType := fallbackContentType
	if contentType == "" && metaKnown && meta.ContentType != "" {
		contentType = meta.ContentType
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Accept-Ranges", "bytes")
	setPrivateMediaCacheHeaders(w.Header(), cache)
	if metaErr != nil && !errors.Is(metaErr, media.ErrUnsupported) {
		if errors.Is(metaErr, media.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "Photo not found")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "Server Error")
		return
	}
	etag := ""
	if metaKnown {
		if localStorageETag && provider.Kind() == "local" && !meta.LastModified.IsZero() {
			mtimeMilliseconds := float64(meta.LastModified.UnixNano()) / float64(time.Millisecond)
			etag = `W/"` + strconv.FormatInt(meta.Size, 10) + `-` + strconv.FormatFloat(mtimeMilliseconds, 'f', -1, 64) + `"`
		} else {
			etag = `W/"` + strconv.FormatInt(meta.Size, 10) + `-` + url.PathEscape(key) + `"`
		}
		w.Header().Set("ETag", etag)
		if !meta.LastModified.IsZero() {
			lastModified = meta.LastModified.UTC()
			w.Header().Set("Last-Modified", lastModified.Format(http.TimeFormat))
		}
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		if ifModifiedSinceNotModified(r.Header.Get("If-Modified-Since"), lastModified) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	rangeHeader := r.Header.Get("Range")
	if rangeHeader != "" && metaKnown && ifRangeAllowsRange(r.Header.Get("If-Range"), etag, lastModified) {
		parsedRange, message, ok := parseMediaByteRange(rangeHeader, meta.Size)
		if !ok {
			w.Header().Set("Content-Range", "bytes */"+strconv.FormatInt(meta.Size, 10))
			httpx.Error(w, http.StatusRequestedRangeNotSatisfiable, message)
			return
		}
		start, end := parsedRange.start, parsedRange.end
		w.Header().Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(end, 10)+"/"+strconv.FormatInt(meta.Size, 10))
		w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusPartialContent)
			return
		}
		data, _, rangeErr := provider.Range(r.Context(), key, start, end)
		if rangeErr != nil {
			full, objectMeta, err := provider.Get(r.Context(), key)
			if err != nil {
				httpx.Error(w, http.StatusNotFound, "Photo not found")
				return
			}
			if objectMeta.ContentType != "" && fallbackContentType == "" {
				w.Header().Set("Content-Type", objectMeta.ContentType)
			}
			if end >= int64(len(full)) {
				w.Header().Set("Content-Range", "bytes */"+strconv.Itoa(len(full)))
				httpx.Error(w, http.StatusRequestedRangeNotSatisfiable, "Range not satisfiable")
				return
			}
			data = full[start : end+1]
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(data)
		return
	}
	if r.Method == http.MethodHead && metaKnown {
		w.Header().Set("Content-Length", strconv.FormatInt(meta.Size, 10))
		return
	}
	data, objectMeta, err := provider.Get(r.Context(), key)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "Photo not found")
		return
	}
	if objectMeta.ContentType != "" && fallbackContentType == "" {
		w.Header().Set("Content-Type", objectMeta.ContentType)
	}
	if rangeHeader != "" && ifRangeAllowsRange(r.Header.Get("If-Range"), etag, lastModified) {
		parsedRange, message, ok := parseMediaByteRange(rangeHeader, int64(len(data)))
		if !ok {
			w.Header().Set("Content-Range", "bytes */"+strconv.Itoa(len(data)))
			httpx.Error(w, http.StatusRequestedRangeNotSatisfiable, message)
			return
		}
		start, end := parsedRange.start, parsedRange.end
		w.Header().Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(end, 10)+"/"+strconv.Itoa(len(data)))
		w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
		w.WriteHeader(http.StatusPartialContent)
		if r.Method == http.MethodHead {
			return
		}
		_, _ = w.Write(data[start : end+1])
		return
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(data)
}
