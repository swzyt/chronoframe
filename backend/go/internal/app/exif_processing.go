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
	"regexp"
	"strconv"
	"strings"
	"time"
)

const exiftoolListSeparator = "\x1f"

var photoTitleDatePattern = regexp.MustCompile(`\d{4}-\d{2}-\d{2}[_-]?`)
var photoTitleViewsPattern = regexp.MustCompile(`(?i)[_-]?\d+views?`)
var photoTitleSeparatorPattern = regexp.MustCompile(`[_-]+`)

var neededExifKeys = []string{
	"DateTimeOriginal",
	"DateTimeDigitized",
	"OffsetTime",
	"OffsetTimeOriginal",
	"OffsetTimeDigitized",
	"ImageWidth",
	"ImageHeight",
	"Title",
	"XPTitle",
	"Subject",
	"Keywords",
	"XPKeywords",
	"Description",
	"ImageDescription",
	"Caption-Abstract",
	"XPComment",
	"UserComment",
	"tz",
	"tzSource",
	"Orientation",
	"Make",
	"Model",
	"Software",
	"Artist",
	"Copyright",
	"ExposureTime",
	"FNumber",
	"ExposureProgram",
	"ISO",
	"ShutterSpeedValue",
	"ApertureValue",
	"BrightnessValue",
	"ExposureCompensationSet",
	"ExposureCompensationMode",
	"ExposureCompensationSetting",
	"ExposureCompensation",
	"MaxApertureValue",
	"LightSource",
	"Flash",
	"FocalLength",
	"ColorSpace",
	"ExposureMode",
	"FocalLengthIn35mmFormat",
	"SceneCaptureType",
	"LensMake",
	"LensModel",
	"MeteringMode",
	"WhiteBalance",
	"WBShiftAB",
	"WBShiftGM",
	"WhiteBalanceBias",
	"WhiteBalanceFineTune",
	"FlashMeteringMode",
	"SensingMethod",
	"FocalPlaneXResolution",
	"FocalPlaneYResolution",
	"Aperture",
	"ScaleFactor35efl",
	"ShutterSpeed",
	"LightValue",
	"Rating",
	"GPSAltitude",
	"GPSCoordinates",
	"GPSAltitudeRef",
	"GPSLatitude",
	"GPSLatitudeRef",
	"GPSLongitude",
	"GPSLongitudeRef",
	"MPImageType",
	"MotionPhoto",
	"MotionPhotoVersion",
	"MotionPhotoPresentationTimestampUs",
	"MicroVideo",
	"MicroVideoVersion",
	"MicroVideoOffset",
	"MicroVideoPresentationTimestampUs",
}

func extractExif(ctx context.Context, key string, data []byte) (map[string]any, error) {
	if len(data) == 0 {
		return nil, errors.New("empty media object")
	}
	tempDir, err := os.MkdirTemp("", "chronoframe-exif-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tempDir)

	ext := filepath.Ext(key)
	if ext == "" {
		ext = ".bin"
	}
	filePath := filepath.Join(tempDir, "source"+ext)
	if err := os.WriteFile(filePath, data, 0o600); err != nil {
		return nil, err
	}

	command := exec.CommandContext(ctx, "exiftool",
		"-json", "-fast", "-api", "struct=1", "-use", "MWG", "-api", "keepUTCTime",
		"-*Duration*#", "-GPSAltitude#", "-GPSLatitude#", "-GPSLongitude#",
		"-GPSPosition#", "-GeolocationPosition#", "-Orientation#", "-all", filePath,
	)
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
	result := filterNeededExif(documents[0])
	normalizeExifGPS(result)
	inferExifTimezone(ctx, filePath, result)
	normalizeExifDates(result)
	if metadata, metadataErr := identifyPhotoImage(ctx, key, data); metadataErr == nil {
		if _, exists := result["ImageWidth"]; !exists && metadata.Width > 0 {
			result["ImageWidth"] = metadata.Width
		}
		if _, exists := result["ImageHeight"]; !exists && metadata.Height > 0 {
			result["ImageHeight"] = metadata.Height
		}
		if colorSpace := inferPhotoColorSpace(metadata.Format); colorSpace != "" {
			// The Node implementation gives Sharp's interpretation precedence
			// over ExifTool's numeric ColorSpace tag.
			result["ColorSpace"] = colorSpace
		}
	}
	return result, nil
}

func rewriteExifMetadata(ctx context.Context, key string, data []byte, updates map[string]any) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("empty media object")
	}
	tempDir, err := os.MkdirTemp("", "chronoframe-edit-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tempDir)

	ext := filepath.Ext(key)
	if ext == "" {
		ext = ".jpg"
	}
	filePath := filepath.Join(tempDir, "edited"+ext)
	if err := os.WriteFile(filePath, data, 0o600); err != nil {
		return nil, err
	}

	if len(updates) > 0 {
		// Match exiftool-vendored's WriteTask arguments on Linux. In
		// particular, MWG mode and its list separator affect which metadata
		// groups are written and therefore the subsequently extracted values.
		args := []string{"-sep", exiftoolListSeparator, "-E", "-api", "struct=1", "-use", "MWG"}
		args = append(args, exiftoolWriteArgs(updates)...)
		args = append(args, "-overwrite_original", filePath)
		command := exec.CommandContext(ctx, "exiftool", args...)
		var stderr bytes.Buffer
		command.Stderr = &stderr
		if err := command.Run(); err != nil {
			if stderr.Len() > 0 {
				return nil, fmt.Errorf("write EXIF: %w: %s", err, strings.TrimSpace(stderr.String()))
			}
			return nil, fmt.Errorf("write EXIF: %w", err)
		}
	}

	updated, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}
	if len(updated) == 0 {
		return nil, errors.New("updated media object is empty")
	}
	return updated, nil
}

func exiftoolWriteArgs(updates map[string]any) []string {
	order := []string{
		"Title",
		"XPTitle",
		"Description",
		"ImageDescription",
		"CaptionAbstract",
		"XPComment",
		"UserComment",
		"Subject",
		"Keywords",
		"XPKeywords",
		"GPSLatitude",
		"GPSLatitudeRef",
		"GPSLongitude",
		"GPSLongitudeRef",
		"GPSPosition",
		"Rating",
	}
	args := make([]string, 0, len(order)+8)
	for _, tag := range order {
		value, ok := updates[tag]
		if !ok {
			continue
		}
		args = appendExiftoolArg(args, tag, value)
	}
	return args
}

func appendExiftoolArg(args []string, tag string, value any) []string {
	if value == nil {
		return append(args, "-"+tag+"=")
	}
	switch typed := value.(type) {
	case []string:
		encoded := make([]string, 0, len(typed))
		for _, item := range typed {
			encoded = append(encoded, exiftoolHTMLEncode(item))
		}
		return append(args, "-"+tag+"="+strings.Join(encoded, exiftoolListSeparator))
	case string:
		return append(args, "-"+tag+"="+exiftoolHTMLEncode(typed))
	case int:
		return append(args, "-"+tag+"="+strconv.Itoa(typed))
	case int64:
		return append(args, "-"+tag+"="+strconv.FormatInt(typed, 10))
	case float64:
		return append(args, "-"+tag+"="+strconv.FormatFloat(typed, 'f', -1, 64))
	default:
		return append(args, "-"+tag+"="+fmt.Sprint(typed))
	}
}

func exiftoolHTMLEncode(value string) string {
	var result strings.Builder
	for _, char := range value {
		if char == ' ' || (char >= 0x21 && char <= 0x7e) {
			result.WriteRune(char)
			continue
		}
		result.WriteString("&#")
		result.WriteString(strconv.FormatInt(int64(char), 10))
		result.WriteByte(';')
	}
	return result.String()
}

func normalizeExifDates(exif map[string]any) {
	location := time.UTC
	if timezone := firstExifString(exif, "tz"); timezone != "" {
		if parsed, err := time.LoadLocation(timezone); err == nil {
			location = parsed
		} else if offsetSeconds, ok := parseExifOffset(timezone); ok {
			location = time.FixedZone(timezone, offsetSeconds)
		}
	}
	for _, key := range []string{"DateTimeOriginal", "DateTimeDigitized"} {
		value, exists := exif[key]
		if !exists {
			continue
		}
		if parsed := parseExifTimeInLocation(firstString(value), location); !parsed.IsZero() {
			exif[key] = javascriptDateISOString(parsed)
		}
	}
}

func normalizeExifGPS(exif map[string]any) {
	if latitude, ok := firstExifFloat(exif, "GPSLatitude"); ok {
		exif["GPSLatitude"] = latitude
		if latitude < 0 {
			exif["GPSLatitudeRef"] = "S"
		} else {
			exif["GPSLatitudeRef"] = "N"
		}
	}
	if longitude, ok := firstExifFloat(exif, "GPSLongitude"); ok {
		exif["GPSLongitude"] = longitude
		if longitude < 0 {
			exif["GPSLongitudeRef"] = "W"
		} else {
			exif["GPSLongitudeRef"] = "E"
		}
	}
}

func inferExifTimezone(ctx context.Context, filePath string, exif map[string]any) {
	for _, key := range []string{"OffsetTimeOriginal", "OffsetTimeDigitized", "OffsetTime"} {
		value := firstExifString(exif, key)
		if _, ok := parseExifOffset(value); ok {
			exif["tz"] = value
			exif["tzSource"] = key
			return
		}
	}
	latitude, latitudeOK := firstExifFloat(exif, "GPSLatitude")
	longitude, longitudeOK := firstExifFloat(exif, "GPSLongitude")
	if !latitudeOK || !longitudeOK || (latitude == 0 && longitude == 0) {
		return
	}
	command := exec.CommandContext(ctx, "exiftool", "-api", "geolocation",
		"-GeolocationTimeZone", "-j", filePath,
	)
	output, err := command.Output()
	if err != nil {
		return
	}
	var documents []map[string]any
	if json.Unmarshal(output, &documents) != nil || len(documents) == 0 {
		return
	}
	timezone := strings.TrimSpace(firstString(documents[0]["GeolocationTimeZone"]))
	if timezone == "" {
		return
	}
	exif["tz"] = timezone
	exif["tzSource"] = "GPSLatitude/GPSLongitude"
}

func parseExifOffset(value string) (int, bool) {
	value = strings.TrimSpace(value)
	if len(value) != 6 || (value[0] != '+' && value[0] != '-') || value[3] != ':' {
		return 0, false
	}
	hours, hourErr := strconv.Atoi(value[1:3])
	minutes, minuteErr := strconv.Atoi(value[4:6])
	if hourErr != nil || minuteErr != nil || hours > 23 || minutes > 59 {
		return 0, false
	}
	seconds := hours*60*60 + minutes*60
	if value[0] == '-' {
		seconds = -seconds
	}
	return seconds, true
}

func parseExifTimeInLocation(value string, location *time.Location) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, "2006:01:02 15:04:05-07:00"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed
		}
	}
	for _, layout := range []string{"2006:01:02 15:04:05", "2006-01-02 15:04:05"} {
		if parsed, err := time.ParseInLocation(layout, value, location); err == nil {
			return parsed
		}
	}
	return time.Time{}
}

func javascriptDateISOString(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func filterNeededExif(input map[string]any) map[string]any {
	result := make(map[string]any, len(neededExifKeys))
	for _, key := range neededExifKeys {
		if value, ok := input[key]; ok {
			result[key] = value
		}
	}
	return result
}

func reindexedPhotoFields(key string, exif map[string]any, now time.Time) map[string]any {
	fileName := strings.TrimSuffix(filepath.Base(key), filepath.Ext(key))
	title := firstExifString(exif, "Title", "XPTitle", "Description", "ImageDescription", "CaptionAbstract")
	if title == "" {
		cleaned := photoTitleDatePattern.ReplaceAllString(fileName, "")
		cleaned = photoTitleViewsPattern.ReplaceAllString(cleaned, "")
		cleaned = photoTitleSeparatorPattern.ReplaceAllString(cleaned, " ")
		title = strings.TrimSpace(cleaned)
	}
	if title == "" {
		title = fileName
	}

	dateTaken := firstExifString(exif, "DateTimeOriginal", "CreateDate", "DateTimeDigitized")
	if parsed := parseExifTime(dateTaken); !parsed.IsZero() {
		dateTaken = javascriptDateISOString(parsed)
	} else if dateTaken == "" {
		dateTaken = javascriptDateISOString(filenameDate(fileName, now))
	}

	tags := make([]string, 0)
	seen := make(map[string]struct{})
	for _, value := range []any{
		exif["Subject"], exif["Keywords"], exif["XPKeywords"],
	} {
		for _, item := range exifStrings(value) {
			for _, part := range strings.FieldsFunc(item, func(r rune) bool { return r == ',' || r == ';' }) {
				part = strings.TrimSpace(part)
				if part != "" {
					if _, exists := seen[part]; !exists {
						seen[part] = struct{}{}
						tags = append(tags, part)
					}
				}
			}
		}
	}

	result := map[string]any{
		"exif":          exif,
		"title":         title,
		"date_taken":    dateTaken,
		"tags":          tags,
		"latitude":      nil,
		"longitude":     nil,
		"country":       nil,
		"city":          nil,
		"location_name": nil,
		"last_modified": javascriptDateISOString(now),
	}
	if latitude, ok := exifCoordinate(exif, true); ok {
		result["latitude"] = latitude
	}
	if longitude, ok := exifCoordinate(exif, false); ok {
		result["longitude"] = longitude
	}
	if country := firstExifString(exif, "Country-PrimaryLocationName", "Country"); country != "" {
		result["country"] = country
	}
	if city := firstExifString(exif, "City", "Sub-location", "Location"); city != "" {
		result["city"] = city
		result["location_name"] = city
	}
	return result
}

func (a *Application) applyExifUpdate(
	ctx context.Context,
	id string,
	key string,
	exif map[string]any,
) error {
	fields := reindexedPhotoFields(key, exif, a.now())
	exifJSON, err := json.Marshal(fields["exif"])
	if err != nil {
		return fmt.Errorf("encode exif: %w", err)
	}
	tagsJSON, err := json.Marshal(fields["tags"])
	if err != nil {
		return fmt.Errorf("encode tags: %w", err)
	}
	_, err = a.database.SQL().ExecContext(ctx, `
		UPDATE photos
		SET exif = ?, title = ?, date_taken = ?, tags = ?,
		    latitude = ?, longitude = ?, country = ?, city = ?,
		    location_name = ?, last_modified = ?
		WHERE id = ?
	`, string(exifJSON),
		fields["title"],
		fields["date_taken"],
		string(tagsJSON),
		fields["latitude"],
		fields["longitude"],
		fields["country"],
		fields["city"],
		fields["location_name"],
		fields["last_modified"],
		id,
	)
	if err != nil {
		return fmt.Errorf("update photo exif: %w", err)
	}
	return nil
}

func firstExifString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(firstString(values[key])); value != "" {
			return value
		}
	}
	return ""
}

func firstString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		for _, item := range typed {
			if value := firstString(item); value != "" {
				return value
			}
		}
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		if value != nil {
			return fmt.Sprint(value)
		}
	}
	return ""
}

func exifStrings(value any) []string {
	switch typed := value.(type) {
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			if value := strings.TrimSpace(firstString(item)); value != "" {
				result = append(result, value)
			}
		}
		return result
	case string:
		if strings.TrimSpace(typed) == "" {
			return nil
		}
		return []string{typed}
	default:
		if value == nil {
			return nil
		}
		return []string{firstString(value)}
	}
}

func firstExifFloat(values map[string]any, keys ...string) (float64, bool) {
	for _, key := range keys {
		switch value := values[key].(type) {
		case float64:
			return value, true
		case json.Number:
			parsed, err := value.Float64()
			if err == nil {
				return parsed, true
			}
		case string:
			parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
			if err == nil {
				return parsed, true
			}
		}
	}
	return 0, false
}

func exifCoordinate(values map[string]any, latitude bool) (float64, bool) {
	key := "GPSLongitude"
	refKey := "GPSLongitudeRef"
	if latitude {
		key = "GPSLatitude"
		refKey = "GPSLatitudeRef"
	}
	value, ok := firstExifFloat(values, key)
	if !ok {
		coordinates := firstExifString(values, "GPSCoordinates", "GPSPosition")
		parts := strings.FieldsFunc(coordinates, func(r rune) bool {
			return r == ',' || r == ';' || r == ' ' || r == '/'
		})
		if len(parts) >= 2 {
			index := 0
			if !latitude {
				index = 1
			}
			if parsed, err := strconv.ParseFloat(strings.TrimSpace(parts[index]), 64); err == nil {
				value, ok = parsed, true
			}
		}
	}
	if !ok {
		return 0, false
	}
	if ref := strings.ToUpper(strings.TrimSpace(firstString(values[refKey]))); ref == "S" || ref == "W" {
		value = -absFloat(value)
	}
	return value, true
}

func absFloat(value float64) float64 {
	if value < 0 {
		return -value
	}
	return value
}

func filenameDate(fileName string, fallback time.Time) time.Time {
	for _, layout := range []string{"2006-01-02", "2006_01_02"} {
		for index := 0; index+len(layout) <= len(fileName); index++ {
			candidate := fileName[index : index+len(layout)]
			if parsed, err := time.ParseInLocation(layout, candidate, time.UTC); err == nil {
				return parsed
			}
		}
	}
	return fallback
}

func parseExifTime(value string) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}
	}
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006:01:02 15:04:05",
		"2006:01:02 15:04:05-07:00",
		"2006-01-02 15:04:05",
	} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed
		}
	}
	return time.Time{}
}
