package app

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/media"
	"github.com/swzyt/chronoframe/backend/go/internal/queue"
)

type photoImageBuffers struct {
	Raw       []byte
	Processed []byte
	JPEGKey   string
}

type photoImageMetadata struct {
	Width  int64
	Height int64
	Format string
}

type photoInfo struct {
	Title       string
	Description string
	DateTaken   string
	Tags        []string
}

type motionPhotoProcessResult struct {
	IsMotionPhoto     bool
	LivePhotoVideoKey string
	LivePhotoVideoURL string
}

func (a *Application) processPhotoQueueTask(ctx context.Context, task queue.Task) error {
	storageKey := queuePayloadString(task.Payload, "storageKey")
	if strings.TrimSpace(storageKey) == "" {
		return errors.New("photo task is missing storageKey")
	}
	provider, err := a.mediaProvider(ctx)
	if err != nil {
		return fmt.Errorf("load storage provider: %w", err)
	}
	rawImage, storageObject, err := provider.Get(ctx, storageKey)
	if err != nil || len(rawImage) == 0 {
		return errors.New("Storage object not found")
	}
	photoID, err := a.resolvePhotoIDForStorageKey(ctx, storageKey, task.OwnerUserID)
	if err != nil {
		return err
	}

	if err := a.queue.UpdateStage(ctx, task.ID, "preprocessing", task.ClaimTokenValue()); err != nil {
		return err
	}
	imageBuffers, err := a.preprocessPhotoWithJPEGUpload(ctx, provider, storageKey, rawImage)
	if err != nil {
		return err
	}
	contentHash := normalizeContentHash(queuePayloadString(task.Payload, "contentHash"))
	if contentHash == "" {
		contentHash = sha256Hex(imageBuffers.Raw)
	}

	if err := a.queue.UpdateStage(ctx, task.ID, "metadata", task.ClaimTokenValue()); err != nil {
		return err
	}
	imageKey := storageKey
	if imageBuffers.JPEGKey != "" {
		imageKey = imageBuffers.JPEGKey
	}
	metadata, err := identifyPhotoImage(ctx, imageKey, imageBuffers.Processed)
	if err != nil {
		return fmt.Errorf("metadata processing failed: %w", err)
	}
	if metadata.Width <= 0 || metadata.Height <= 0 {
		return fmt.Errorf("metadata processing failed: invalid dimensions %dx%d", metadata.Width, metadata.Height)
	}

	if err := a.queue.UpdateStage(ctx, task.ID, "thumbnail", task.ClaimTokenValue()); err != nil {
		return err
	}
	thumbnailBuffer, err := generatePhotoThumbnail(ctx, imageKey, imageBuffers.Processed)
	if err != nil {
		return fmt.Errorf("generate photo thumbnail: %w", err)
	}
	displayBuffer, err := generateDisplayImage(ctx, imageKey, imageBuffers.Processed)
	if err != nil {
		return fmt.Errorf("generate display image: %w", err)
	}
	thumbnailHash, hashErr := generateThumbHashHex(ctx, thumbnailBuffer)
	if hashErr != nil && a.logger != nil {
		a.logger.WarnContext(ctx, "Generate thumbhash failed", "storage_key", storageKey, "error", hashErr)
	}
	thumbnailKey := fmt.Sprintf("thumbnails/%d/%s.webp", task.OwnerUserID, photoID)
	thumbnailObject, err := provider.Put(ctx, thumbnailKey, bytes.NewReader(thumbnailBuffer), int64(len(thumbnailBuffer)), "image/webp")
	if err != nil {
		return fmt.Errorf("write photo thumbnail %s: %w", thumbnailKey, err)
	}
	if strings.TrimSpace(thumbnailObject.Key) != "" {
		thumbnailKey = thumbnailObject.Key
	}
	displayKey := fmt.Sprintf("display/%d/%s.webp", task.OwnerUserID, photoID)
	displayObject, err := provider.Put(ctx, displayKey, bytes.NewReader(displayBuffer), int64(len(displayBuffer)), "image/webp")
	if err != nil {
		return fmt.Errorf("write photo display %s: %w", displayKey, err)
	}
	if strings.TrimSpace(displayObject.Key) != "" {
		displayKey = displayObject.Key
	}

	if err := a.queue.UpdateStage(ctx, task.ID, "exif", task.ClaimTokenValue()); err != nil {
		return err
	}
	exifData, err := extractPhotoExif(ctx, storageKey, imageBuffers.Raw, imageKey, imageBuffers.Processed, metadata)
	if err != nil {
		if a.logger != nil {
			a.logger.WarnContext(ctx, "EXIF extraction failed", "storage_key", storageKey, "error", err)
		}
		exifData = map[string]any{}
	}
	shouldEraseLocation := a.shouldAutoEraseLocationOnUpload(ctx, task.Payload)
	if shouldEraseLocation {
		exifData = stripLocationExif(exifData)
	}
	info := extractPhotoInfoFromExif(storageKey, exifData, a.now())

	if err := a.queue.UpdateStage(ctx, task.ID, "reverse-geocoding", task.ClaimTokenValue()); err != nil {
		return err
	}
	var latitude any
	var longitude any
	var country any
	var city any
	var locationName any
	latitudeValue, hasLatitude := exifCoordinate(exifData, true)
	longitudeValue, hasLongitude := exifCoordinate(exifData, false)
	if !shouldEraseLocation {
		if hasLatitude && latitudeValue != 0 {
			latitude = latitudeValue
		}
		if hasLongitude && longitudeValue != 0 {
			longitude = longitudeValue
		}
		if hasLatitude && hasLongitude {
			if location := a.extractLocationFromGPS(ctx, latitudeValue, longitudeValue); location != nil {
				country = nilIfEmpty(location.Country)
				city = nilIfEmpty(location.City)
				locationName = nilIfEmpty(location.LocationName)
			}
		}
	}

	if err := a.queue.UpdateStage(ctx, task.ID, "motion-photo", task.ClaimTokenValue()); err != nil {
		return err
	}
	motionPhotoInfo := a.processMotionPhotoFromXMP(ctx, provider, photoID, storageKey, imageBuffers.Raw, exifData, task.OwnerUserID)

	if err := a.queue.UpdateStage(ctx, task.ID, "live-photo", task.ClaimTokenValue()); err != nil {
		return err
	}
	isLivePhoto := int64(0)
	var livePhotoVideoURL any
	var livePhotoVideoKey any
	if motionPhotoInfo != nil && motionPhotoInfo.IsMotionPhoto {
		isLivePhoto = 1
		livePhotoVideoURL = nilIfEmpty(motionPhotoInfo.LivePhotoVideoURL)
		livePhotoVideoKey = nilIfEmpty(motionPhotoInfo.LivePhotoVideoKey)
	} else if key, _, found := a.findLivePhotoVideo(ctx, provider, storageKey); found {
		isLivePhoto = 1
		livePhotoVideoURL = nilIfEmpty(a.publicStorageURL(provider, key))
		livePhotoVideoKey = key
	}

	exifJSON, err := json.Marshal(exifData)
	if err != nil {
		return fmt.Errorf("encode photo EXIF: %w", err)
	}
	tagsJSON, err := json.Marshal(info.Tags)
	if err != nil {
		return fmt.Errorf("encode photo tags: %w", err)
	}
	fileSize := storageObject.Size
	if fileSize <= 0 {
		fileSize = int64(len(rawImage))
	}
	lastModified := storageObject.LastModified
	if lastModified.IsZero() {
		lastModified = a.now()
	}
	originalKey := storageKey
	if imageBuffers.JPEGKey != "" {
		originalKey = imageBuffers.JPEGKey
	}
	var thumbnailHashValue any
	if thumbnailHash != "" {
		thumbnailHashValue = thumbnailHash
	}

	_, err = a.database.SQL().ExecContext(ctx, `
		INSERT INTO photos(
			id, title, description, width, height, aspect_ratio, media_type,
			duration, video_codec, audio_codec, video_playback_key, date_taken,
			storage_key, content_hash, thumbnail_key, display_key, file_size,
			last_modified, original_url, thumbnail_url, thumbnail_hash, tags,
			exif, latitude, longitude, country, city, location_name,
			is_live_photo, live_photo_video_url, live_photo_video_key, owner_user_id
		)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			title = excluded.title,
			description = excluded.description,
			width = excluded.width,
			height = excluded.height,
			aspect_ratio = excluded.aspect_ratio,
			media_type = excluded.media_type,
			duration = excluded.duration,
			video_codec = excluded.video_codec,
			audio_codec = excluded.audio_codec,
			video_playback_key = excluded.video_playback_key,
			date_taken = excluded.date_taken,
			storage_key = excluded.storage_key,
			content_hash = excluded.content_hash,
			thumbnail_key = excluded.thumbnail_key,
			display_key = excluded.display_key,
			file_size = excluded.file_size,
			last_modified = excluded.last_modified,
			original_url = excluded.original_url,
			thumbnail_url = excluded.thumbnail_url,
			thumbnail_hash = excluded.thumbnail_hash,
			tags = excluded.tags,
			exif = excluded.exif,
			latitude = excluded.latitude,
			longitude = excluded.longitude,
			country = excluded.country,
			city = excluded.city,
			location_name = excluded.location_name,
			is_live_photo = excluded.is_live_photo,
			live_photo_video_url = excluded.live_photo_video_url,
			live_photo_video_key = excluded.live_photo_video_key,
			owner_user_id = excluded.owner_user_id
	`, photoID, info.Title, info.Description,
		metadata.Width,
		metadata.Height,
		float64(metadata.Width)/float64(metadata.Height),
		"image",
		nil,
		nil,
		nil,
		nil,
		info.DateTaken,
		storageKey,
		contentHash,
		thumbnailKey,
		displayKey,
		fileSize,
		lastModified.UTC().Format(time.RFC3339Nano),
		storageProxyURL(originalKey),
		storageProxyURL(thumbnailKey),
		thumbnailHashValue,
		string(tagsJSON),
		string(exifJSON),
		latitude,
		longitude,
		country,
		city,
		locationName,
		isLivePhoto,
		livePhotoVideoURL,
		livePhotoVideoKey,
		task.OwnerUserID,
	)
	if err != nil {
		return fmt.Errorf("upsert photo %s: %w", photoID, err)
	}

	if shouldEraseLocation {
		if _, err := a.database.SQL().ExecContext(ctx, `
			INSERT INTO pipeline_queue(payload, priority, attempts, max_attempts, status, created_at, owner_user_id)
			VALUES(?, 2, 0, 3, 'pending', unixepoch(), ?)
		`, `{"type":"photo-erase-location","photoId":`+jsonString(photoID)+`}`, task.OwnerUserID); err != nil && a.logger != nil {
			a.logger.WarnContext(ctx, "failed to enqueue location erase task", "photo_id", photoID, "error", err)
		}
	}
	return nil
}

func (a *Application) preprocessPhotoWithJPEGUpload(
	ctx context.Context,
	provider *media.Provider,
	storageKey string,
	rawImage []byte,
) (photoImageBuffers, error) {
	result := photoImageBuffers{Raw: rawImage, Processed: rawImage}
	if !isHEICImageKey(storageKey) {
		return result, nil
	}
	jpeg, err := convertImageToJPEG(ctx, storageKey, rawImage)
	if err != nil {
		return photoImageBuffers{}, fmt.Errorf("preprocessing failed: %w", err)
	}
	jpegKey := jpegStorageKey(storageKey)
	meta, err := provider.Put(ctx, jpegKey, bytes.NewReader(jpeg), int64(len(jpeg)), "image/jpeg")
	if err != nil {
		return photoImageBuffers{}, fmt.Errorf("write converted JPEG %s: %w", jpegKey, err)
	}
	if strings.TrimSpace(meta.Key) != "" {
		jpegKey = meta.Key
	}
	result.Processed = jpeg
	result.JPEGKey = jpegKey
	return result, nil
}

func identifyPhotoImage(ctx context.Context, key string, source []byte) (photoImageMetadata, error) {
	tempDir, err := os.MkdirTemp("", "chronoframe-identify-*")
	if err != nil {
		return photoImageMetadata{}, err
	}
	defer os.RemoveAll(tempDir)
	inputPath := filepath.Join(tempDir, "source"+path.Ext(key))
	if path.Ext(inputPath) == "" {
		inputPath += ".bin"
	}
	output, err := runImageMagickCommand(ctx, inputPath, source,
		"-auto-orient",
		"-format", "%w %h %[magick]",
		"info:",
	)
	if err != nil {
		return photoImageMetadata{}, err
	}
	fields := strings.Fields(string(output))
	if len(fields) < 2 {
		return photoImageMetadata{}, fmt.Errorf("unexpected identify output %q", strings.TrimSpace(string(output)))
	}
	width, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil {
		return photoImageMetadata{}, err
	}
	height, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil {
		return photoImageMetadata{}, err
	}
	format := ""
	if len(fields) >= 3 {
		format = strings.ToLower(fields[2])
	}
	return photoImageMetadata{Width: width, Height: height, Format: format}, nil
}

func generatePhotoThumbnail(ctx context.Context, key string, source []byte) ([]byte, error) {
	quality := "100"
	if len(source) > 5*1024*1024 {
		quality = "85"
	}
	return runImageMagick(ctx, key, source, ".webp",
		"-auto-orient",
		"-resize", "600x>",
		"-quality", quality,
	)
}

func convertImageToJPEG(ctx context.Context, key string, source []byte) ([]byte, error) {
	quality := "95"
	if len(source) > 10*1024*1024 {
		quality = "80"
	}
	return runImageMagick(ctx, key, source, ".jpg",
		"-auto-orient",
		"-quality", quality,
	)
}

func extractPhotoExif(
	ctx context.Context,
	rawKey string,
	rawImage []byte,
	processedKey string,
	processedImage []byte,
	metadata photoImageMetadata,
) (map[string]any, error) {
	exifData, err := extractExif(ctx, rawKey, rawImage)
	if err != nil && len(processedImage) > 0 {
		exifData, err = extractExif(ctx, processedKey, processedImage)
	}
	if err != nil {
		return nil, err
	}
	if exifData == nil {
		exifData = map[string]any{}
	}
	if _, exists := exifData["ImageWidth"]; !exists && metadata.Width > 0 {
		exifData["ImageWidth"] = metadata.Width
	}
	if _, exists := exifData["ImageHeight"]; !exists && metadata.Height > 0 {
		exifData["ImageHeight"] = metadata.Height
	}
	if _, exists := exifData["ColorSpace"]; !exists {
		if colorSpace := inferPhotoColorSpace(metadata.Format); colorSpace != "" {
			exifData["ColorSpace"] = colorSpace
		}
	}
	return exifData, nil
}

func (a *Application) shouldAutoEraseLocationOnUpload(ctx context.Context, payload any) bool {
	if explicit, ok := queuePayloadBool(payload, "eraseLocation"); ok {
		return explicit
	}
	return a.settingBool(ctx, "privacy", "upload.autoEraseLocation", false)
}

func extractPhotoInfoFromExif(storageKey string, exifData map[string]any, now time.Time) photoInfo {
	fileName := strings.TrimSuffix(path.Base(storageKey), path.Ext(storageKey))
	dateTaken := now.UTC().Format(time.RFC3339Nano)
	if value := firstExifString(exifData, "DateTimeOriginal"); value != "" {
		if parsed := parsePhotoInfoDate(value); !parsed.IsZero() {
			dateTaken = parsed.UTC().Format(time.RFC3339Nano)
		}
	} else if parsed := filenameDate(fileName, time.Time{}); !parsed.IsZero() {
		dateTaken = parsed.UTC().Format(time.RFC3339Nano)
	}

	tags := make([]string, 0)
	seen := map[string]struct{}{}
	addTag := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		if _, exists := seen[value]; exists {
			return
		}
		seen[value] = struct{}{}
		tags = append(tags, value)
	}
	for _, value := range exifStrings(exifData["Subject"]) {
		addTag(value)
	}
	for _, value := range exifStrings(exifData["Keywords"]) {
		addTag(value)
	}
	for _, value := range exifStrings(exifData["XPKeywords"]) {
		for _, part := range strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == ';' }) {
			addTag(part)
		}
	}

	title := firstExifString(exifData, "Title", "XPTitle", "Description", "ImageDescription", "CaptionAbstract")
	cleaned := cleanPhotoTitleFromFileName(fileName)
	if title == "" {
		title = cleaned
	}
	if title == "" {
		title = fileName
	}
	description := normalizePhotoDescription(firstExifString(exifData, "Description", "ImageDescription", "CaptionAbstract", "XPComment", "UserComment"))
	return photoInfo{
		Title:       title,
		Description: description,
		DateTaken:   dateTaken,
		Tags:        tags,
	}
}

func cleanPhotoTitleFromFileName(fileName string) string {
	title := regexpDatePrefix.ReplaceAllString(fileName, "")
	title = regexpViewsSuffix.ReplaceAllString(title, "")
	title = regexpSeparators.ReplaceAllString(title, " ")
	return strings.TrimSpace(title)
}

func parsePhotoInfoDate(value string) time.Time {
	value = strings.TrimSpace(value)
	if value != "" && len(value) >= len("2006:01:02") && value[4] == ':' && value[7] == ':' {
		value = value[:4] + "-" + value[5:7] + "-" + value[8:]
	}
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02 15:04:05",
		"2006-01-02 15:04:05-07:00",
		"2006-01-02 15:04:05Z07:00",
		"2006-01-02",
	} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed
		}
	}
	return time.Time{}
}

func isHEICImageKey(key string) bool {
	switch strings.ToLower(path.Ext(key)) {
	case ".heic", ".heif", ".hif":
		return true
	default:
		return false
	}
}

func jpegStorageKey(storageKey string) string {
	ext := path.Ext(storageKey)
	base := strings.TrimSuffix(path.Base(storageKey), ext)
	dir := path.Dir(storageKey)
	if dir == "." || dir == "/" {
		return base + ".jpeg"
	}
	return path.Join(dir, base+".jpeg")
}

func inferPhotoColorSpace(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "jpeg", "jpg", "png", "webp", "tiff", "tif", "avif", "gif", "bmp":
		return "sRGB"
	case "heif", "heic", "hif":
		return "Display P3"
	default:
		return ""
	}
}

func normalizePhotoDescription(value string) string {
	text := strings.TrimSpace(value)
	if text == "" || isMachineGeneratedDescription(text) {
		return ""
	}
	return text
}

func isMachineGeneratedDescription(value string) bool {
	text := strings.TrimSpace(value)
	if text == "" || !(strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[")) {
		return false
	}
	var parsed any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return false
	}
	return hasMachineMetadataShape(parsed)
}

func hasMachineMetadataShape(value any) bool {
	object, ok := value.(map[string]any)
	if !ok || len(object) == 0 {
		return false
	}
	for key := range object {
		if _, exists := machineMetadataKeys[key]; exists {
			return true
		}
	}
	for key, item := range object {
		if !strings.HasSuffix(key, "Info") {
			return false
		}
		if _, ok := item.(map[string]any); !ok {
			return false
		}
	}
	return true
}

func (a *Application) resolvePhotoIDForStorageKey(ctx context.Context, storageKey string, ownerUserID int64) (string, error) {
	legacyID := generateSafePhotoID(storageKey)
	var existingStorageKey sql.NullString
	var existingOwnerUserID int64
	err := a.database.SQL().QueryRowContext(ctx,
		"SELECT storage_key, owner_user_id FROM photos WHERE id = ?",
		legacyID,
	).Scan(&existingStorageKey, &existingOwnerUserID)
	if errors.Is(err, sql.ErrNoRows) {
		return legacyID, nil
	}
	if err != nil {
		return "", fmt.Errorf("resolve photo id %s: %w", legacyID, err)
	}
	if existingOwnerUserID == ownerUserID && existingStorageKey.Valid && existingStorageKey.String == storageKey {
		return legacyID, nil
	}
	return generateSafePhotoIDWithStorageHash(storageKey), nil
}

func generateSafePhotoIDWithStorageHash(storageKey string) string {
	baseID := generateSafePhotoID(storageKey)
	ownerScopedHash := sha256Hex([]byte(storageKey))[:8]
	return sanitizeFileName(baseID+"-"+ownerScopedHash, 50, "photo", 3)
}

func queuePayloadBool(payload any, key string) (bool, bool) {
	object, ok := payload.(map[string]any)
	if !ok {
		return false, false
	}
	value, exists := object[key]
	if !exists || value == nil {
		return false, false
	}
	boolean, ok := value.(bool)
	return boolean, ok
}

func jsonString(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

var (
	regexpDatePrefix    = mustCompile(`\d{4}-\d{2}-\d{2}[_-]?`)
	regexpViewsSuffix   = mustCompile(`(?i)[_-]?\d+views?`)
	regexpSeparators    = mustCompile(`[_-]+`)
	machineMetadataKeys = map[string]struct{}{
		"ARInfo":       {},
		"BeautyInfo":   {},
		"FaceliftInfo": {},
		"FilterInfo":   {},
		"HandlerInfo":  {},
		"MakeupInfo":   {},
	}
)

const (
	maxXMPScanBytes       = 512 * 1024
	minMotionVideoBytes   = 8 * 1024
	motionPhotoTargetMIME = "video/mp4"
)

func mustCompile(pattern string) *regexp.Regexp {
	return regexp.MustCompile(pattern)
}

func (a *Application) processMotionPhotoFromXMP(
	ctx context.Context,
	provider *media.Provider,
	photoID string,
	storageKey string,
	rawImageBuffer []byte,
	exifData map[string]any,
	ownerUserID int64,
) *motionPhotoProcessResult {
	videoBuffer, offset, ok := extractMotionPhotoVideoBuffer(rawImageBuffer, exifData)
	if !ok {
		return nil
	}
	targetKey := fmt.Sprintf("live-photos/%d/%s.mp4", ownerUserID, photoID)
	if ownerUserID <= 0 {
		targetKey = fmt.Sprintf("live-photos/%s.mp4", photoID)
	}
	storedObject, err := provider.Put(ctx, targetKey, bytes.NewReader(videoBuffer), int64(len(videoBuffer)), motionPhotoTargetMIME)
	if err != nil {
		if a.logger != nil {
			a.logger.ErrorContext(ctx, "Failed to persist Motion Photo video", "storage_key", storageKey, "photo_id", photoID, "error", err)
		}
		return nil
	}
	livePhotoVideoKey := targetKey
	if strings.TrimSpace(storedObject.Key) != "" {
		livePhotoVideoKey = storedObject.Key
	}
	if a.logger != nil {
		a.logger.InfoContext(ctx, "Extracted Motion Photo video", "storage_key", storageKey, "photo_id", photoID, "offset", offset, "live_photo_video_key", livePhotoVideoKey)
	}
	return &motionPhotoProcessResult{
		IsMotionPhoto:     true,
		LivePhotoVideoKey: livePhotoVideoKey,
		LivePhotoVideoURL: a.publicStorageURL(provider, livePhotoVideoKey),
	}
}

func extractMotionPhotoVideoBuffer(rawImageBuffer []byte, exifData map[string]any) ([]byte, int, bool) {
	if len(rawImageBuffer) == 0 {
		return nil, 0, false
	}
	rawLength := len(rawImageBuffer)
	detectedMotion := exifBoolean(exifData["MotionPhoto"]) || exifBoolean(exifData["MicroVideo"])

	offsetCandidates := make([]int, 0, 4)
	seenOffsets := map[int]struct{}{}
	addOffsetCandidate := func(value any) {
		offset, ok := exifInt(value)
		if !ok || offset <= 0 {
			return
		}
		if _, exists := seenOffsets[offset]; exists {
			return
		}
		seenOffsets[offset] = struct{}{}
		offsetCandidates = append(offsetCandidates, offset)
	}
	addOffsetCandidate(exifData["MicroVideoOffset"])

	xmpSegment := extractXMPSegment(rawImageBuffer)
	if xmpSegment != "" {
		if !detectedMotion {
			for _, flag := range []bool{
				extractXMPBoolean(xmpSegment, "MotionPhoto"),
				extractXMPBoolean(xmpSegment, "GCamera:MotionPhoto"),
				extractXMPBoolean(xmpSegment, "MicroVideo"),
				extractXMPBoolean(xmpSegment, "GCamera:MicroVideo"),
				extractXMPAttributeBoolean(xmpSegment, "MotionPhoto"),
				extractXMPAttributeBoolean(xmpSegment, "GCamera:MotionPhoto"),
				extractXMPAttributeBoolean(xmpSegment, "MicroVideo"),
				extractXMPAttributeBoolean(xmpSegment, "GCamera:MicroVideo"),
			} {
				if flag {
					detectedMotion = true
					break
				}
			}
		}
		addOffsetCandidate(extractXMPNumber(xmpSegment, "MicroVideoOffset"))
		addOffsetCandidate(extractXMPNumber(xmpSegment, "GCamera:MicroVideoOffset"))
		addOffsetCandidate(extractXMPAttributeNumber(xmpSegment, "MicroVideoOffset"))
		addOffsetCandidate(extractXMPAttributeNumber(xmpSegment, "GCamera:MicroVideoOffset"))

		videoItems := extractMotionPhotoContainerItems(xmpSegment)
		if len(videoItems) > 0 {
			detectedMotion = true
			item := videoItems[len(videoItems)-1]
			padding := item.Padding
			if item.Length > 0 && item.Length < rawLength {
				addOffsetCandidate(rawLength - item.Length - padding)
				addOffsetCandidate(rawLength - item.Length)
			}
		}
	}

	if !detectedMotion && len(offsetCandidates) == 0 {
		return nil, 0, false
	}
	for _, candidate := range offsetCandidates {
		possibleStarts := []int{candidate}
		if candidate < rawLength {
			possibleStarts = append(possibleStarts, rawLength-candidate)
		}
		for _, start := range possibleStarts {
			if start <= 0 || start >= rawLength-minMotionVideoBytes {
				continue
			}
			chunk := rawImageBuffer[start:]
			if validateMotionMP4Buffer(chunk) {
				return chunk, start, true
			}
		}
	}

	cursor := bytes.Index(rawImageBuffer, []byte("ftyp"))
	for cursor != -1 {
		potentialStart := cursor - 4
		if potentialStart > 0 && potentialStart < rawLength-minMotionVideoBytes {
			chunk := rawImageBuffer[potentialStart:]
			if validateMotionMP4Buffer(chunk) {
				return chunk, potentialStart, true
			}
		}
		next := bytes.Index(rawImageBuffer[cursor+1:], []byte("ftyp"))
		if next == -1 {
			break
		}
		cursor += next + 1
	}
	return nil, 0, false
}

type motionPhotoContainerItem struct {
	Semantic string
	MIME     string
	Length   int
	Padding  int
}

func extractMotionPhotoContainerItems(xmp string) []motionPhotoContainerItem {
	items := make([]motionPhotoContainerItem, 0)
	itemRegex := regexp.MustCompile(`(?is)<(?:[\w-]+:)?Item\b([^>]*)/?>`)
	for _, match := range itemRegex.FindAllStringSubmatch(xmp, -1) {
		if len(match) < 2 {
			continue
		}
		attrs := match[1]
		item := motionPhotoContainerItem{
			Semantic: firstNonEmptyString(
				extractXMPAttributeString(attrs, "Semantic"),
				extractXMPAttributeString(attrs, "Item:Semantic"),
			),
			MIME: firstNonEmptyString(
				extractXMPAttributeString(attrs, "Mime"),
				extractXMPAttributeString(attrs, "Item:Mime"),
			),
			Length: firstNonZeroInt(
				extractXMPAttributeNumber(attrs, "Length"),
				extractXMPAttributeNumber(attrs, "Item:Length"),
			),
			Padding: firstNonZeroInt(
				extractXMPAttributeNumber(attrs, "Padding"),
				extractXMPAttributeNumber(attrs, "Item:Padding"),
			),
		}
		semantic := strings.ToLower(item.Semantic)
		mime := strings.ToLower(item.MIME)
		if strings.Contains(semantic, "motionphoto") || strings.HasPrefix(mime, "video/") {
			items = append(items, item)
		}
	}
	return items
}

func extractXMPSegment(buffer []byte) string {
	scanSize := min(len(buffer), maxXMPScanBytes)
	if scanSize == 0 {
		return ""
	}
	header := string(buffer[:scanSize])
	start := strings.Index(header, "<x:xmpmeta")
	if start == -1 {
		return ""
	}
	end := strings.Index(header, "</x:xmpmeta>")
	if end == -1 || end < start {
		return ""
	}
	return header[start : end+len("</x:xmpmeta>")]
}

func extractXMPBoolean(xmp string, tagName string) bool {
	regex := regexp.MustCompile(`(?is)<[^:>]*:` + regexp.QuoteMeta(tagName) + `>([^<]+)</[^>]+>`)
	match := regex.FindStringSubmatch(xmp)
	if len(match) < 2 {
		return false
	}
	return exifBoolean(match[1])
}

func extractXMPNumber(xmp string, tagName string) int {
	regex := regexp.MustCompile(`(?is)<[^:>]*:` + regexp.QuoteMeta(tagName) + `>([^<]+)</[^>]+>`)
	match := regex.FindStringSubmatch(xmp)
	if len(match) < 2 {
		return 0
	}
	value, _ := exifInt(match[1])
	return value
}

func extractXMPAttributeBoolean(xmp string, attrName string) bool {
	value := extractXMPAttributeString(xmp, attrName)
	if value == "" {
		return false
	}
	return exifBoolean(value)
}

func extractXMPAttributeNumber(xmp string, attrName string) int {
	value := extractXMPAttributeString(xmp, attrName)
	if value == "" {
		return 0
	}
	number, _ := exifInt(value)
	return number
}

func extractXMPAttributeString(xmp string, attrName string) string {
	regex := regexp.MustCompile(`(?is)` + buildXMPAttributePattern(attrName) + `="([^"]+)"`)
	match := regex.FindStringSubmatch(xmp)
	if len(match) < 2 {
		return ""
	}
	return match[1]
}

func buildXMPAttributePattern(attrName string) string {
	escaped := regexp.QuoteMeta(attrName)
	if strings.Contains(attrName, ":") {
		return escaped
	}
	return `(?:[\w-]+:)?` + escaped
}

func validateMotionMP4Buffer(buffer []byte) bool {
	if len(buffer) < minMotionVideoBytes {
		return false
	}
	searchWindow := buffer
	if len(searchWindow) > 32 {
		searchWindow = searchWindow[:32]
	}
	return bytes.Contains(searchWindow, []byte("ftyp"))
}

func firstNonZeroInt(values ...int) int {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func exifInt(value any) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case int64:
		return int(typed), true
	case float64:
		if typed == float64(int(typed)) {
			return int(typed), true
		}
	case json.Number:
		number, err := typed.Int64()
		if err == nil {
			return int(number), true
		}
	case string:
		number, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		if err == nil {
			return int(number), true
		}
	}
	return 0, false
}

func motionPhotoMaybePresent(rawImageBuffer []byte, exifData map[string]any) bool {
	_, _, ok := extractMotionPhotoVideoBuffer(rawImageBuffer, exifData)
	return ok
}

func motionPhotoMaybePresentByMetadata(rawImageBuffer []byte, exifData map[string]any) bool {
	if len(rawImageBuffer) == 0 {
		return false
	}
	return exifBoolean(exifData["MotionPhoto"]) || exifBoolean(exifData["MicroVideo"])
}

func exifBoolean(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case int:
		return typed != 0
	case int64:
		return typed != 0
	case float64:
		return typed != 0
	case json.Number:
		number, err := typed.Float64()
		return err == nil && number != 0
	case string:
		normalized := strings.ToLower(strings.TrimSpace(typed))
		return normalized == "1" || normalized == "true" || normalized == "yes"
	default:
		return false
	}
}
