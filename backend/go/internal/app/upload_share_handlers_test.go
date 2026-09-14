package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/uploads"
)

func TestRequestOriginPrefersNodeDispatcherPublicURL(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "http://go:8080/api/upload-shares", nil)
	request.Header.Set(
		"X-ChronoFrame-Original-URL",
		"https://photos.example.test/api/upload-shares?scope=mine",
	)
	request.Header.Set("X-Forwarded-Proto", "http")

	if got, want := requestOrigin(request), "https://photos.example.test"; got != want {
		t.Fatalf("requestOrigin() = %q, want %q", got, want)
	}
}

func TestRequestOriginRejectsInvalidDispatcherURL(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "http://go:8080/api/upload-shares", nil)
	request.Header.Set("X-ChronoFrame-Original-URL", "file:///etc/passwd")
	request.Header.Set("X-Forwarded-Proto", "https")

	if got, want := requestOrigin(request), "https://go:8080"; got != want {
		t.Fatalf("requestOrigin() = %q, want %q", got, want)
	}
}

func TestNextUploadShareTokenRetriesNodeCollisionBudget(t *testing.T) {
	_, store := newWizardTestApplication(t)
	insertWizardUser(t, store.SQL(), "owner@example.test")
	first := "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	second := "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
	if _, err := store.SQL().Exec(`
		INSERT INTO upload_shares(
			token_hash, token, owner_user_id, created_by_user_id,
			label, is_active, upload_count, created_at, updated_at
		) VALUES(?, ?, 1, 1, 'existing', 1, 0, 1, 1)
	`, uploads.HashToken(first), first); err != nil {
		t.Fatal(err)
	}

	generated := []string{first, second}
	calls := 0
	token, err := nextUploadShareToken(t.Context(), store.SQL(), func() (string, error) {
		value := generated[calls]
		calls++
		return value, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if token != second || calls != 2 {
		t.Fatalf("nextUploadShareToken() = %q after %d calls, want %q after 2", token, calls, second)
	}
}

func TestDecodeUploadShareCreateBodyMatchesNodeZodSchema(t *testing.T) {
	response := httptest.NewRecorder()
	_, ok := decodeUploadShareCreateBody(
		response,
		httptest.NewRequest(
			http.MethodPost,
			"/api/upload-shares",
			strings.NewReader(`{"label":1,"expiresInDays":"30","maxUploads":true}`),
		),
	)
	if ok {
		t.Fatal("decodeUploadShareCreateBody() ok = true, want false")
	}
	expectAlbumValidationError(t, response, zodValidationMessage(
		zodInvalidTypeIssue([]any{"label"}, "string", "number"),
		zodInvalidTypeIssue([]any{"expiresInDays"}, "number", "string"),
		zodInvalidTypeIssue([]any{"maxUploads"}, "number", "boolean"),
	))

	response = httptest.NewRecorder()
	_, ok = decodeUploadShareCreateBody(
		response,
		httptest.NewRequest(
			http.MethodPost,
			"/api/upload-shares",
			strings.NewReader(`{"label":"  `+strings.Repeat("😀", 81)+`  ","expiresInDays":1.5,"maxUploads":0}`),
		),
	)
	if ok {
		t.Fatal("decodeUploadShareCreateBody(bounds) ok = true, want false")
	}
	expectAlbumValidationError(t, response, zodValidationMessage(
		zodTooBigStringIssue([]any{"label"}, 80),
		zodInvalidIntIssue([]any{"expiresInDays"}),
		zodTooSmallNumberIssue([]any{"maxUploads"}, 1),
	))
}

func TestDecodeUploadShareCreateBodyAppliesDefaultsTransformsAndNullability(t *testing.T) {
	response := httptest.NewRecorder()
	body, ok := decodeUploadShareCreateBody(
		response,
		httptest.NewRequest(
			http.MethodPost,
			"/api/upload-shares",
			strings.NewReader(`{"label":"\ufeff  shared label \u3000","maxUploads":null,"unknown":true}`),
		),
	)
	if !ok {
		t.Fatalf("valid create rejected: %s", response.Body.String())
	}
	if body.Label.Value == nil || *body.Label.Value != "shared label" {
		t.Fatalf("label = %#v, want trimmed shared label", body.Label.Value)
	}
	if body.ExpiresInDays != 30 {
		t.Fatalf("expiresInDays = %d, want default 30", body.ExpiresInDays)
	}
	if !body.MaxUploads.Present || body.MaxUploads.Value != nil {
		t.Fatalf("maxUploads = %#v, want explicitly present null", body.MaxUploads)
	}
}

func TestDecodeUploadShareCreateBodyRejectsNullLabel(t *testing.T) {
	response := httptest.NewRecorder()
	_, ok := decodeUploadShareCreateBody(
		response,
		httptest.NewRequest(
			http.MethodPost,
			"/api/upload-shares",
			strings.NewReader(`{"label":null}`),
		),
	)
	if ok {
		t.Fatal("decodeUploadShareCreateBody(null label) ok = true, want false")
	}
	expectAlbumValidationError(t, response, zodValidationMessage(
		zodInvalidTypeIssue([]any{"label"}, "string", "null"),
	))
}

func TestDecodeUploadShareUpdateBodySupportsEmptyAndExplicitNullLikeNode(t *testing.T) {
	for _, testCase := range []struct {
		name string
		body string
		want uploadShareUpdateBody
	}{
		{name: "empty object", body: `{}`},
		{
			name: "explicit nullable fields",
			body: `{"label":null,"maxUploads":null}`,
			want: uploadShareUpdateBody{
				Label:      uploadShareOptionalString{Present: true},
				MaxUploads: uploadShareOptionalInt{Present: true},
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			body, ok := decodeUploadShareUpdateBody(
				response,
				httptest.NewRequest(http.MethodPatch, "/api/upload-shares/1", strings.NewReader(testCase.body)),
			)
			if !ok {
				t.Fatalf("valid update rejected: %s", response.Body.String())
			}
			if body.Label.Present != testCase.want.Label.Present ||
				body.Label.Value != nil ||
				body.MaxUploads.Present != testCase.want.MaxUploads.Present ||
				body.MaxUploads.Value != nil || body.IsActive != nil {
				t.Fatalf("decoded body = %#v, want %#v", body, testCase.want)
			}
		})
	}
}

func TestDecodeUploadShareUpdateBodyMatchesNodeFieldErrors(t *testing.T) {
	response := httptest.NewRecorder()
	_, ok := decodeUploadShareUpdateBody(
		response,
		httptest.NewRequest(
			http.MethodPatch,
			"/api/upload-shares/1",
			strings.NewReader(`{"label":1,"isActive":null,"maxUploads":"2"}`),
		),
	)
	if ok {
		t.Fatal("decodeUploadShareUpdateBody() ok = true, want false")
	}
	expectAlbumValidationError(t, response, zodValidationMessage(
		zodInvalidTypeIssue([]any{"label"}, "string", "number"),
		zodInvalidTypeIssue([]any{"isActive"}, "boolean", "null"),
		zodInvalidTypeIssue([]any{"maxUploads"}, "number", "string"),
	))
}

func TestUploadSharePathIDMatchesNodeNumberCoercion(t *testing.T) {
	for _, testCase := range []struct {
		value     string
		want      int64
		valid     bool
		queryable bool
	}{
		{value: "42", want: 42, valid: true, queryable: true},
		{value: "42.0", want: 42, valid: true, queryable: true},
		{value: "4.2e1", want: 42, valid: true, queryable: true},
		{value: "0x2a", want: 42, valid: true, queryable: true},
		{value: "\u300042\ufeff", want: 42, valid: true, queryable: true},
		{value: "not-a-number"},
		{value: "1.5"},
		{value: "0"},
		{value: "1e20", valid: true, queryable: false},
	} {
		got, valid, queryable := uploadSharePathID(testCase.value)
		if got != testCase.want || valid != testCase.valid || queryable != testCase.queryable {
			t.Fatalf(
				"uploadSharePathID(%q) = %d, %v, %v; want %d, %v, %v",
				testCase.value, got, valid, queryable,
				testCase.want, testCase.valid, testCase.queryable,
			)
		}
	}
}

func TestUploadShareByIDUsesNodeISOStringShape(t *testing.T) {
	_, store := newWizardTestApplication(t)
	insertWizardUser(t, store.SQL(), "owner@example.test")
	token := "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
	if _, err := store.SQL().Exec(`
		INSERT INTO upload_shares(
			token_hash, token, owner_user_id, created_by_user_id,
			label, is_active, upload_count, max_uploads,
			expires_at, last_used_at, created_at, updated_at
		)
		VALUES(?, ?, 1, 1, 'share', 1, 2, 5, 1789137251, 1789137252, 1789137253, 1789137254)
	`, "hash", token); err != nil {
		t.Fatal(err)
	}

	application := &Application{database: store}
	share, err := application.uploadShareByID(t.Context(), 1)
	if err != nil {
		t.Fatalf("uploadShareByID() error = %v", err)
	}
	if got, want := *share.ExpiresAt, "2026-09-11T14:34:11.000Z"; got != want {
		t.Fatalf("ExpiresAt = %q, want %q", got, want)
	}
	if got, want := *share.LastUsedAt, "2026-09-11T14:34:12.000Z"; got != want {
		t.Fatalf("LastUsedAt = %q, want %q", got, want)
	}
	if got, want := share.CreatedAt, "2026-09-11T14:34:13.000Z"; got != want {
		t.Fatalf("CreatedAt = %q, want %q", got, want)
	}
	if got, want := share.UpdatedAt, "2026-09-11T14:34:14.000Z"; got != want {
		t.Fatalf("UpdatedAt = %q, want %q", got, want)
	}
}

func TestEnqueuePublicUploadShareTaskAtomicallyReservesQuota(t *testing.T) {
	_, store := newWizardTestApplication(t)
	insertWizardUser(t, store.SQL(), "owner@example.test")
	if _, err := store.SQL().Exec(`
		INSERT INTO upload_shares(
			id, token_hash, token, owner_user_id, created_by_user_id,
			label, is_active, upload_count, max_uploads, expires_at, created_at, updated_at
		)
		VALUES
			(91001, 'active-hash', 'active-token', 1, 1, 'active', 1, 2, 3, NULL, 1, 1),
			(91002, 'inactive-hash', 'inactive-token', 1, 1, 'inactive', 0, 4, 5, NULL, 1, 1),
			(91003, 'rollback-hash', 'rollback-token', 1, 1, 'rollback', 1, 0, 5, NULL, 1, 1)
	`); err != nil {
		t.Fatal(err)
	}

	application := &Application{database: store, now: func() time.Time { return time.Unix(100, 0) }}
	payload := map[string]any{"type": "photo", "storageKey": "users/1/guest.jpg"}
	taskID, claimed, err := application.enqueuePublicUploadShareTask(
		context.Background(), uploads.Share{ID: 91001, OwnerUserID: 1}, payload, 1, 3,
	)
	if err != nil || !claimed || taskID <= 0 {
		t.Fatalf("first enqueue = taskID:%d claimed:%v error:%v", taskID, claimed, err)
	}
	if _, claimed, err := application.enqueuePublicUploadShareTask(
		context.Background(), uploads.Share{ID: 91001, OwnerUserID: 1}, payload, 1, 3,
	); err != nil || claimed {
		t.Fatalf("quota-exhausted enqueue = claimed:%v error:%v", claimed, err)
	}
	if _, claimed, err := application.enqueuePublicUploadShareTask(
		context.Background(), uploads.Share{ID: 91002, OwnerUserID: 1}, payload, 1, 3,
	); err != nil || claimed {
		t.Fatalf("inactive enqueue = claimed:%v error:%v", claimed, err)
	}
	if _, _, err := application.enqueuePublicUploadShareTask(
		context.Background(), uploads.Share{ID: 91003, OwnerUserID: 1}, payload, 1, 0,
	); err == nil {
		t.Fatal("invalid queue insert error = nil")
	}

	for shareID, want := range map[int64]int64{91001: 3, 91002: 4, 91003: 0} {
		var count int64
		if err := store.SQL().QueryRow("SELECT upload_count FROM upload_shares WHERE id = ?", shareID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != want {
			t.Fatalf("share %d upload_count = %d, want %d", shareID, count, want)
		}
	}
	var taskCount int64
	if err := store.SQL().QueryRow("SELECT count(*) FROM pipeline_queue WHERE owner_user_id = 1").Scan(&taskCount); err != nil {
		t.Fatal(err)
	}
	if taskCount != 1 {
		t.Fatalf("pipeline task count = %d, want 1", taskCount)
	}
}
