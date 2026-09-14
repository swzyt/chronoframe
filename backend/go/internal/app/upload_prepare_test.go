package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	platformdb "github.com/swzyt/chronoframe/backend/go/internal/platform/db"
)

func TestUploadPrepareHelpersMatchNodeContract(t *testing.T) {
	objectKey := joinStorageKey("dual-fixture", "users", "910001", "dual mutation upload.jpg")
	if objectKey != "dual-fixture/users/910001/dual mutation upload.jpg" {
		t.Fatalf("objectKey = %q", objectKey)
	}
	if got := encodeURIComponent(objectKey); got != "dual-fixture%2Fusers%2F910001%2Fdual%20mutation%20upload.jpg" {
		t.Fatalf("encodeURIComponent() = %q", got)
	}
	if !isUserUploadStorageKey(testMediaProvider("dual-fixture"), 910001, objectKey) {
		t.Fatal("prefixed user storage key should be accepted")
	}
	if isUserUploadStorageKey(testMediaProvider("dual-fixture"), 910002, objectKey) {
		t.Fatal("other user's storage key should be rejected")
	}
}

func TestUploadDuplicateMediaIDMatchesNodePrepareRules(t *testing.T) {
	cases := map[string]string{
		"dual-fixture/users/910001/clip.mp4":                             "clip-video-be1194d2",
		"dual-fixture/users/910001/clip.mov":                             "clip",
		"dual-fixture/users/910001/dual-mutation-upload-prepare.jpg":     "dual-mutation-upload-prepare",
		"dual-fixture/users/910001/很短.jpg":                               "photo_ec30c915",
		"dual-fixture/users/910001/really long upload filename here.jpg": "really_long_upload_filename_here",
	}
	for storageKey, want := range cases {
		if got := mediaIDForUploadDuplicate(storageKey); got != want {
			t.Fatalf("mediaIDForUploadDuplicate(%q) = %q, want %q", storageKey, got, want)
		}
	}
}

func TestUniqueUploadStorageKeyMatchesNodeCollisionSuffixShape(t *testing.T) {
	ctx := context.Background()
	store, err := platformdb.Open(ctx, filepath.Join(t.TempDir(), "upload-prepare.sqlite3"), platformdb.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.SQL().ExecContext(ctx, `
		CREATE TABLE photos (
			id TEXT PRIMARY KEY,
			storage_key TEXT
		);
		CREATE TABLE pipeline_queue (
			id INTEGER PRIMARY KEY,
			payload TEXT NOT NULL,
			status TEXT NOT NULL
		);
		INSERT INTO photos(id, storage_key)
		VALUES('existing', 'dual-fixture/users/910001/existing.jpg');
	`); err != nil {
		t.Fatal(err)
	}
	application := NewApplication(Dependencies{
		Database: store,
		Now:      func() time.Time { return time.UnixMilli(1_789_137_245_151) },
	})

	key, err := application.uniqueUploadStorageKey(ctx, "dual-fixture/users/910001/new.jpg")
	if err != nil {
		t.Fatal(err)
	}
	if key != "dual-fixture/users/910001/new.jpg" {
		t.Fatalf("new key = %q", key)
	}

	key, err = application.uniqueUploadStorageKey(ctx, "dual-fixture/users/910001/existing.jpg")
	if err != nil {
		t.Fatal(err)
	}
	if key != "dual-fixture/users/910001/existing-mtx24dlr.jpg" {
		t.Fatalf("colliding key = %q", key)
	}
}

func TestUploadPrepareResponseJSONOrderMatchesNode(t *testing.T) {
	payload := uploadPrepareResponse{
		SignedURL:   "/api/photos/upload?key=dual-fixture%2Fusers%2F910001%2Fdual-mutation-upload-prepare.jpg",
		FileKey:     "dual-fixture/users/910001/dual-mutation-upload-prepare.jpg",
		ContentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		ExpiresIn:   3600,
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"signedUrl":"/api/photos/upload?key=dual-fixture%2Fusers%2F910001%2Fdual-mutation-upload-prepare.jpg","fileKey":"dual-fixture/users/910001/dual-mutation-upload-prepare.jpg","contentHash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","expiresIn":3600}`
	if string(encoded) != want {
		t.Fatalf("upload prepare JSON = %s", encoded)
	}
}

func TestDuplicateCheckResponseJSONOrderMatchesNode(t *testing.T) {
	payload := duplicateCheckResponse{
		Success: true,
		Results: []any{
			duplicateContentHashResult{
				ContentHash:           "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
				NormalizedContentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				Exists:                false,
				Photo:                 nil,
			},
			duplicateFileNameResult{
				FileName:   "dual-mutation-upload-prepare.jpg",
				StorageKey: "dual-fixture/users/910001/dual-mutation-upload-prepare.jpg",
				PhotoID:    "dual-mutation-upload-prepare",
				Exists:     false,
				Photo:      nil,
			},
			duplicateStorageKeyResult{
				StorageKey: "dual-fixture/users/910001/dual-mutation-upload-prepare.jpg",
				PhotoID:    "dual-mutation-upload-prepare",
				Exists:     false,
				Photo:      nil,
			},
		},
		DuplicatesFound: 0,
		Summary: duplicateCheckSummary{
			Title:   "Check Complete",
			Message: "Checked 3 files, found 0 duplicates",
		},
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"success":true,"results":[{"contentHash":"0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF","normalizedContentHash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","exists":false,"photo":null},{"fileName":"dual-mutation-upload-prepare.jpg","storageKey":"dual-fixture/users/910001/dual-mutation-upload-prepare.jpg","photoId":"dual-mutation-upload-prepare","exists":false,"photo":null},{"storageKey":"dual-fixture/users/910001/dual-mutation-upload-prepare.jpg","photoId":"dual-mutation-upload-prepare","exists":false,"photo":null}],"duplicatesFound":0,"summary":{"title":"Check Complete","message":"Checked 3 files, found 0 duplicates"}}`
	if string(encoded) != want {
		t.Fatalf("duplicate check JSON = %s", encoded)
	}
}

func TestDecodePhotoDuplicateCheckBodyMatchesNodeZodValidation(t *testing.T) {
	cases := []struct {
		name        string
		body        string
		wantMessage string
	}{
		{
			name: "missing body",
			body: "",
			wantMessage: zodValidationMessage(
				zodInvalidTypeIssue([]any{}, "object", "undefined"),
			),
		},
		{
			name: "null body",
			body: "null",
			wantMessage: zodValidationMessage(
				zodInvalidTypeIssue([]any{}, "object", "null"),
			),
		},
		{
			name: "fileNames object",
			body: `{"fileNames":{}}`,
			wantMessage: zodValidationMessage(
				zodInvalidTypeIssue([]any{"fileNames"}, "array", "object"),
			),
		},
		{
			name: "fileNames item number",
			body: `{"fileNames":[123]}`,
			wantMessage: zodValidationMessage(
				zodInvalidTypeIssue([]any{"fileNames", 0}, "string", "number"),
			),
		},
		{
			name: "storageKeys object",
			body: `{"storageKeys":{}}`,
			wantMessage: zodValidationMessage(
				zodInvalidTypeIssue([]any{"storageKeys"}, "array", "object"),
			),
		},
		{
			name: "contentHashes object",
			body: `{"contentHashes":{}}`,
			wantMessage: zodValidationMessage(
				zodInvalidTypeIssue([]any{"contentHashes"}, "array", "object"),
			),
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/photos/check-duplicate", strings.NewReader(testCase.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()

			if _, ok := decodePhotoDuplicateCheckBody(response, request); ok {
				t.Fatalf("decodePhotoDuplicateCheckBody() ok = true, want false")
			}
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			var parsed struct {
				StatusMessage string `json:"statusMessage"`
				Message       string `json:"message"`
				Data          struct {
					Name    string `json:"name"`
					Message string `json:"message"`
				} `json:"data"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &parsed); err != nil {
				t.Fatal(err)
			}
			if parsed.StatusMessage != "Validation Error" ||
				parsed.Message != testCase.wantMessage ||
				parsed.Data.Name != "ZodError" ||
				parsed.Data.Message != testCase.wantMessage {
				t.Fatalf("body = %#v, want Node-compatible Zod validation message %s", parsed, testCase.wantMessage)
			}
		})
	}
}

func TestDecodePhotoDuplicateCheckBodyAcceptsValidOptionalArrays(t *testing.T) {
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/photos/check-duplicate",
		strings.NewReader(`{"fileNames":["a.jpg"],"storageKeys":["users/1/a.jpg"],"contentHashes":["ABC"]}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	body, ok := decodePhotoDuplicateCheckBody(response, request)
	if !ok {
		t.Fatalf("decodePhotoDuplicateCheckBody() ok = false, status = %d, body = %s", response.Code, response.Body.String())
	}
	if got := strings.Join(body.FileNames, ","); got != "a.jpg" {
		t.Fatalf("FileNames = %#v", body.FileNames)
	}
	if got := strings.Join(body.StorageKeys, ","); got != "users/1/a.jpg" {
		t.Fatalf("StorageKeys = %#v", body.StorageKeys)
	}
	if got := strings.Join(body.ContentHashes, ","); got != "ABC" {
		t.Fatalf("ContentHashes = %#v", body.ContentHashes)
	}
	if !body.HasFileNames || !body.HasStorageKeys || !body.HasContentHashes {
		t.Fatalf("presence flags = %#v, want all true", body)
	}
}

func TestDecodePhotoDuplicateCheckBodyPreservesEmptyArrayPresence(t *testing.T) {
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/photos/check-duplicate",
		strings.NewReader(`{"fileNames":[]}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	body, ok := decodePhotoDuplicateCheckBody(response, request)
	if !ok {
		t.Fatalf("decodePhotoDuplicateCheckBody() ok = false, status = %d, body = %s", response.Code, response.Body.String())
	}
	if !body.HasFileNames || body.HasStorageKeys || body.HasContentHashes {
		t.Fatalf("presence flags = %#v", body)
	}
	if len(body.FileNames) != 0 {
		t.Fatalf("FileNames = %#v, want empty", body.FileNames)
	}
}

func TestDecodePublicUploadPrepareBodyMatchesNodeZodValidation(t *testing.T) {
	longName := strings.Repeat("a", 256)
	cases := []struct {
		name        string
		body        string
		wantMessage string
	}{
		{
			name: "missing body",
			body: "",
			wantMessage: zodValidationMessage(
				zodInvalidTypeIssue([]any{}, "object", "undefined"),
			),
		},
		{
			name: "null body",
			body: "null",
			wantMessage: zodValidationMessage(
				zodInvalidTypeIssue([]any{}, "object", "null"),
			),
		},
		{
			name: "missing fileName",
			body: `{}`,
			wantMessage: zodValidationMessage(
				zodInvalidTypeIssue([]any{"fileName"}, "string", "undefined"),
			),
		},
		{
			name: "fileName number",
			body: `{"fileName":123}`,
			wantMessage: zodValidationMessage(
				zodInvalidTypeIssue([]any{"fileName"}, "string", "number"),
			),
		},
		{
			name: "fileName empty",
			body: `{"fileName":""}`,
			wantMessage: zodValidationMessage(
				zodTooSmallStringIssue([]any{"fileName"}, 1),
			),
		},
		{
			name: "fileName too long",
			body: `{"fileName":"` + longName + `"}`,
			wantMessage: zodValidationMessage(
				zodTooBigStringIssue([]any{"fileName"}, 255),
			),
		},
		{
			name: "contentType number",
			body: `{"fileName":"guest.jpg","contentType":123}`,
			wantMessage: zodValidationMessage(
				zodInvalidTypeIssue([]any{"contentType"}, "string", "number"),
			),
		},
		{
			name: "contentHash null",
			body: `{"fileName":"guest.jpg","contentHash":null}`,
			wantMessage: zodValidationMessage(
				zodInvalidTypeIssue([]any{"contentHash"}, "string", "null"),
			),
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/upload-shares/public/token/prepare", strings.NewReader(testCase.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()

			if _, ok := decodePublicUploadPrepareBody(response, request); ok {
				t.Fatalf("decodePublicUploadPrepareBody() ok = true, want false")
			}
			assertZodValidationResponse(t, response, testCase.wantMessage)
		})
	}
}

func TestDecodePublicUploadPrepareBodyAcceptsValidOptionalFields(t *testing.T) {
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/upload-shares/public/token/prepare",
		strings.NewReader(`{"fileName":"guest.jpg","contentType":"image/jpeg","contentHash":"ABC"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	body, ok := decodePublicUploadPrepareBody(response, request)
	if !ok {
		t.Fatalf("decodePublicUploadPrepareBody() ok = false, status = %d, body = %s", response.Code, response.Body.String())
	}
	if body.FileName != "guest.jpg" || body.ContentType != "image/jpeg" || body.ContentHash != "ABC" {
		t.Fatalf("body = %#v", body)
	}
}

func TestDecodePublicUploadTaskBodyMatchesNodeZodValidation(t *testing.T) {
	cases := []struct {
		name        string
		body        string
		wantMessage string
	}{
		{
			name: "missing body",
			body: "",
			wantMessage: zodValidationMessage(
				zodInvalidTypeIssue([]any{}, "object", "undefined"),
			),
		},
		{
			name: "null body",
			body: "null",
			wantMessage: zodValidationMessage(
				zodInvalidTypeIssue([]any{}, "object", "null"),
			),
		},
		{
			name: "missing payload",
			body: `{}`,
			wantMessage: zodValidationMessage(
				zodInvalidTypeCodeFirstIssue([]any{"payload"}, "object", "undefined"),
			),
		},
		{
			name: "invalid task type",
			body: `{"payload":{"type":"bad","storageKey":"x"}}`,
			wantMessage: zodValidationMessage(
				zodInvalidDiscriminatorIssue([]any{"payload", "type"}, "type", "photo", "live-photo-video", "video"),
			),
		},
		{
			name: "missing storageKey",
			body: `{"payload":{"type":"photo"}}`,
			wantMessage: zodValidationMessage(
				zodInvalidTypeIssue([]any{"payload", "storageKey"}, "string", "undefined"),
			),
		},
		{
			name: "empty storageKey",
			body: `{"payload":{"type":"photo","storageKey":""}}`,
			wantMessage: zodValidationMessage(
				zodTooSmallStringIssue([]any{"payload", "storageKey"}, 1),
			),
		},
		{
			name: "invalid contentHash",
			body: `{"payload":{"type":"photo","storageKey":"x","contentHash":"bad"}}`,
			wantMessage: zodValidationMessage(
				zodInvalidFormatIssue(
					[]any{"payload", "contentHash"},
					"regex",
					"/^[a-f0-9]{64}$/i",
					"Invalid string: must match pattern /^[a-f0-9]{64}$/i",
				),
			),
		},
		{
			name: "eraseLocation string",
			body: `{"payload":{"type":"photo","storageKey":"x","eraseLocation":"yes"}}`,
			wantMessage: zodValidationMessage(
				zodInvalidTypeIssue([]any{"payload", "eraseLocation"}, "boolean", "string"),
			),
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/upload-shares/public/token/task", strings.NewReader(testCase.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()

			if _, ok := decodePublicUploadTaskBody(response, request); ok {
				t.Fatalf("decodePublicUploadTaskBody() ok = true, want false")
			}
			assertZodValidationResponse(t, response, testCase.wantMessage)
		})
	}
}

func TestDecodePublicUploadTaskBodyAcceptsAndStripsNodePayloadShapes(t *testing.T) {
	cases := []struct {
		name string
		body string
		want map[string]any
	}{
		{
			name: "photo keeps own optional fields",
			body: `{"payload":{"type":"photo","storageKey":"users/1/guest.jpg","contentHash":"ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789","eraseLocation":true,"extra":"ignored"}}`,
			want: map[string]any{
				"type":          "photo",
				"storageKey":    "users/1/guest.jpg",
				"contentHash":   "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
				"eraseLocation": true,
			},
		},
		{
			name: "video strips photo-only eraseLocation",
			body: `{"payload":{"type":"video","storageKey":"users/1/guest.mp4","contentHash":"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789","eraseLocation":"ignored","extra":"ignored"}}`,
			want: map[string]any{
				"type":        "video",
				"storageKey":  "users/1/guest.mp4",
				"contentHash": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
			},
		},
		{
			name: "live photo video strips unrelated optional fields",
			body: `{"payload":{"type":"live-photo-video","storageKey":"users/1/guest.mov","contentHash":null,"eraseLocation":"ignored","extra":"ignored"}}`,
			want: map[string]any{
				"type":       "live-photo-video",
				"storageKey": "users/1/guest.mov",
			},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(
				http.MethodPost,
				"/api/upload-shares/public/token/task",
				strings.NewReader(testCase.body),
			)
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()

			payload, ok := decodePublicUploadTaskBody(response, request)
			if !ok {
				t.Fatalf("decodePublicUploadTaskBody() ok = false, status = %d, body = %s", response.Code, response.Body.String())
			}
			if len(payload) != len(testCase.want) {
				t.Fatalf("payload = %#v, want %#v", payload, testCase.want)
			}
			for key, want := range testCase.want {
				if got := payload[key]; got != want {
					t.Fatalf("payload[%q] = %#v, want %#v; full payload = %#v", key, got, want, payload)
				}
			}
			for _, strippedKey := range []string{"extra", "eraseLocation", "contentHash"} {
				if _, exists := payload[strippedKey]; exists && testCase.want[strippedKey] == nil {
					t.Fatalf("payload kept stripped field %q: %#v", strippedKey, payload)
				}
			}
		})
	}
}

func assertZodValidationResponse(t *testing.T, response *httptest.ResponseRecorder, wantMessage string) {
	t.Helper()
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var parsed struct {
		StatusMessage string `json:"statusMessage"`
		Message       string `json:"message"`
		Data          struct {
			Name    string `json:"name"`
			Message string `json:"message"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.StatusMessage != "Validation Error" ||
		parsed.Message != wantMessage ||
		parsed.Data.Name != "ZodError" ||
		parsed.Data.Message != wantMessage {
		t.Fatalf("body = %#v, want Node-compatible Zod validation message %s", parsed, wantMessage)
	}
}

func testMediaProvider(prefix string) interface {
	StoragePrefix() string
} {
	return storagePrefixProvider(prefix)
}

type storagePrefixProvider string

func (p storagePrefixProvider) StoragePrefix() string {
	return string(p)
}
