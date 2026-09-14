package app

import (
	"reflect"
	"testing"
	"time"
)

func TestExiftoolWriteArgsAreStableAndReplaceLists(t *testing.T) {
	args := exiftoolWriteArgs(map[string]any{
		"Rating":          int64(3),
		"Title":           "Go title",
		"Subject":         []string{"go", "metadata"},
		"Keywords":        []string{"go", "metadata"},
		"XPKeywords":      "go; metadata",
		"GPSLatitude":     31.23,
		"GPSLatitudeRef":  "N",
		"GPSLongitude":    121.47,
		"GPSLongitudeRef": "E",
		"GPSPosition":     "31.23,121.47",
		"CaptionAbstract": nil,
	})

	want := []string{
		"-Title=Go title",
		"-CaptionAbstract=",
		"-Subject=go\x1fmetadata",
		"-Keywords=go\x1fmetadata",
		"-XPKeywords=go; metadata",
		"-GPSLatitude=31.23",
		"-GPSLatitudeRef=N",
		"-GPSLongitude=121.47",
		"-GPSLongitudeRef=E",
		"-GPSPosition=31.23,121.47",
		"-Rating=3",
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("exiftoolWriteArgs() = %#v, want %#v", args, want)
	}
}

func TestExiftoolHTMLEncodeMatchesVendoredWriter(t *testing.T) {
	got := exiftoolHTMLEncode("\u4e2d\u6587 & < > \" ' ` *\n\u00e9\t")
	want := "&#20013;&#25991; & < > \" ' ` *&#10;&#233;&#9;"
	if got != want {
		t.Fatalf("exiftoolHTMLEncode() = %q, want %q", got, want)
	}
}

func TestReindexedPhotoFieldsUseNodeTitleCleanupAndMillisecondDates(t *testing.T) {
	now := time.Date(2026, time.March, 8, 9, 10, 11, 987654321, time.UTC)
	fields := reindexedPhotoFields("users/1/2024-01-02_trip-123views.jpg", map[string]any{}, now)
	if fields["title"] != "trip" {
		t.Fatalf("title = %#v", fields["title"])
	}
	if fields["date_taken"] != "2024-01-02T00:00:00.000Z" {
		t.Fatalf("date_taken = %#v", fields["date_taken"])
	}
	if fields["last_modified"] != "2026-03-08T09:10:11.987Z" {
		t.Fatalf("last_modified = %#v", fields["last_modified"])
	}
}

func TestNormalizeExifDatesUsesExplicitOffset(t *testing.T) {
	exif := map[string]any{
		"DateTimeOriginal": "2026:03:08 09:10:11",
		"tz":               "+08:00",
	}
	normalizeExifDates(exif)
	if exif["DateTimeOriginal"] != "2026-03-08T01:10:11.000Z" {
		t.Fatalf("DateTimeOriginal = %#v", exif["DateTimeOriginal"])
	}
}

func TestNormalizeExifGPSUsesCoordinateSigns(t *testing.T) {
	exif := map[string]any{"GPSLatitude": -31.2, "GPSLongitude": 121.5}
	normalizeExifGPS(exif)
	if exif["GPSLatitudeRef"] != "S" || exif["GPSLongitudeRef"] != "E" {
		t.Fatalf("GPS refs = %#v/%#v", exif["GPSLatitudeRef"], exif["GPSLongitudeRef"])
	}
}
