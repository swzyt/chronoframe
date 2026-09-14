package app

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/queue"
)

var contentHashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type processedVideo struct {
	Width           int64
	Height          int64
	Duration        float64
	VideoCodec      string
	AudioCodec      *string
	PlaybackBuffer  []byte
	ThumbnailBuffer []byte
	Exif            map[string]any
	DateTaken       string
}

type ffprobeResult struct {
	Streams []ffprobeStream `json:"streams"`
	Format  ffprobeFormat   `json:"format"`
}

type ffprobeStream struct {
	CodecType string            `json:"codec_type"`
	CodecName string            `json:"codec_name"`
	Width     int64             `json:"width"`
	Height    int64             `json:"height"`
	Tags      map[string]string `json:"tags"`
}

type ffprobeFormat struct {
	Duration string            `json:"duration"`
	Tags     map[string]string `json:"tags"`
}

func (a *Application) processVideoQueueTask(ctx context.Context, task queue.Task) error {
	storageKey := queuePayloadString(task.Payload, "storageKey")
	if strings.TrimSpace(storageKey) == "" {
		return errors.New("video task is missing storageKey")
	}
	provider, err := a.mediaProvider(ctx)
	if err != nil {
		return fmt.Errorf("load storage provider: %w", err)
	}
	videoBuffer, storageObject, err := provider.Get(ctx, storageKey)
	if err != nil || len(videoBuffer) == 0 {
		return errors.New("Storage object not found")
	}
	contentHash := normalizeContentHash(queuePayloadString(task.Payload, "contentHash"))
	if contentHash == "" {
		contentHash = sha256Hex(videoBuffer)
	}

	if err := a.queue.UpdateStage(ctx, task.ID, "metadata", task.ClaimTokenValue()); err != nil {
		return err
	}
	processed, err := processMP4Video(ctx, videoBuffer)
	if err != nil {
		return err
	}
	videoExif := processed.Exif
	if exifData, err := extractExif(ctx, storageKey, videoBuffer); err == nil && len(exifData) > 0 {
		videoExif = exifData
	}

	if err := a.queue.UpdateStage(ctx, task.ID, "thumbnail", task.ClaimTokenValue()); err != nil {
		return err
	}
	thumbnailQuality := "100"
	if len(processed.ThumbnailBuffer) > 5*1024*1024 {
		thumbnailQuality = "85"
	}
	thumbnailBuffer, err := generateWebPThumbnail(ctx, processed.ThumbnailBuffer, thumbnailQuality)
	if err != nil {
		return fmt.Errorf("generate video thumbnail: %w", err)
	}
	thumbnailHash, hashErr := generateThumbHashHex(ctx, thumbnailBuffer)
	if hashErr != nil && a.logger != nil {
		a.logger.WarnContext(ctx, "Generate video thumbhash failed", "storage_key", storageKey, "error", hashErr)
	}
	videoID := generateSafeVideoID(storageKey)
	var videoPlaybackKey any
	if len(processed.PlaybackBuffer) > 0 {
		key := fmt.Sprintf("videos/%d/%s-playback.mp4", task.OwnerUserID, videoID)
		if _, err := provider.Put(ctx, key, bytes.NewReader(processed.PlaybackBuffer), int64(len(processed.PlaybackBuffer)), "video/mp4"); err != nil {
			return fmt.Errorf("write playback video %s: %w", key, err)
		}
		videoPlaybackKey = key
	}
	thumbnailKey := fmt.Sprintf("thumbnails/%d/%s.webp", task.OwnerUserID, videoID)
	if _, err := provider.Put(ctx, thumbnailKey, bytes.NewReader(thumbnailBuffer), int64(len(thumbnailBuffer)), "image/webp"); err != nil {
		return fmt.Errorf("write video thumbnail %s: %w", thumbnailKey, err)
	}

	if err := a.queue.UpdateStage(ctx, task.ID, "reverse-geocoding", task.ClaimTokenValue()); err != nil {
		return err
	}
	var latitude any
	var longitude any
	var country any
	var city any
	var locationName any
	latitudeValue, hasLatitude := exifCoordinate(videoExif, true)
	longitudeValue, hasLongitude := exifCoordinate(videoExif, false)
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

	exifJSON, err := json.Marshal(videoExif)
	if err != nil {
		return fmt.Errorf("encode video EXIF: %w", err)
	}
	tagsJSON := "[]"
	var thumbnailHashValue any
	if thumbnailHash != "" {
		thumbnailHashValue = thumbnailHash
	}
	originalURLKey := storageKey
	if playbackKey, ok := videoPlaybackKey.(string); ok && playbackKey != "" {
		originalURLKey = playbackKey
	}
	fileSize := storageObject.Size
	if fileSize <= 0 {
		fileSize = int64(len(videoBuffer))
	}
	lastModified := storageObject.LastModified
	if lastModified.IsZero() {
		lastModified = a.now()
	}
	title := path.Base(strings.TrimSuffix(storageKey, path.Ext(storageKey)))
	aspectRatio := float64(processed.Width) / float64(processed.Height)

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
	`, videoID, title, "",
		processed.Width,
		processed.Height,
		aspectRatio,
		"video",
		processed.Duration,
		processed.VideoCodec,
		processed.AudioCodec,
		videoPlaybackKey,
		processed.DateTaken,
		storageKey,
		contentHash,
		thumbnailKey,
		nil,
		fileSize,
		lastModified.UTC().Format(time.RFC3339Nano),
		storageProxyURL(originalURLKey),
		storageProxyURL(thumbnailKey),
		thumbnailHashValue,
		tagsJSON,
		string(exifJSON),
		latitude,
		longitude,
		country,
		city,
		locationName,
		0,
		nil,
		nil,
		task.OwnerUserID,
	)
	if err != nil {
		return fmt.Errorf("upsert video photo %s: %w", videoID, err)
	}
	return nil
}

func processMP4Video(ctx context.Context, input []byte) (processedVideo, error) {
	if len(input) == 0 {
		return processedVideo{}, errors.New("empty video file")
	}
	tempDir, err := os.MkdirTemp("", "chronoframe-video-*")
	if err != nil {
		return processedVideo{}, err
	}
	defer os.RemoveAll(tempDir)

	inputPath := filepath.Join(tempDir, "input.mp4")
	thumbnailPath := filepath.Join(tempDir, "thumbnail.webp")
	playbackPath := filepath.Join(tempDir, "playback.mp4")
	if err := os.WriteFile(inputPath, input, 0o600); err != nil {
		return processedVideo{}, err
	}

	ffprobePath := strings.TrimSpace(os.Getenv("FFPROBE_PATH"))
	if ffprobePath == "" {
		ffprobePath = "/usr/bin/ffprobe"
	}
	stdout, err := runMediaTool(ctx, ffprobePath,
		"-v", "error",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		inputPath,
	)
	if err != nil {
		return processedVideo{}, err
	}
	var probe ffprobeResult
	if err := json.Unmarshal(stdout, &probe); err != nil {
		return processedVideo{}, fmt.Errorf("decode ffprobe output: %w", err)
	}
	var videoStream *ffprobeStream
	var audioStream *ffprobeStream
	for index := range probe.Streams {
		stream := &probe.Streams[index]
		switch stream.CodecType {
		case "video":
			if videoStream == nil {
				videoStream = stream
			}
		case "audio":
			if audioStream == nil {
				audioStream = stream
			}
		}
	}
	if videoStream == nil || videoStream.Width <= 0 || videoStream.Height <= 0 {
		return processedVideo{}, errors.New("MP4 does not contain a valid video stream")
	}
	if !isSupportedMP4VideoCodec(videoStream.CodecName) {
		codec := videoStream.CodecName
		if codec == "" {
			codec = "unknown"
		}
		return processedVideo{}, fmt.Errorf("Unsupported MP4 video codec: %s. H.264 or HEVC is required.", codec)
	}

	ffmpegPath := strings.TrimSpace(os.Getenv("FFMPEG_PATH"))
	if ffmpegPath == "" {
		ffmpegPath = "/usr/bin/ffmpeg"
	}
	requiresVideoTranscode := videoStream.CodecName != "h264"
	requiresAudioTranscode := audioStream != nil && audioStream.CodecName != "aac" && audioStream.CodecName != "mp3"
	var playbackBuffer []byte
	if requiresVideoTranscode || requiresAudioTranscode {
		args := []string{"-v", "error", "-i", inputPath}
		if requiresVideoTranscode {
			args = append(args, "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p")
		} else {
			args = append(args, "-c:v", "copy")
		}
		if audioStream != nil {
			if requiresAudioTranscode {
				args = append(args, "-c:a", "aac", "-b:a", "192k")
			} else {
				args = append(args, "-c:a", "copy")
			}
		} else {
			args = append(args, "-an")
		}
		args = append(args, "-movflags", "+faststart", "-y", playbackPath)
		if _, err := runMediaTool(ctx, ffmpegPath, args...); err != nil {
			return processedVideo{}, err
		}
		playbackBuffer, err = os.ReadFile(playbackPath)
		if err != nil {
			return processedVideo{}, err
		}
	}

	duration, _ := strconv.ParseFloat(strings.TrimSpace(probe.Format.Duration), 64)
	if math.IsNaN(duration) || math.IsInf(duration, 0) {
		duration = 0
	}
	seekTime := float64(0)
	if duration > 2 {
		seekTime = math.Min(1, duration*0.1)
	}
	if _, err := runMediaTool(ctx, ffmpegPath,
		"-v", "error",
		"-ss", strconv.FormatFloat(seekTime, 'f', -1, 64),
		"-i", inputPath,
		"-frames:v", "1",
		"-vf", "scale='min(1200,iw)':-2",
		"-c:v", "libwebp",
		"-quality", "82",
		"-y", thumbnailPath,
	); err != nil {
		return processedVideo{}, err
	}
	thumbnailBuffer, err := os.ReadFile(thumbnailPath)
	if err != nil {
		return processedVideo{}, err
	}

	rawExif, err := extractExifFromFile(ctx, inputPath)
	if err != nil {
		return processedVideo{}, err
	}
	creationTime := firstNonEmptyString(
		videoStream.Tags["creation_time"],
		probe.Format.Tags["creation_time"],
		firstExifString(rawExif, "CreateDate", "DateTimeOriginal"),
	)
	audioCodec := (*string)(nil)
	if audioStream != nil && strings.TrimSpace(audioStream.CodecName) != "" {
		codec := audioStream.CodecName
		audioCodec = &codec
	}

	return processedVideo{
		Width:           videoStream.Width,
		Height:          videoStream.Height,
		Duration:        duration,
		VideoCodec:      videoStream.CodecName,
		AudioCodec:      audioCodec,
		PlaybackBuffer:  playbackBuffer,
		ThumbnailBuffer: thumbnailBuffer,
		Exif:            rawExif,
		DateTaken:       parseVideoDate(creationTime, time.Now()),
	}, nil
}

func runMediaTool(ctx context.Context, binary string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, binary, args...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if errors.Is(err, exec.ErrNotFound) {
			return nil, fmt.Errorf("%s binary is unavailable", path.Base(binary))
		}
		if message != "" {
			return nil, fmt.Errorf("%s: %w: %s", path.Base(binary), err, message)
		}
		return nil, fmt.Errorf("%s: %w", path.Base(binary), err)
	}
	return stdout.Bytes(), nil
}

func extractExifFromFile(ctx context.Context, filePath string) (map[string]any, error) {
	command := exec.CommandContext(ctx, "exiftool", "-j", "-n", "-charset", "filename=utf8", filePath)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		if stderr.Len() > 0 {
			return nil, fmt.Errorf("exiftool: %w: %s", err, strings.TrimSpace(stderr.String()))
		}
		return nil, fmt.Errorf("exiftool: %w", err)
	}
	var documents []map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &documents); err != nil {
		return nil, fmt.Errorf("decode exiftool output: %w", err)
	}
	if len(documents) == 0 {
		return nil, errors.New("exiftool returned no metadata")
	}
	delete(documents[0], "SourceFile")
	return filterNeededExif(documents[0]), nil
}

func isSupportedMP4VideoCodec(codec string) bool {
	switch codec {
	case "h264", "hevc", "h265":
		return true
	default:
		return false
	}
}

func normalizeContentHash(hash string) string {
	normalized := strings.ToLower(strings.TrimSpace(hash))
	if contentHashPattern.MatchString(normalized) {
		return normalized
	}
	return ""
}

func generateSafeVideoID(storageKey string) string {
	baseID := generateSafePhotoID(storageKey)
	ownerScopedHash := sha256Hex([]byte(storageKey))[:8]
	return sanitizeFileName(baseID+"-video-"+ownerScopedHash, 50, "video", 3)
}

func generateSafePhotoID(storageKey string) string {
	baseName := path.Base(strings.TrimSuffix(storageKey, path.Ext(storageKey)))
	return sanitizeFileName(baseName, 32, "photo", 3)
}

func sanitizeFileName(fileName string, maxLength int, fallbackPrefix string, minLength int) string {
	replacer := regexp.MustCompile(`[^\w\-_.]`)
	cleaned := replacer.ReplaceAllString(fileName, "_")
	cleaned = regexp.MustCompile(`_{2,}`).ReplaceAllString(cleaned, "_")
	cleaned = strings.Trim(cleaned, "_")
	if len(cleaned) < minLength {
		hash := md5.Sum([]byte(fileName))
		return fallbackPrefix + "_" + hex.EncodeToString(hash[:])[:8]
	}
	if len(cleaned) > maxLength {
		hash := md5.Sum([]byte(fileName))
		truncateLength := maxLength - 9
		return cleaned[:truncateLength] + "_" + hex.EncodeToString(hash[:])[:8]
	}
	return cleaned
}

func storageProxyURL(key string) string {
	return "/image/" + encodeStorageKey(key)
}

func parseVideoDate(value string, fallback time.Time) string {
	value = strings.TrimSpace(value)
	if value != "" && len(value) >= len("2006:01:02") && value[4] == ':' && value[7] == ':' {
		value = value[:4] + "-" + value[5:7] + "-" + value[8:]
	}
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02 15:04:05",
		"2006-01-02 15:04:05-07:00",
		"2006-01-02 15:04:05Z07:00",
	} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC().Format(time.RFC3339Nano)
		}
	}
	return fallback.UTC().Format(time.RFC3339Nano)
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
