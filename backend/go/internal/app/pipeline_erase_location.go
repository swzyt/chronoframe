package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/queue"
)

var exifLocationKeys = []string{
	"GPSAltitude",
	"GPSAltitudeRef",
	"GPSLatitude",
	"GPSLatitudeRef",
	"GPSLongitude",
	"GPSLongitudeRef",
	"GPSPosition",
	"GPSDateStamp",
	"GPSTimeStamp",
	"GPSImgDirection",
	"GPSImgDirectionRef",
	"GPSDestBearing",
	"GPSDestBearingRef",
}

func (a *Application) processPhotoEraseLocationQueueTask(ctx context.Context, task queue.Task) error {
	photoID := queuePayloadString(task.Payload, "photoId")
	if strings.TrimSpace(photoID) == "" {
		return errors.New("photo-erase-location task is missing photoId")
	}
	if err := a.queue.UpdateStage(ctx, task.ID, "location-erase", task.ClaimTokenValue()); err != nil {
		return err
	}

	var storageKey string
	if err := a.database.SQL().QueryRowContext(ctx,
		"SELECT COALESCE(storage_key, '') FROM photos WHERE id = ?",
		photoID,
	).Scan(&storageKey); err != nil {
		return fmt.Errorf("load photo %s: %w", photoID, err)
	}
	if strings.TrimSpace(storageKey) == "" {
		return fmt.Errorf("photo %s has no storage key", photoID)
	}

	provider, err := a.mediaProvider(ctx)
	if err != nil {
		return fmt.Errorf("load storage provider: %w", err)
	}
	original, meta, err := provider.Get(ctx, storageKey)
	if err != nil {
		return fmt.Errorf("read photo file %s: %w", storageKey, err)
	}
	updated, err := eraseLocationMetadata(ctx, storageKey, original)
	if err != nil {
		return err
	}
	if _, err := provider.Put(ctx, storageKey, bytes.NewReader(updated), int64(len(updated)), meta.ContentType); err != nil {
		return fmt.Errorf("write location-erased photo file %s: %w", storageKey, err)
	}

	exifData, err := extractExif(ctx, storageKey, updated)
	if err != nil {
		return fmt.Errorf("extract updated EXIF: %w", err)
	}
	exifData = stripLocationExif(exifData)
	exifJSON, err := json.Marshal(exifData)
	if err != nil {
		return fmt.Errorf("encode location-erased EXIF: %w", err)
	}

	_, err = a.database.SQL().ExecContext(ctx, `
		UPDATE photos
		SET exif = ?, file_size = ?, last_modified = ?,
		    latitude = NULL, longitude = NULL, country = NULL, city = NULL,
		    location_name = NULL
		WHERE id = ?
	`, string(exifJSON), len(updated), time.Now().UTC().Format(time.RFC3339Nano), photoID)
	if err != nil {
		return fmt.Errorf("update location-erased photo %s: %w", photoID, err)
	}
	return nil
}

func eraseLocationMetadata(ctx context.Context, key string, data []byte) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("empty photo file")
	}
	tempDir, err := os.MkdirTemp("", "chronoframe-location-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tempDir)

	ext := filepath.Ext(key)
	if ext == "" {
		ext = ".jpg"
	}
	tempFile := filepath.Join(tempDir, "erase-location"+ext)
	if err := os.WriteFile(tempFile, data, 0o600); err != nil {
		return nil, err
	}

	command := exec.CommandContext(ctx, "exiftool",
		"-overwrite_original",
		"-gps:all=",
		"-xmp:geotag=",
		tempFile,
	)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		if stderr.Len() > 0 {
			return nil, fmt.Errorf("erase location metadata: %w: %s", err, strings.TrimSpace(stderr.String()))
		}
		return nil, fmt.Errorf("erase location metadata: %w", err)
	}
	updated, err := os.ReadFile(tempFile)
	if err != nil {
		return nil, err
	}
	if len(updated) == 0 {
		return nil, errors.New("location-erased photo is empty")
	}
	return updated, nil
}

func stripLocationExif(exif map[string]any) map[string]any {
	if exif == nil {
		return nil
	}
	cloned := make(map[string]any, len(exif))
	for key, value := range exif {
		cloned[key] = value
	}
	for _, key := range exifLocationKeys {
		delete(cloned, key)
	}
	return cloned
}
