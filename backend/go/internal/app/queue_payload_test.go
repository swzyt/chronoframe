package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	platformconfig "github.com/swzyt/chronoframe/backend/go/internal/platform/config"
)

func TestSanitizeQueuePayloadMirrorsNodeAddTaskSchema(t *testing.T) {
	raw := map[string]any{
		"type":          "photo",
		"storageKey":    "dual-fixture/users/910001/upload.jpg",
		"contentHash":   "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
		"eraseLocation": true,
		"extra":         "stripped",
	}

	payload, err := sanitizeQueuePayload(raw, queuePayloadModeAddTask)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := payload["extra"]; ok {
		t.Fatalf("payload kept unknown field: %#v", payload)
	}
	if got := payload["contentHash"]; got != raw["contentHash"] {
		t.Fatalf("contentHash = %#v, want original request casing", got)
	}
	if got, want := payload["type"], "photo"; got != want {
		t.Fatalf("type = %#v, want %q", got, want)
	}
}

func TestSanitizeQueuePayloadMirrorsNodeAddTasksSchema(t *testing.T) {
	photo, err := sanitizeQueuePayload(map[string]any{
		"type":          "photo",
		"storageKey":    "dual-fixture/users/910001/batch.jpg",
		"contentHash":   "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
		"eraseLocation": false,
	}, queuePayloadModeAddTasks)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := photo["contentHash"]; ok {
		t.Fatalf("batch photo payload kept add-task-only contentHash: %#v", photo)
	}
	if _, err := sanitizeQueuePayload(map[string]any{
		"type":       "video",
		"storageKey": "dual-fixture/users/910001/video.mp4",
	}, queuePayloadModeAddTasks); err == nil {
		t.Fatal("batch video payload accepted, want Node discriminated-union rejection")
	}
}

func TestSanitizeQueuePayloadRejectsInvalidNodeSchemaFields(t *testing.T) {
	for _, test := range []struct {
		name    string
		payload map[string]any
	}{
		{
			name: "invalid content hash",
			payload: map[string]any{
				"type":        "photo",
				"storageKey":  "dual-fixture/users/910001/upload.jpg",
				"contentHash": "not-a-sha256",
			},
		},
		{
			name: "invalid eraseLocation",
			payload: map[string]any{
				"type":          "photo",
				"storageKey":    "dual-fixture/users/910001/upload.jpg",
				"eraseLocation": "true",
			},
		},
		{
			name: "invalid latitude",
			payload: map[string]any{
				"type":     "photo-reverse-geocoding",
				"photoId":  "photo-1",
				"latitude": json.Number("90.1"),
			},
		},
		{
			name: "unknown type",
			payload: map[string]any{
				"type":       "unknown",
				"storageKey": "dual-fixture/users/910001/upload.jpg",
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := sanitizeQueuePayload(test.payload, queuePayloadModeAddTask); err == nil {
				t.Fatal("sanitizeQueuePayload() error = nil, want validation error")
			}
		})
	}
}

func TestBuildUploadShareStorageKeyMatchesNodePrefixShape(t *testing.T) {
	application := NewApplication(Dependencies{
		Now: func() time.Time { return time.Date(2026, 9, 12, 3, 4, 5, 0, time.UTC) },
	})

	key, err := application.buildUploadShareStorageKey(
		testMediaProvider("dual-fixture"),
		910001,
		910003,
		"很 长 的 文件.JPG",
	)
	if err != nil {
		t.Fatal(err)
	}
	const prefix = "dual-fixture/users/910001/guest-uploads/910003/2026-09-12/upload_671bbbb6-"
	if !strings.HasPrefix(key, prefix) {
		t.Fatalf("key = %q, want prefix %q", key, prefix)
	}
	if !strings.HasSuffix(key, ".jpg") {
		t.Fatalf("key = %q, want lowercase safe extension", key)
	}
	if !isUploadShareStorageKey(testMediaProvider("dual-fixture"), 910001, 910003, key) {
		t.Fatalf("isUploadShareStorageKey rejected generated key %q", key)
	}
	if isUploadShareStorageKey(testMediaProvider("dual-fixture"), 910002, 910003, key) {
		t.Fatalf("isUploadShareStorageKey accepted wrong owner for %q", key)
	}
}

func TestParseOptionalQueueNumberMatchesBoundedNodeNumbers(t *testing.T) {
	if got, err := parseOptionalQueueNumber("", 3, 1, 5); err != nil || got != 3 {
		t.Fatalf("default value = %v, %v; want 3, nil", got, err)
	}
	if _, err := parseOptionalQueueNumber(json.Number("10"), 0, 0, 9); err == nil {
		t.Fatal("priority 10 accepted, want validation error")
	}
	if got, err := parseOptionalQueueNumber(json.Number("1.5"), 0, 0, 9); err != nil || got != 1.5 {
		t.Fatalf("fractional priority = %v, %v; want 1.5, nil", got, err)
	}
}

func TestCheckedUploadBodyMirrorsNodeDefaultLimits(t *testing.T) {
	application := NewApplication(Dependencies{
		Config: platformconfig.Config{
			UploadMIMEWhitelistEnabled: true,
			UploadMIMEWhitelist:        "image/jpeg,image/png",
		},
	})

	invalidTypeRequest := httptest.NewRequest(http.MethodPut, "/api/photos/upload?key=x", strings.NewReader("x"))
	invalidTypeRequest.Header.Set("Content-Type", "text/plain")
	invalidTypeResponse := httptest.NewRecorder()
	if _, ok := application.checkedUploadBody(invalidTypeResponse, invalidTypeRequest, uploadContentType(invalidTypeRequest)); ok {
		t.Fatal("text/plain upload accepted, want MIME whitelist rejection")
	}
	if invalidTypeResponse.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("invalid MIME status = %d, want 415", invalidTypeResponse.Code)
	}
	var invalidTypeError struct {
		StatusMessage string `json:"statusMessage"`
		Message       string `json:"message"`
	}
	if err := json.Unmarshal(invalidTypeResponse.Body.Bytes(), &invalidTypeError); err != nil {
		t.Fatal(err)
	}
	if invalidTypeError.StatusMessage != "Unsupported File Type" ||
		invalidTypeError.Message != "Unsupported File Type" {
		t.Fatalf("invalid MIME body = %#v, want Node-compatible Unsupported File Type", invalidTypeError)
	}

	tooLargeRequest := httptest.NewRequest(http.MethodPut, "/api/photos/upload?key=x", strings.NewReader("x"))
	tooLargeRequest.Header.Set("Content-Type", "image/jpeg")
	tooLargeRequest.ContentLength = 257 * 1024 * 1024
	tooLargeResponse := httptest.NewRecorder()
	if _, ok := application.checkedUploadBody(tooLargeResponse, tooLargeRequest, uploadContentType(tooLargeRequest)); ok {
		t.Fatal("oversized upload accepted, want max file size rejection")
	}
	if tooLargeResponse.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status = %d, want 413", tooLargeResponse.Code)
	}

	validRequest := httptest.NewRequest(http.MethodPut, "/api/photos/upload?key=x", strings.NewReader("x"))
	validRequest.Header.Set("Content-Type", "image/png")
	validResponse := httptest.NewRecorder()
	body, ok := application.checkedUploadBody(validResponse, validRequest, uploadContentType(validRequest))
	if !ok {
		t.Fatalf("image/png upload rejected: status=%d body=%s", validResponse.Code, validResponse.Body.String())
	}
	if body.size != 1 {
		t.Fatalf("upload size = %d, want 1", body.size)
	}
}
