package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	platformconfig "github.com/swzyt/chronoframe/backend/go/internal/platform/config"
	platformdb "github.com/swzyt/chronoframe/backend/go/internal/platform/db"
	"github.com/swzyt/chronoframe/backend/go/internal/settings"
)

func TestWizardMapValidationMirrorsNodeSchema(t *testing.T) {
	handler, store := newWizardTestApplication(t)
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "maplibre token is required", body: `{"provider":"maplibre"}`},
		{name: "unknown provider is rejected", body: `{"provider":"terrain","token":"x"}`},
		{name: "amap security code is required", body: `{"provider":"amap","key":"x"}`},
		{name: "optional style must be a string", body: `{"provider":"mapbox","token":"x","style":42}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := postWizardJSON(t, handler, "/api/wizard/map", test.body)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
		})
	}

	response := postWizardJSON(t, handler, "/api/wizard/map", `{"provider":"maplibre","token":"token","style":"style"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if got := settingValue(t, store.SQL(), "map", "provider"); got != "maplibre" {
		t.Fatalf("map.provider = %q, want maplibre", got)
	}
	if got := settingValue(t, store.SQL(), "map", "maplibre.token"); got != "token" {
		t.Fatalf("maplibre.token = %q, want token", got)
	}
	if got := settingValue(t, store.SQL(), "map", "maplibre.style"); got != "style" {
		t.Fatalf("maplibre.style = %q, want style", got)
	}
}

func TestWizardStorageValidationNormalizesNodeDefaults(t *testing.T) {
	handler, store := newWizardTestApplication(t)
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "local basePath is required", body: `{"name":"local","config":{"provider":"local"}}`},
		{name: "s3 required string fields are required", body: `{"name":"s3","config":{"provider":"s3","endpoint":"","accessKeyId":"","secretAccessKey":""}}`},
		{name: "openlist token is required", body: `{"name":"openlist","config":{"provider":"openlist","baseUrl":"https://files.example","rootPath":"/"}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := postWizardJSON(t, handler, "/api/wizard/storage", test.body)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
		})
	}

	response := postWizardJSON(t, handler, "/api/wizard/storage", `{
		"name": "s3",
		"config": {
			"provider": "s3",
			"bucket": "",
			"endpoint": "",
			"accessKeyId": "",
			"secretAccessKey": "",
			"ignored": true
		}
	}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}

	config := storageProviderConfig(t, store.SQL(), 1)
	if got := config["provider"]; got != "s3" {
		t.Fatalf("provider = %#v, want s3", got)
	}
	if got := config["region"]; got != "auto" {
		t.Fatalf("region = %#v, want auto", got)
	}
	if got := config["prefix"]; got != "/photos" {
		t.Fatalf("prefix = %#v, want /photos", got)
	}
	if _, ok := config["ignored"]; ok {
		t.Fatalf("normalized storage config kept unknown field: %#v", config)
	}
	if got := settingValue(t, store.SQL(), "storage", "provider"); got != "1" {
		t.Fatalf("storage.provider = %q, want 1", got)
	}
}

func TestWizardSchemaQueryValidationMatchesNodeZod(t *testing.T) {
	handler, _ := newWizardTestApplication(t)
	for _, test := range []struct {
		name    string
		path    string
		message string
	}{
		{
			name:    "missing namespace",
			path:    "/api/wizard/schema",
			message: "Invalid input: expected string, received undefined",
		},
		{
			name:    "empty namespace",
			path:    "/api/wizard/schema?namespace=",
			message: "Too small: expected string to have >=1 characters",
		},
		{
			name:    "repeated namespace",
			path:    "/api/wizard/schema?namespace=system&namespace=app",
			message: "Invalid input: expected string, received array",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := getWizard(t, handler, test.path)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			var body struct {
				StatusMessage string `json:"statusMessage"`
				Message       string `json:"message"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(body.Message, test.message) || body.StatusMessage != "Validation Error" {
				t.Fatalf("body = %s, want Zod validation message %q", response.Body.String(), test.message)
			}
		})
	}
}

func TestWizardSchemaPreservesNodeNamespaceSemantics(t *testing.T) {
	handler, _ := newWizardTestApplication(t)
	for _, namespace := range []string{"%20", "not-a-setting-namespace"} {
		response := getWizard(t, handler, "/api/wizard/schema?namespace="+namespace)
		if response.Code != http.StatusOK {
			t.Fatalf("namespace %q status = %d, body = %s", namespace, response.Code, response.Body.String())
		}
		var body struct {
			Namespace string           `json:"namespace"`
			Fields    []map[string]any `json:"fields"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if len(body.Fields) != 0 {
			t.Fatalf("namespace %q fields = %#v, want empty", namespace, body.Fields)
		}
	}
}

func TestWizardSchemaReturnsFullNodeStorageContract(t *testing.T) {
	handler, _ := newWizardTestApplication(t)
	response := getWizard(t, handler, "/api/wizard/schema?namespace=storage")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body struct {
		Namespace string           `json:"namespace"`
		Fields    []map[string]any `json:"fields"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Namespace != "storage" || len(body.Fields) != 24 {
		t.Fatalf("storage schema = namespace:%q fields:%d, want storage/24", body.Namespace, len(body.Fields))
	}
	fields := fieldsByKey(body.Fields)
	for _, key := range []string{
		"local.basePath",
		"s3.secretAccessKey",
		"s3.forcePathStyle",
		"s3.maxKeys",
		"openlist.token",
		"openlist.pathField",
	} {
		if fields[key] == nil {
			t.Fatalf("storage schema is missing %q", key)
		}
		if fields[key]["namespace"] != "storage" {
			t.Fatalf("storage field %q namespace = %#v", key, fields[key]["namespace"])
		}
	}
	secretUI, _ := fields["s3.secretAccessKey"]["ui"].(map[string]any)
	if secretUI["type"] != "password" || fields["s3.secretAccessKey"]["value"] != "" {
		t.Fatalf("S3 secret field = %#v", fields["s3.secretAccessKey"])
	}
	if fields["s3.maxKeys"]["defaultValue"] != float64(1000) {
		t.Fatalf("s3.maxKeys default = %#v", fields["s3.maxKeys"]["defaultValue"])
	}
}

func TestWizardSchemaUsesCustomMapSelectorAndRedactsSecrets(t *testing.T) {
	handler, store := newWizardTestApplication(t)
	if _, err := store.SQL().Exec(`
		UPDATE settings
		SET value = 'persisted-secret', default_value = 'default-secret'
		WHERE namespace = 'map' AND key = 'mapbox.token'
	`); err != nil {
		t.Fatal(err)
	}
	response := getWizard(t, handler, "/api/wizard/schema?namespace=map")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body struct {
		Fields []map[string]any `json:"fields"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	fields := fieldsByKey(body.Fields)
	providerUI, _ := fields["provider"]["ui"].(map[string]any)
	options, _ := providerUI["options"].([]any)
	if providerUI["type"] != "custom" || len(options) != 3 {
		t.Fatalf("map provider UI = %#v", providerUI)
	}
	secret := fields["mapbox.token"]
	if secret["value"] != "" || secret["defaultValue"] != "" {
		t.Fatalf("map secret was not redacted: %#v", secret)
	}
}

func TestWizardSubmitRejectsDifferentExistingUserBeforeSideEffects(t *testing.T) {
	handler, store := newWizardTestApplication(t)
	insertWizardUser(t, store.SQL(), "owner@example.com")

	response := postWizardJSON(t, handler, "/api/wizard/submit", validWizardSubmitBody("other@example.com"))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "User already exists") {
		t.Fatalf("body = %s, want User already exists", response.Body.String())
	}
	if got := settingValue(t, store.SQL(), "system", "firstLaunch"); got != "true" {
		t.Fatalf("system.firstLaunch = %q, want true", got)
	}
	if got := settingValue(t, store.SQL(), "app", "title"); got != "ChronoFrame" {
		t.Fatalf("app.title = %q, want default ChronoFrame", got)
	}
	var providerCount int
	if err := store.SQL().QueryRow(`SELECT count(*) FROM settings_storage_providers`).Scan(&providerCount); err != nil {
		t.Fatal(err)
	}
	if providerCount != 0 {
		t.Fatalf("storage provider count = %d, want 0", providerCount)
	}
}

func TestWizardSubmitMatchesNodeExactExistingEmailComparison(t *testing.T) {
	handler, store := newWizardTestApplication(t)
	insertWizardUser(t, store.SQL(), "Owner@example.com")

	response := postWizardJSON(t, handler, "/api/wizard/submit", validWizardSubmitBody("owner@example.com"))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "User already exists") {
		t.Fatalf("body = %s, want User already exists", response.Body.String())
	}
}

func TestWizardSubmitPersistsFullSetup(t *testing.T) {
	handler, store := newWizardTestApplication(t)
	response := postWizardJSON(t, handler, "/api/wizard/submit", `{
		"admin": {
			"email": "setup@example.com",
			"password": "secret1",
			"username": "owner"
		},
		"site": {
			"title": "Custom ChronoFrame",
			"author": "Go Backend"
		},
		"storage": {
			"name": "openlist",
			"config": {
				"provider": "openlist",
				"baseUrl": "https://files.example",
				"rootPath": "/photos",
				"token": "token"
			}
		},
		"map": {
			"provider": "amap",
			"key": "amap-key",
			"securityJsCode": "security-code"
		}
	}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}

	var (
		email    string
		username string
		isAdmin  int64
		isActive int64
	)
	if err := store.SQL().QueryRow(`
		SELECT email, name, is_admin, is_active
		FROM users
		WHERE id = 1
	`).Scan(&email, &username, &isAdmin, &isActive); err != nil {
		t.Fatal(err)
	}
	if email != "setup@example.com" || username != "owner" || isAdmin != 1 || isActive != 1 {
		t.Fatalf("admin row = email:%q username:%q isAdmin:%d isActive:%d", email, username, isAdmin, isActive)
	}
	if got := settingValue(t, store.SQL(), "system", "firstLaunch"); got != "false" {
		t.Fatalf("system.firstLaunch = %q, want false", got)
	}
	if got := settingValue(t, store.SQL(), "app", "title"); got != "Custom ChronoFrame" {
		t.Fatalf("app.title = %q, want Custom ChronoFrame", got)
	}
	if got := settingValue(t, store.SQL(), "app", "author"); got != "Go Backend" {
		t.Fatalf("app.author = %q, want Go Backend", got)
	}
	if got := settingValue(t, store.SQL(), "map", "provider"); got != "amap" {
		t.Fatalf("map.provider = %q, want amap", got)
	}
	if got := settingValue(t, store.SQL(), "map", "amap.key"); got != "amap-key" {
		t.Fatalf("map.amap.key = %q, want amap-key", got)
	}
	if got := settingValue(t, store.SQL(), "map", "amap.securityJsCode"); got != "security-code" {
		t.Fatalf("map.amap.securityJsCode = %q, want security-code", got)
	}
	if got := settingValue(t, store.SQL(), "storage", "provider"); got != "1" {
		t.Fatalf("storage.provider = %q, want 1", got)
	}
	for _, setting := range [][2]string{
		{"app", "title"},
		{"app", "author"},
		{"storage", "provider"},
		{"map", "provider"},
		{"map", "amap.key"},
		{"map", "amap.securityJsCode"},
		{"system", "firstLaunch"},
	} {
		var updatedBy sql.NullInt64
		if err := store.SQL().QueryRow(`
			SELECT updated_by FROM settings WHERE namespace = ? AND key = ?
		`, setting[0], setting[1]).Scan(&updatedBy); err != nil {
			t.Fatal(err)
		}
		if updatedBy.Valid {
			t.Fatalf("%s.%s updated_by = %d, want NULL to match Node wizard", setting[0], setting[1], updatedBy.Int64)
		}
	}

	config := storageProviderConfig(t, store.SQL(), 1)
	for key, want := range map[string]string{
		"provider":       "openlist",
		"baseUrl":        "https://files.example",
		"rootPath":       "/photos",
		"token":          "token",
		"uploadEndpoint": "/api/fs/put",
		"deleteEndpoint": "/api/fs/remove",
		"metaEndpoint":   "/api/fs/get",
		"pathField":      "path",
	} {
		if got := config[key]; got != want {
			t.Fatalf("openlist config %s = %#v, want %q", key, got, want)
		}
	}
}

func newWizardTestApplication(t *testing.T) (http.Handler, *platformdb.Store) {
	t.Helper()
	ctx := context.Background()
	store, err := platformdb.Open(ctx, filepath.Join(t.TempDir(), "wizard.sqlite3"), platformdb.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if _, err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	repository := settings.NewSQLiteRepository(store.SQL())
	if err := repository.InitDefaults(ctx, settings.DefaultSettings); err != nil {
		t.Fatalf("InitDefaults() error = %v", err)
	}
	handler := New(Dependencies{
		Config:   platformconfig.Config{BackendVersion: "test", Maturity: "experimental", Mode: "normal"},
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Database: store,
		Settings: settings.NewService(repository),
		Now:      func() time.Time { return time.UnixMilli(1_789_137_245_151) },
	})
	return handler, store
}

func postWizardJSON(t *testing.T, handler http.Handler, path string, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func getWizard(t *testing.T, handler http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func fieldsByKey(fields []map[string]any) map[string]map[string]any {
	result := make(map[string]map[string]any, len(fields))
	for _, field := range fields {
		key, _ := field["key"].(string)
		result[key] = field
	}
	return result
}

func validWizardSubmitBody(email string) string {
	return `{
		"admin": {
			"email": "` + email + `",
			"password": "secret1",
			"username": "owner"
		},
		"site": {
			"title": "Custom ChronoFrame"
		},
		"storage": {
			"name": "local",
			"config": {
				"provider": "local",
				"basePath": "/data"
			}
		},
		"map": {
			"provider": "maplibre",
			"token": "map-token"
		}
	}`
}

func insertWizardUser(t *testing.T, database *sql.DB, email string) {
	t.Helper()
	if _, err := database.Exec(`
		INSERT INTO users(name,email,password,created_at,is_admin,is_active,auth_version)
		VALUES('owner',?, '$2a$10$placeholder', unixepoch(), 1, 1, 1)
	`, email); err != nil {
		t.Fatal(err)
	}
}

func settingValue(t *testing.T, database *sql.DB, namespace string, key string) string {
	t.Helper()
	var value sql.NullString
	if err := database.QueryRow(`
		SELECT value
		FROM settings
		WHERE namespace = ? AND key = ?
	`, namespace, key).Scan(&value); err != nil {
		t.Fatal(err)
	}
	if !value.Valid {
		return ""
	}
	return value.String
}

func storageProviderConfig(t *testing.T, database *sql.DB, id int64) map[string]any {
	t.Helper()
	var raw string
	if err := database.QueryRow(`
		SELECT config
		FROM settings_storage_providers
		WHERE id = ?
	`, id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		t.Fatal(err)
	}
	return config
}
