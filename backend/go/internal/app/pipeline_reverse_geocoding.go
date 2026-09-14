package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/swzyt/chronoframe/backend/go/internal/queue"
)

func (a *Application) processPhotoReverseGeocodingQueueTask(ctx context.Context, task queue.Task) error {
	photoID := queuePayloadString(task.Payload, "photoId")
	if strings.TrimSpace(photoID) == "" {
		return errors.New("photo-reverse-geocoding task is missing photoId")
	}
	if err := a.queue.UpdateStage(ctx, task.ID, "reverse-geocoding", task.ClaimTokenValue()); err != nil {
		return err
	}

	var (
		photoLatitude  sql.NullFloat64
		photoLongitude sql.NullFloat64
		photoExif      sql.NullString
	)
	err := a.database.SQL().QueryRowContext(ctx, `
		SELECT latitude, longitude, exif
		FROM photos
		WHERE id = ?
	`, photoID).Scan(&photoLatitude, &photoLongitude, &photoExif)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("Photo %s not found", photoID)
	}
	if err != nil {
		return fmt.Errorf("load photo %s: %w", photoID, err)
	}

	latitude, hasLatitude := queuePayloadFloat(task.Payload, "latitude")
	longitude, hasLongitude := queuePayloadFloat(task.Payload, "longitude")
	if !hasLatitude && photoLatitude.Valid {
		latitude = photoLatitude.Float64
		hasLatitude = true
	}
	if !hasLongitude && photoLongitude.Valid {
		longitude = photoLongitude.Float64
		hasLongitude = true
	}
	if (!hasLatitude || !hasLongitude) && photoExif.Valid {
		exif := decodeQueuePhotoExif(photoExif.String)
		if !hasLatitude {
			if value, ok := exifCoordinate(exif, true); ok {
				latitude = value
				hasLatitude = true
			}
		}
		if !hasLongitude {
			if value, ok := exifCoordinate(exif, false); ok {
				longitude = value
				hasLongitude = true
			}
		}
	}

	if !hasLatitude || !hasLongitude {
		if _, err := a.database.SQL().ExecContext(ctx, `
			UPDATE photos
			SET latitude = NULL, longitude = NULL, country = NULL, city = NULL,
			    location_name = NULL
			WHERE id = ?
		`, photoID); err != nil {
			return fmt.Errorf("clear missing photo location %s: %w", photoID, err)
		}
		return fmt.Errorf("Missing coordinates for photo %s", photoID)
	}

	location := a.extractLocationFromGPS(ctx, latitude, longitude)
	if location == nil {
		return fmt.Errorf("Failed to extract location from GPS coordinates (%s, %s), maybe network issue?",
			formatGeocodingFloat(latitude),
			formatGeocodingFloat(longitude),
		)
	}

	if _, err := a.database.SQL().ExecContext(ctx, `
		UPDATE photos
		SET latitude = ?, longitude = ?, country = ?, city = ?, location_name = ?
		WHERE id = ?
	`, latitude, longitude, nilIfEmpty(location.Country), nilIfEmpty(location.City), nilIfEmpty(location.LocationName), photoID); err != nil {
		return fmt.Errorf("update reverse-geocoded photo %s: %w", photoID, err)
	}
	return nil
}

func decodeQueuePhotoExif(value string) map[string]any {
	var exif map[string]any
	decoder := json.NewDecoder(strings.NewReader(value))
	decoder.UseNumber()
	if err := decoder.Decode(&exif); err != nil {
		return nil
	}
	return exif
}

func queuePayloadFloat(payload any, key string) (float64, bool) {
	object, ok := payload.(map[string]any)
	if !ok {
		return 0, false
	}
	value, exists := object[key]
	if !exists || value == nil {
		return 0, false
	}
	var parsed float64
	switch typed := value.(type) {
	case float64:
		parsed = typed
	case float32:
		parsed = float64(typed)
	case int:
		parsed = float64(typed)
	case int64:
		parsed = float64(typed)
	case json.Number:
		number, err := typed.Float64()
		if err != nil {
			return 0, false
		}
		parsed = number
	case string:
		number, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil {
			return 0, false
		}
		parsed = number
	default:
		return 0, false
	}
	if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}

func nilIfEmpty(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}
