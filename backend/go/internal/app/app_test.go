package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/swzyt/chronoframe/backend/go/internal/access"
	platformconfig "github.com/swzyt/chronoframe/backend/go/internal/platform/config"
	platformdb "github.com/swzyt/chronoframe/backend/go/internal/platform/db"
	"github.com/swzyt/chronoframe/backend/go/internal/platform/redisx"
	"github.com/swzyt/chronoframe/backend/go/internal/queue"
	"github.com/swzyt/chronoframe/backend/go/internal/settings"
)

type appSettingsRepository struct{}

func (appSettingsRepository) ListPublic(context.Context) ([]settings.Setting, error) {
	return []settings.Setting{{
		Namespace: "app", Key: "title", Type: "string",
		Value: sql.NullString{String: "ChronoFrame", Valid: true},
	}}, nil
}

type accessStateSettingsRepository struct{}

func (accessStateSettingsRepository) ListPublic(context.Context) ([]settings.Setting, error) {
	return nil, nil
}

func (accessStateSettingsRepository) Get(
	_ context.Context,
	namespace string,
	key string,
) (settings.Setting, error) {
	values := map[string]string{
		"app:access.enabled": "true",
		"app:access.version": "1",
	}
	value, ok := values[namespace+":"+key]
	if !ok {
		return settings.Setting{}, sql.ErrNoRows
	}
	return settings.Setting{
		Namespace: namespace,
		Key:       key,
		Type:      map[string]string{"access.enabled": "boolean", "access.version": "number"}[key],
		Value:     sql.NullString{String: value, Valid: true},
	}, nil
}

func TestPublicSettingsContract(t *testing.T) {
	database := newAppTestDatabase(t)
	service := settings.NewService(appSettingsRepository{})
	handler := New(Dependencies{
		Config: platformconfig.Config{BackendVersion: "test", Maturity: "experimental", Mode: "normal"},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Database: database, Settings: service,
		Now: func() time.Time { return time.UnixMilli(1_788_940_800_123) },
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/system/settings/all", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if got, want := strings.TrimSpace(response.Body.String()), `{"data":{"app":{"title":"ChronoFrame"}},"timestamp":1788940800123}`; got != want {
		t.Fatalf("body = %s, want %s", got, want)
	}
	if got := response.Header().Get("X-ChronoFrame-Backend"); got != "go" {
		t.Fatalf("X-ChronoFrame-Backend = %q", got)
	}
}

func TestMethodAndNotFoundUseH3CompatibleErrors(t *testing.T) {
	database := newAppTestDatabase(t)
	handler := New(Dependencies{
		Config: platformconfig.Config{BackendVersion: "test", Maturity: "experimental", Mode: "normal"},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Database: database,
		Settings: settings.NewService(appSettingsRepository{}),
	})
	for _, test := range []struct {
		method string
		path   string
		status int
	}{
		{http.MethodPost, "/api/system/settings/all", http.StatusMethodNotAllowed},
		{http.MethodGet, "/api/upload-shares/public/share-token/upload", http.StatusMethodNotAllowed},
		{http.MethodGet, "/missing", http.StatusNotFound},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != test.status || !strings.Contains(response.Body.String(), `"statusCode":`) {
			t.Errorf("%s %s: status=%d body=%s", test.method, test.path, response.Code, response.Body.String())
		}
	}
}

func TestReadObjectMethodAllowsGetAndHeadOnly(t *testing.T) {
	application := NewApplication(Dependencies{})
	handler := application.readObjectMethod(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	for _, method := range []string{http.MethodGet, http.MethodHead} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(method, "/image/example.png", nil))
		if response.Code != http.StatusNoContent {
			t.Fatalf("%s status = %d, body = %s", method, response.Code, response.Body.String())
		}
	}

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/image/example.png", nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, body = %s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Allow"); got != "GET, HEAD" {
		t.Fatalf("Allow = %q, want GET, HEAD", got)
	}
}

func TestRegisteredHandlersDoNotAdvertiseNotImplemented(t *testing.T) {
	for _, fileName := range []string{"app.go", "management_reads.go"} {
		source, err := os.ReadFile(fileName)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(source), "StatusNotImplemented") ||
			strings.Contains(string(source), "Not Implemented") {
			t.Fatalf("%s still exposes a 501 Not Implemented branch", fileName)
		}
	}
}

func TestSystemLogsCacheControlMatchesNodeEventStream(t *testing.T) {
	if got, want := systemLogsCacheControl, "private, no-cache, no-store, no-transform, must-revalidate, max-age=0"; got != want {
		t.Fatalf("systemLogsCacheControl = %q, want %q", got, want)
	}
}

func TestServeBinaryHeadOmitsBody(t *testing.T) {
	application := NewApplication(Dependencies{})
	response := httptest.NewRecorder()
	application.serveBinary(
		response,
		httptest.NewRequest(http.MethodHead, "/image/example.png", nil),
		[]byte("media body"),
		"image/png",
		"private, max-age=86400",
		"",
	)

	if got := response.Result().StatusCode; got != http.StatusOK {
		t.Fatalf("status = %d, body = %s", got, response.Body.String())
	}
	if got := response.Header().Get("Content-Length"); got != "10" {
		t.Fatalf("Content-Length = %q, want 10", got)
	}
	if got := response.Header().Get("Cache-Control"); got != "private, max-age=86400" {
		t.Fatalf("Cache-Control = %q, want private media cache policy", got)
	}
	if got := response.Header().Get("Vary"); got != "Cookie" {
		t.Fatalf("Vary = %q, want Cookie", got)
	}
	if response.Body.Len() != 0 {
		t.Fatalf("HEAD body length = %d, want 0", response.Body.Len())
	}
}

func TestShareOGRouteRequiresPNGSuffix(t *testing.T) {
	database := newAppTestDatabase(t)
	handler := New(Dependencies{
		Config:   platformconfig.Config{BackendVersion: "test", Maturity: "experimental", Mode: "normal"},
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Database: database,
		Settings: settings.NewService(appSettingsRepository{}),
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/share-og/photo-1", nil))

	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"message":"Image not found"`) {
		t.Fatalf("body = %s", response.Body.String())
	}
}

func TestParseMediaByteRangeSupportsClosedOpenAndSuffixRanges(t *testing.T) {
	for _, test := range []struct {
		header string
		size   int64
		start  int64
		end    int64
	}{
		{"bytes=0-9", 100, 0, 9},
		{"bytes=90-", 100, 90, 99},
		{"bytes=-10", 100, 90, 99},
		{"bytes=-200", 100, 0, 99},
		{"bytes=90-200", 100, 90, 99},
	} {
		got, message, ok := parseMediaByteRange(test.header, test.size)
		if !ok || message != "" || got.start != test.start || got.end != test.end {
			t.Fatalf("%s size=%d -> (%+v,%q,%t), want %d-%d", test.header, test.size, got, message, ok, test.start, test.end)
		}
	}
}

func TestParseMediaByteRangeRejectsInvalidAndUnsatisfiableRanges(t *testing.T) {
	for _, test := range []struct {
		header  string
		size    int64
		message string
	}{
		{"bytes=10-9", 100, "Range not satisfiable"},
		{"bytes=100-", 100, "Range not satisfiable"},
		{"bytes=-0", 100, "Range not satisfiable"},
		{"bytes=0-1,4-5", 100, "Invalid range"},
		{"items=0-1", 100, "Invalid range"},
		{"bytes=-1", 0, "Range not satisfiable"},
	} {
		got, message, ok := parseMediaByteRange(test.header, test.size)
		if ok || message != test.message || got != (parsedByteRange{}) {
			t.Fatalf("%s size=%d -> (%+v,%q,%t), want %q", test.header, test.size, got, message, ok, test.message)
		}
	}
}

func TestIfRangeAllowsRangeByETagOrHTTPDate(t *testing.T) {
	lastModified := time.Date(2026, 9, 11, 21, 3, 51, 735*int(time.Millisecond), time.UTC)
	for _, test := range []struct {
		name        string
		ifRange     string
		currentETag string
		want        bool
	}{
		{name: "absent", want: true},
		{name: "matching etag", ifRange: `W/"70-demo"`, currentETag: `W/"70-demo"`, want: true},
		{name: "stale etag", ifRange: `W/"stale"`, currentETag: `W/"70-demo"`, want: false},
		{name: "matching date", ifRange: "Fri, 11 Sep 2026 21:03:51 GMT", currentETag: `W/"70-demo"`, want: true},
		{name: "stale date", ifRange: "Fri, 11 Sep 2026 21:03:50 GMT", currentETag: `W/"70-demo"`, want: false},
		{name: "invalid date", ifRange: "not a date", currentETag: `W/"70-demo"`, want: false},
	} {
		if got := ifRangeAllowsRange(test.ifRange, test.currentETag, lastModified); got != test.want {
			t.Fatalf("%s: ifRangeAllowsRange() = %t, want %t", test.name, got, test.want)
		}
	}
}

func TestIfModifiedSinceUsesHTTPSecondPrecision(t *testing.T) {
	lastModified := time.Date(2026, 9, 11, 21, 3, 51, 735*int(time.Millisecond), time.UTC)
	if !ifModifiedSinceNotModified("Fri, 11 Sep 2026 21:03:51 GMT", lastModified) {
		t.Fatal("same-second If-Modified-Since should be not modified")
	}
	if ifModifiedSinceNotModified("Fri, 11 Sep 2026 21:03:50 GMT", lastModified) {
		t.Fatal("older If-Modified-Since should require a fresh response")
	}
}

func TestReadinessReturnsServiceUnavailableWithoutSuccessfulPreflight(t *testing.T) {
	database := newAppTestDatabase(t)
	if _, err := database.Check(context.Background()); err == nil {
		t.Fatal("Check() error = nil, want schema drift")
	}
	handler := New(Dependencies{
		Config:   platformconfig.Config{BackendVersion: "test", Maturity: "experimental", Mode: "normal"},
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Database: database,
		Settings: settings.NewService(appSettingsRepository{}),
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"status":"not_ready"`) {
		t.Fatalf("body = %s", response.Body.String())
	}
}

func TestReadinessReturnsServiceUnavailableWhenMediaToolsAreMissing(t *testing.T) {
	database := newReadyAppTestDatabase(t)
	handler := New(Dependencies{
		Config: platformconfig.Config{
			BackendVersion: "test", Maturity: "experimental", Mode: "normal",
			MediaToolPreflight: true,
		},
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Database:   database,
		MediaTools: fakeMediaToolChecker{"ffmpeg": "missing: /usr/bin/ffmpeg"},
		Settings:   settings.NewService(appSettingsRepository{}),
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health/ready", nil))

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if !strings.Contains(body, `"mediaTools":"failed"`) ||
		!strings.Contains(body, `"ffmpeg":"missing: /usr/bin/ffmpeg"`) {
		t.Fatalf("body = %s, want failed mediaTools check with missing ffmpeg", body)
	}
}

func TestReadinessCanDisableMediaToolPreflightForMinimalDeployments(t *testing.T) {
	database := newReadyAppTestDatabase(t)
	handler := New(Dependencies{
		Config: platformconfig.Config{
			BackendVersion: "test", Maturity: "experimental", Mode: "normal",
			MediaToolPreflight: false,
		},
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Database:   database,
		MediaTools: fakeMediaToolChecker{"ffmpeg": "missing: /usr/bin/ffmpeg"},
		Settings:   settings.NewService(appSettingsRepository{}),
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health/ready", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"mediaTools":"disabled"`) {
		t.Fatalf("body = %s, want disabled mediaTools check", response.Body.String())
	}
}

func TestWriteAuthErrorMatchesNodeSharedIdentityUnavailableContract(t *testing.T) {
	application := &Application{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	response := httptest.NewRecorder()
	application.writeAuthError(
		response,
		fmt.Errorf("lookup session: %w", redisx.ErrUnavailable),
	)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	want := `{"error":true,"statusCode":503,"statusMessage":"Shared identity service unavailable","message":"Shared identity service unavailable"}` + "\n"
	if response.Body.String() != want {
		t.Fatalf("body = %s, want %s", response.Body.String(), want)
	}
}

func TestAccessStateClearsInvalidSharedAccessCookieLikeNode(t *testing.T) {
	redisClient := redis.NewClient(&redis.Options{
		Addr:       "127.0.0.1:1",
		MaxRetries: -1,
	})
	t.Cleanup(func() { _ = redisClient.Close() })
	sharedState, err := redisx.NewSessionStore(redisClient, "test")
	if err != nil {
		t.Fatal(err)
	}
	settingsService := settings.NewService(accessStateSettingsRepository{})
	application := NewApplication(Dependencies{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Access:   access.NewService(settingsService, sharedState, "cf_access"),
		Settings: settingsService,
	})
	request := httptest.NewRequest(http.MethodGet, "/api/access/status", nil)
	request.AddCookie(&http.Cookie{Name: "cf_access", Value: "malformed-access-token"})
	response := httptest.NewRecorder()

	state := application.accessState(response, request, false)

	if state.Granted || !state.Enabled || !state.ClearAccessCookie {
		t.Fatalf("state = %#v, want enabled locked state with cookie cleanup", state)
	}
	want := "cf_access=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax"
	if got := response.Header().Get("Set-Cookie"); got != want {
		t.Fatalf("Set-Cookie = %q, want %q", got, want)
	}
}

func TestSharedCookieHeadersMatchNodeAttributeOrder(t *testing.T) {
	for _, test := range []struct {
		name      string
		forwarded string
		want      string
	}{
		{
			name: "http",
			want: "cf_session=opaque-token; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax",
		},
		{
			name:      "forwarded https",
			forwarded: "https",
			want:      "cf_session=opaque-token; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/login", nil)
			request.Header.Set("X-Forwarded-Proto", test.forwarded)
			response := httptest.NewRecorder()

			setCookie(response, request, "cf_session", "opaque-token", 2592000)

			if got := response.Header().Get("Set-Cookie"); got != test.want {
				t.Fatalf("Set-Cookie = %q, want %q", got, test.want)
			}
		})
	}
}

func TestQueueTaskMapIncludesClaimTokenOnlyForDetail(t *testing.T) {
	task := queue.Task{
		ID:          1,
		Payload:     map[string]any{"type": "photo"},
		Status:      "completed",
		OwnerUserID: 7,
	}

	list := queueTaskMap(task, false)
	if _, ok := list["claimToken"]; ok {
		t.Fatalf("list response includes claimToken: %#v", list)
	}

	detail := queueTaskMap(task, true)
	body, err := json.Marshal(detail)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(body); !strings.Contains(got, `"claimToken":null`) || !strings.Contains(got, `"ownerUserId":7`) {
		t.Fatalf("detail response = %s, want claimToken and ownerUserId", got)
	}
}

func TestKnownSettingValidationMirrorsNodeGlobalEnums(t *testing.T) {
	if !isKnownSettingNamespace("system") || !isKnownSettingNamespace("app") {
		t.Fatal("known setting namespaces should include Node DEFAULT_SETTINGS namespaces")
	}
	if isKnownSettingNamespace("__invalid_namespace__") {
		t.Fatal("unknown namespace accepted")
	}
	if !isKnownSettingKey("backend.readProvider") || !isKnownSettingKey("slogan") {
		t.Fatal("known setting keys should include Node global settingKeys entries")
	}
	if isKnownSettingKey("__invalid_key__") || isKnownSettingKey("") {
		t.Fatal("unknown setting key accepted")
	}
	if len(knownSettingKeys) != len(knownSettingKeyValues) {
		t.Fatalf("known setting key map has %d entries, values has %d", len(knownSettingKeys), len(knownSettingKeyValues))
	}
	for _, key := range knownSettingKeyValues {
		if !isKnownSettingKey(key) {
			t.Fatalf("knownSettingKeyValues contains %q but map rejects it", key)
		}
	}
}

func TestSettingParamValidationMessageMatchesZodEnumShape(t *testing.T) {
	got := zodEnumValidationMessage(zodEnumIssue{
		path:   []any{"provider"},
		values: []string{"node", "go"},
	})
	want := `[
  {
    "code": "invalid_value",
    "values": [
      "node",
      "go"
    ],
    "path": [
      "provider"
    ],
    "message": "Invalid option: expected one of \"node\"|\"go\""
  }
]`
	if got != want {
		t.Fatalf("message = %s, want %s", got, want)
	}
}

func TestSettingValidationMessageSupportsZodNestedPathsAndTypes(t *testing.T) {
	got := zodValidationMessage(
		zodEnumValidationIssue(zodEnumIssue{
			path:   []any{"updates", 0, "namespace"},
			values: []string{"node", "go"},
		}),
		zodInvalidTypeIssue([]any{"updates", 0, "value"}, "nonoptional", "undefined"),
	)
	want := `[
  {
    "code": "invalid_value",
    "values": [
      "node",
      "go"
    ],
    "path": [
      "updates",
      0,
      "namespace"
    ],
    "message": "Invalid option: expected one of \"node\"|\"go\""
  },
  {
    "code": "invalid_type",
    "expected": "nonoptional",
    "path": [
      "updates",
      0,
      "value"
    ],
    "message": "Invalid input: expected nonoptional, received undefined"
  }
]`
	if got != want {
		t.Fatalf("message = %s, want %s", got, want)
	}
}

func TestSettingValidationMessageSupportsZodExpectedFirstTypeIssue(t *testing.T) {
	got := zodValidationMessage(zodInvalidTypeIssue([]any{"updates"}, "array", "object"))
	want := `[
  {
    "expected": "array",
    "code": "invalid_type",
    "path": [
      "updates"
    ],
    "message": "Invalid input: expected array, received object"
  }
]`
	if got != want {
		t.Fatalf("message = %s, want %s", got, want)
	}
}

func TestSettingValidationMessageSupportsZodTooSmallStringIssue(t *testing.T) {
	got := zodValidationMessage(zodTooSmallStringIssue([]any{"namespace"}, 1))
	want := `[
  {
    "origin": "string",
    "code": "too_small",
    "minimum": 1,
    "inclusive": true,
    "path": [
      "namespace"
    ],
    "message": "Too small: expected string to have >=1 characters"
  }
]`
	if got != want {
		t.Fatalf("message = %s, want %s", got, want)
	}
}

func newAppTestDatabase(t *testing.T) *platformdb.Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "app.sqlite3")
	dsn, err := platformdb.SQLiteDSN(path, false)
	if err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open(platformdb.DriverName, dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`CREATE TABLE placeholder (id INTEGER)`); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := platformdb.Open(context.Background(), path, platformdb.Options{
		ReadOnly: true, ExpectedMigrations: []platformdb.Migration{},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func newReadyAppTestDatabase(t *testing.T) *platformdb.Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ready.sqlite3")
	store, err := platformdb.Open(context.Background(), path, platformdb.Options{
		ReadOnly: false, RequireWAL: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Migrate(context.Background()); err != nil {
		_ = store.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

type fakeMediaToolChecker map[string]string

func (checker fakeMediaToolChecker) Check(context.Context) map[string]string {
	failures := map[string]string{}
	for key, value := range checker {
		failures[key] = value
	}
	return failures
}
