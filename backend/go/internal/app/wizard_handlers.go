package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/auth"
	"github.com/swzyt/chronoframe/backend/go/internal/platform/httpx"
	"github.com/swzyt/chronoframe/backend/go/internal/settings"
)

type wizardAdminBody struct {
	Email    *string `json:"email"`
	Password *string `json:"password"`
	Username *string `json:"username"`
}

type wizardAdminConfig struct {
	Email    string
	Password string
	Username string
}

type wizardSiteBody struct {
	Title     *string `json:"title"`
	Slogan    *string `json:"slogan"`
	AvatarURL *string `json:"avatarUrl"`
	Author    *string `json:"author"`
}

type wizardSiteConfig struct {
	Title     string
	Slogan    *string
	AvatarURL *string
	Author    *string
}

type wizardStorageBody struct {
	Name   *string        `json:"name"`
	Config map[string]any `json:"config"`
}

type wizardStorageConfig struct {
	Name     string
	Provider string
	Config   map[string]any
}

type wizardMapConfig struct {
	Provider       string
	Token          string
	Style          *string
	Key            string
	SecurityJSCode string
}

func (a *Application) wizardAvailable(ctx context.Context) bool {
	if a.settings == nil {
		return false
	}
	row, err := a.settings.Value(ctx, "system", "firstLaunch")
	if err != nil {
		return false
	}
	value, ok := settings.BooleanValue(row.Value)
	return ok && value
}

func (a *Application) requireWizard(w http.ResponseWriter, r *http.Request) bool {
	if !a.wizardAvailable(r.Context()) {
		httpx.Error(w, http.StatusForbidden, "Setup is already complete")
		return false
	}
	return true
}

func (a *Application) wizardAdmin(w http.ResponseWriter, r *http.Request) {
	if !a.requireWizard(w, r) {
		return
	}
	body, ok := decodeWizardObject(w, r)
	if !ok {
		return
	}
	admin, issues := decodeWizardAdmin(body, nil)
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return
	}
	_, err := a.persistWizardAdmin(r.Context(), admin)
	if errors.Is(err, errWizardUserExists) {
		httpx.Error(w, http.StatusBadRequest, "User already exists")
		return
	}
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "User could not be created")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *Application) wizardComplete(w http.ResponseWriter, r *http.Request) {
	if !a.requireWizard(w, r) {
		return
	}
	if _, err := a.setSetting(r.Context(), "system", "firstLaunch", false, nil, true); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *Application) wizardSite(w http.ResponseWriter, r *http.Request) {
	if !a.requireWizard(w, r) {
		return
	}
	body, ok := decodeWizardObject(w, r)
	if !ok {
		return
	}
	site, issues := decodeWizardSite(body, nil)
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return
	}
	if err := a.persistWizardSite(r.Context(), site, nil); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *Application) wizardMap(w http.ResponseWriter, r *http.Request) {
	if !a.requireWizard(w, r) {
		return
	}
	body, ok := decodeWizardObject(w, r)
	if !ok {
		return
	}
	config, issues := decodeWizardMap(body, nil)
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return
	}
	if err := a.persistWizardMap(r.Context(), config, nil); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *Application) wizardStorage(w http.ResponseWriter, r *http.Request) {
	if !a.requireWizard(w, r) {
		return
	}
	body, ok := decodeWizardObject(w, r)
	if !ok {
		return
	}
	storage, issues := decodeWizardStorage(body, nil)
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return
	}
	id, err := a.persistWizardStorage(r.Context(), storage, nil)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "Storage configuration could not be created")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"success": true, "id": id})
}

func (a *Application) wizardSubmit(w http.ResponseWriter, r *http.Request) {
	if !a.requireWizard(w, r) {
		return
	}
	body, ok := decodeWizardObject(w, r)
	if !ok {
		return
	}
	admin, site, storage, mapConfig, issues := decodeWizardSubmit(body)
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return
	}

	adminID, err := a.persistWizardAdmin(r.Context(), admin)
	if errors.Is(err, errWizardUserExists) {
		httpx.Error(w, http.StatusBadRequest, "User already exists")
		return
	}
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "User could not be created")
		return
	}
	if err := a.persistWizardSite(r.Context(), site, nil); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if _, err := a.persistWizardStorage(r.Context(), storage, nil); err != nil {
		httpx.Error(w, http.StatusBadRequest, "Storage configuration could not be created")
		return
	}
	if err := a.persistWizardMap(r.Context(), mapConfig, nil); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if _, err := a.setSetting(r.Context(), "system", "firstLaunch", false, nil, true); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if a.auth != nil {
		if repository, ok := a.auth.IdentityRepository(); ok {
			if user, userErr := repository.FindByID(r.Context(), adminID); userErr == nil {
				if token, issueErr := issueSession(r.Context(), a.auth.SessionStore(), user, a.now()); issueErr == nil {
					setCookie(w, r, a.auth.SessionCookieName(), token, int(sharedSessionTTL/time.Second))
				}
			}
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"success": true})
}

var errWizardUserExists = errors.New("wizard user already exists")

func decodeWizardObject(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	var raw json.RawMessage
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	decoder.UseNumber()
	if err := decodeSingleJSONValue(decoder, &raw); err != nil {
		if errors.Is(err, io.EOF) {
			writeMissingObjectBodyZodValidationError(w)
		} else {
			writeInvalidJSONBody(w)
		}
		return nil, false
	}
	if zodReceivedType(raw) != "object" {
		writeSettingZodValidationError(w, zodInvalidTypeIssue([]any{}, "object", zodReceivedType(raw)))
		return nil, false
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		writeInvalidJSONBody(w)
		return nil, false
	}
	return object, true
}

func decodeWizardSubmit(
	body map[string]json.RawMessage,
) (wizardAdminConfig, wizardSiteConfig, wizardStorageConfig, wizardMapConfig, []zodValidationIssue) {
	var issues []zodValidationIssue
	adminObject, adminIssues := wizardNestedObject(body, "admin", false)
	issues = append(issues, adminIssues...)
	var admin wizardAdminConfig
	if len(adminIssues) == 0 {
		admin, adminIssues = decodeWizardAdmin(adminObject, []any{"admin"})
		issues = append(issues, adminIssues...)
	}

	siteObject, siteIssues := wizardNestedObject(body, "site", false)
	issues = append(issues, siteIssues...)
	var site wizardSiteConfig
	if len(siteIssues) == 0 {
		site, siteIssues = decodeWizardSite(siteObject, []any{"site"})
		issues = append(issues, siteIssues...)
	}

	storageObject, storageIssues := wizardNestedObject(body, "storage", false)
	issues = append(issues, storageIssues...)
	var storage wizardStorageConfig
	if len(storageIssues) == 0 {
		storage, storageIssues = decodeWizardStorage(storageObject, []any{"storage"})
		issues = append(issues, storageIssues...)
	}

	mapObject, mapIssues := wizardNestedObject(body, "map", true)
	issues = append(issues, mapIssues...)
	var mapConfig wizardMapConfig
	if len(mapIssues) == 0 {
		mapConfig, mapIssues = decodeWizardMap(mapObject, []any{"map"})
		issues = append(issues, mapIssues...)
	}
	return admin, site, storage, mapConfig, issues
}

func wizardNestedObject(
	body map[string]json.RawMessage,
	field string,
	codeFirst bool,
) (map[string]json.RawMessage, []zodValidationIssue) {
	raw := body[field]
	if zodReceivedType(raw) != "object" {
		issue := zodInvalidTypeIssue([]any{field}, "object", zodReceivedType(raw))
		if codeFirst {
			issue = zodInvalidTypeCodeFirstIssue([]any{field}, "object", zodReceivedType(raw))
		}
		return nil, []zodValidationIssue{issue}
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, []zodValidationIssue{zodInvalidTypeIssue([]any{field}, "object", zodReceivedType(raw))}
	}
	return object, nil
}

func decodeWizardAdmin(
	body map[string]json.RawMessage,
	prefix []any,
) (wizardAdminConfig, []zodValidationIssue) {
	var issues []zodValidationIssue
	email, emailOK := wizardRequiredString(body, "email", 0, prefix, &issues)
	if emailOK && !validZodEmail(email) {
		issues = append(issues, zodInvalidFormatIssue(
			wizardPath(prefix, "email"),
			"email",
			zodEmailPatternMessage,
			"Invalid email address",
		))
	}
	password, _ := wizardRequiredString(body, "password", 6, prefix, &issues)
	username := "admin"
	if _, exists := body["username"]; exists {
		if value, ok := wizardRequiredString(body, "username", 2, prefix, &issues); ok {
			username = value
		}
	}
	return wizardAdminConfig{Email: email, Password: password, Username: username}, issues
}

func decodeWizardSite(
	body map[string]json.RawMessage,
	prefix []any,
) (wizardSiteConfig, []zodValidationIssue) {
	var issues []zodValidationIssue
	title, _ := wizardRequiredString(body, "title", 1, prefix, &issues)
	slogan := wizardOptionalString(body, "slogan", prefix, &issues)
	avatarURL := wizardOptionalString(body, "avatarUrl", prefix, &issues)
	author := wizardOptionalString(body, "author", prefix, &issues)
	return wizardSiteConfig{Title: title, Slogan: slogan, AvatarURL: avatarURL, Author: author}, issues
}

func decodeWizardStorage(
	body map[string]json.RawMessage,
	prefix []any,
) (wizardStorageConfig, []zodValidationIssue) {
	var issues []zodValidationIssue
	name, _ := wizardRequiredString(body, "name", 1, prefix, &issues)
	configPath := wizardPath(prefix, "config")
	rawConfig := body["config"]
	if zodReceivedType(rawConfig) != "object" {
		issues = append(issues, zodInvalidTypeCodeFirstIssue(configPath, "object", zodReceivedType(rawConfig)))
		return wizardStorageConfig{}, issues
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rawConfig, &raw); err != nil {
		issues = append(issues, zodInvalidTypeCodeFirstIssue(configPath, "object", zodReceivedType(rawConfig)))
		return wizardStorageConfig{}, issues
	}
	provider, configIssues := decodeWizardStorageConfig(raw, configPath)
	issues = append(issues, configIssues...)
	if len(issues) > 0 {
		return wizardStorageConfig{}, issues
	}
	var values map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(rawConfig)))
	decoder.UseNumber()
	if err := decoder.Decode(&values); err != nil {
		return wizardStorageConfig{}, []zodValidationIssue{zodInvalidTypeCodeFirstIssue(configPath, "object", "undefined")}
	}
	_, normalized, ok := validateWizardStorageConfig(values)
	if !ok {
		return wizardStorageConfig{}, []zodValidationIssue{zodCustomIssue(configPath, "Invalid input")}
	}
	return wizardStorageConfig{Name: name, Provider: provider, Config: normalized}, nil
}

func decodeWizardStorageConfig(
	body map[string]json.RawMessage,
	prefix []any,
) (string, []zodValidationIssue) {
	provider, ok := wizardRawString(body["provider"])
	if !ok || (provider != "s3" && provider != "local" && provider != "openlist") {
		return "", []zodValidationIssue{zodInvalidDiscriminatorIssue(
			wizardPath(prefix, "provider"), "provider", "s3", "local", "openlist",
		)}
	}
	var issues []zodValidationIssue
	switch provider {
	case "local":
		wizardRequiredString(body, "basePath", 1, prefix, &issues)
		wizardOptionalString(body, "baseUrl", prefix, &issues)
		wizardOptionalString(body, "prefix", prefix, &issues)
	case "s3":
		wizardRequiredString(body, "bucket", 0, prefix, &issues)
		wizardOptionalDefaultString(body, "region", prefix, &issues)
		wizardRequiredString(body, "endpoint", 0, prefix, &issues)
		wizardOptionalDefaultString(body, "prefix", prefix, &issues)
		wizardOptionalString(body, "cdnUrl", prefix, &issues)
		wizardRequiredString(body, "accessKeyId", 0, prefix, &issues)
		wizardRequiredString(body, "secretAccessKey", 0, prefix, &issues)
		wizardOptionalBoolean(body, "forcePathStyle", prefix, &issues)
		wizardOptionalNumber(body, "maxKeys", prefix, &issues)
	case "openlist":
		wizardRequiredString(body, "baseUrl", 1, prefix, &issues)
		wizardRequiredString(body, "rootPath", 1, prefix, &issues)
		wizardRequiredString(body, "token", 1, prefix, &issues)
		for _, field := range []string{"uploadEndpoint", "downloadEndpoint", "listEndpoint", "deleteEndpoint", "metaEndpoint", "pathField", "cdnUrl"} {
			wizardOptionalString(body, field, prefix, &issues)
		}
	}
	return provider, issues
}

func decodeWizardMap(
	body map[string]json.RawMessage,
	prefix []any,
) (wizardMapConfig, []zodValidationIssue) {
	provider, ok := wizardRawString(body["provider"])
	if !ok || (provider != "mapbox" && provider != "maplibre" && provider != "amap") {
		return wizardMapConfig{}, []zodValidationIssue{zodInvalidDiscriminatorIssue(
			wizardPath(prefix, "provider"), "provider", "mapbox", "maplibre", "amap",
		)}
	}
	var issues []zodValidationIssue
	if provider == "amap" {
		key, _ := wizardRequiredString(body, "key", 1, prefix, &issues)
		securityJSCode, _ := wizardRequiredString(body, "securityJsCode", 1, prefix, &issues)
		return wizardMapConfig{Provider: provider, Key: key, SecurityJSCode: securityJSCode}, issues
	}
	token, _ := wizardRequiredString(body, "token", 1, prefix, &issues)
	style := wizardOptionalString(body, "style", prefix, &issues)
	return wizardMapConfig{Provider: provider, Token: token, Style: style}, issues
}

func wizardRequiredString(
	body map[string]json.RawMessage,
	field string,
	minimum int,
	prefix []any,
	issues *[]zodValidationIssue,
) (string, bool) {
	raw := body[field]
	value, ok := wizardRawString(raw)
	if !ok {
		*issues = append(*issues, zodInvalidTypeIssue(wizardPath(prefix, field), "string", zodReceivedType(raw)))
		return "", false
	}
	if jsStringLength(value) < minimum {
		*issues = append(*issues, zodTooSmallStringIssue(wizardPath(prefix, field), minimum))
		return value, false
	}
	return value, true
}

func wizardOptionalString(
	body map[string]json.RawMessage,
	field string,
	prefix []any,
	issues *[]zodValidationIssue,
) *string {
	raw, exists := body[field]
	if !exists {
		return nil
	}
	value, ok := wizardRawString(raw)
	if !ok {
		*issues = append(*issues, zodInvalidTypeIssue(wizardPath(prefix, field), "string", zodReceivedType(raw)))
		return nil
	}
	return &value
}

func wizardOptionalDefaultString(
	body map[string]json.RawMessage,
	field string,
	prefix []any,
	issues *[]zodValidationIssue,
) {
	if _, exists := body[field]; exists {
		wizardOptionalString(body, field, prefix, issues)
	}
}

func wizardOptionalBoolean(
	body map[string]json.RawMessage,
	field string,
	prefix []any,
	issues *[]zodValidationIssue,
) {
	raw, exists := body[field]
	if exists && zodReceivedType(raw) != "boolean" {
		*issues = append(*issues, zodInvalidTypeIssue(wizardPath(prefix, field), "boolean", zodReceivedType(raw)))
	}
}

func wizardOptionalNumber(
	body map[string]json.RawMessage,
	field string,
	prefix []any,
	issues *[]zodValidationIssue,
) {
	raw, exists := body[field]
	if exists && zodReceivedType(raw) != "number" {
		*issues = append(*issues, zodInvalidTypeIssue(wizardPath(prefix, field), "number", zodReceivedType(raw)))
	}
}

func wizardRawString(raw json.RawMessage) (string, bool) {
	if zodReceivedType(raw) != "string" {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func wizardPath(prefix []any, field string) []any {
	path := append([]any(nil), prefix...)
	return append(path, field)
}

func validateWizardAdmin(body wizardAdminBody) (wizardAdminConfig, bool) {
	if body.Email == nil || body.Password == nil {
		return wizardAdminConfig{}, false
	}
	email := *body.Email
	password := *body.Password
	if !validWizardEmail(email) || len(password) < 6 {
		return wizardAdminConfig{}, false
	}
	username := "admin"
	if body.Username != nil {
		username = *body.Username
	}
	if len(username) < 2 {
		return wizardAdminConfig{}, false
	}
	return wizardAdminConfig{Email: email, Password: password, Username: username}, true
}

func validateWizardSite(body wizardSiteBody) (wizardSiteConfig, bool) {
	if body.Title == nil || len(*body.Title) < 1 {
		return wizardSiteConfig{}, false
	}
	return wizardSiteConfig{
		Title:     *body.Title,
		Slogan:    body.Slogan,
		AvatarURL: body.AvatarURL,
		Author:    body.Author,
	}, true
}

func validateWizardStorage(body wizardStorageBody) (wizardStorageConfig, bool) {
	if body.Name == nil || len(*body.Name) < 1 || body.Config == nil {
		return wizardStorageConfig{}, false
	}
	provider, normalized, ok := validateWizardStorageConfig(body.Config)
	if !ok {
		return wizardStorageConfig{}, false
	}
	return wizardStorageConfig{Name: *body.Name, Provider: provider, Config: normalized}, true
}

func validateWizardMap(body map[string]any) (wizardMapConfig, bool) {
	provider, ok := stringField(body, "provider")
	if !ok {
		return wizardMapConfig{}, false
	}
	switch provider {
	case "mapbox", "maplibre":
		token, ok := minStringField(body, "token", 1)
		if !ok {
			return wizardMapConfig{}, false
		}
		style, ok := optionalStringField(body, "style")
		if !ok {
			return wizardMapConfig{}, false
		}
		return wizardMapConfig{Provider: provider, Token: token, Style: style}, true
	case "amap":
		key, ok := minStringField(body, "key", 1)
		if !ok {
			return wizardMapConfig{}, false
		}
		securityJSCode, ok := minStringField(body, "securityJsCode", 1)
		if !ok {
			return wizardMapConfig{}, false
		}
		return wizardMapConfig{Provider: provider, Key: key, SecurityJSCode: securityJSCode}, true
	default:
		return wizardMapConfig{}, false
	}
}

func validateWizardStorageConfig(input map[string]any) (string, map[string]any, bool) {
	provider, ok := stringField(input, "provider")
	if !ok {
		return "", nil, false
	}
	normalized := map[string]any{"provider": provider}
	switch provider {
	case "local":
		basePath, ok := minStringField(input, "basePath", 1)
		if !ok {
			return "", nil, false
		}
		normalized["basePath"] = basePath
		if !copyOptionalString(normalized, input, "baseUrl") || !copyOptionalString(normalized, input, "prefix") {
			return "", nil, false
		}
	case "s3":
		for _, key := range []string{"bucket", "endpoint", "accessKeyId", "secretAccessKey"} {
			value, ok := stringField(input, key)
			if !ok {
				return "", nil, false
			}
			normalized[key] = value
		}
		if value, ok := optionalStringWithDefault(input, "region", "auto"); ok {
			normalized["region"] = value
		} else {
			return "", nil, false
		}
		if value, ok := optionalStringWithDefault(input, "prefix", "/photos"); ok {
			normalized["prefix"] = value
		} else {
			return "", nil, false
		}
		if !copyOptionalString(normalized, input, "cdnUrl") ||
			!copyOptionalBool(normalized, input, "forcePathStyle") ||
			!copyOptionalNumber(normalized, input, "maxKeys") {
			return "", nil, false
		}
	case "openlist":
		for _, key := range []string{"baseUrl", "rootPath", "token"} {
			value, ok := minStringField(input, key, 1)
			if !ok {
				return "", nil, false
			}
			normalized[key] = value
		}
		for key, fallback := range map[string]string{
			"uploadEndpoint": "/api/fs/put",
			"deleteEndpoint": "/api/fs/remove",
			"metaEndpoint":   "/api/fs/get",
			"pathField":      "path",
		} {
			value, ok := optionalStringWithDefault(input, key, fallback)
			if !ok {
				return "", nil, false
			}
			normalized[key] = value
		}
		if !copyOptionalString(normalized, input, "downloadEndpoint") ||
			!copyOptionalString(normalized, input, "listEndpoint") ||
			!copyOptionalString(normalized, input, "cdnUrl") {
			return "", nil, false
		}
	default:
		return "", nil, false
	}
	return provider, normalized, true
}

func (a *Application) persistWizardAdmin(ctx context.Context, admin wizardAdminConfig) (int64, error) {
	hash, err := auth.HashPassword(admin.Password)
	if err != nil {
		return 0, err
	}
	email := admin.Email
	var existingID int64
	var existingEmail string
	err = a.database.SQL().QueryRowContext(ctx, "SELECT id,email FROM users ORDER BY id LIMIT 1").Scan(&existingID, &existingEmail)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		result, insertErr := a.database.SQL().ExecContext(ctx, `
			INSERT INTO users(name,email,password,created_at,is_admin,is_active,auth_version)
			VALUES(?,?,?,unixepoch(),1,1,1)
		`, admin.Username, email, hash)
		if insertErr != nil {
			return 0, insertErr
		}
		id, idErr := result.LastInsertId()
		if idErr != nil {
			return 0, idErr
		}
		return id, nil
	case err == nil && existingEmail == admin.Email:
		_, updateErr := a.database.SQL().ExecContext(ctx, `
			UPDATE users SET name=?,password=?,is_admin=1 WHERE id=?
		`, admin.Username, hash, existingID)
		if updateErr != nil {
			return 0, updateErr
		}
		return existingID, nil
	case err == nil:
		return 0, errWizardUserExists
	default:
		return 0, err
	}
}

func (a *Application) persistWizardSite(ctx context.Context, site wizardSiteConfig, updatedBy *int64) error {
	if _, err := a.setSetting(ctx, "app", "title", site.Title, updatedBy); err != nil {
		return err
	}
	for _, update := range []struct {
		key   string
		value *string
	}{
		{key: "slogan", value: site.Slogan},
		{key: "avatarUrl", value: site.AvatarURL},
		{key: "author", value: site.Author},
	} {
		if update.value == nil || *update.value == "" {
			continue
		}
		if _, err := a.setSetting(ctx, "app", update.key, *update.value, updatedBy); err != nil {
			return err
		}
	}
	return nil
}

func (a *Application) persistWizardStorage(ctx context.Context, storage wizardStorageConfig, updatedBy *int64) (int64, error) {
	encoded, err := json.Marshal(storage.Config)
	if err != nil {
		return 0, err
	}
	result, err := a.database.SQL().ExecContext(ctx, `
		INSERT INTO settings_storage_providers(name,provider,config,created_at,updated_at)
		VALUES(?,?,?,unixepoch(),unixepoch())
	`, storage.Name, storage.Provider, string(encoded))
	if err != nil {
		return 0, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}
	if _, err := a.setSetting(ctx, "storage", "provider", id, updatedBy); err != nil {
		return 0, err
	}
	return id, nil
}

func (a *Application) persistWizardMap(ctx context.Context, config wizardMapConfig, updatedBy *int64) error {
	if _, err := a.setSetting(ctx, "map", "provider", config.Provider, updatedBy); err != nil {
		return err
	}
	switch config.Provider {
	case "amap":
		if _, err := a.setSetting(ctx, "map", "amap.key", config.Key, updatedBy); err != nil {
			return err
		}
		if _, err := a.setSetting(ctx, "map", "amap.securityJsCode", config.SecurityJSCode, updatedBy); err != nil {
			return err
		}
	case "mapbox", "maplibre":
		if _, err := a.setSetting(ctx, "map", config.Provider+".token", config.Token, updatedBy); err != nil {
			return err
		}
		if config.Style != nil && *config.Style != "" {
			if _, err := a.setSetting(ctx, "map", config.Provider+".style", *config.Style, updatedBy); err != nil {
				return err
			}
		}
	}
	return nil
}

func validWizardEmail(value string) bool {
	if value == "" || strings.ContainsAny(value, " \t\r\n") {
		return false
	}
	parts := strings.Split(value, "@")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return false
	}
	labels := strings.Split(parts[1], ".")
	if len(labels) < 2 || len(labels[len(labels)-1]) < 2 {
		return false
	}
	for _, label := range labels {
		if label == "" {
			return false
		}
	}
	return true
}

func stringField(input map[string]any, key string) (string, bool) {
	value, ok := input[key]
	if !ok {
		return "", false
	}
	stringValue, ok := value.(string)
	return stringValue, ok
}

func minStringField(input map[string]any, key string, minimum int) (string, bool) {
	value, ok := stringField(input, key)
	if !ok || len(value) < minimum {
		return "", false
	}
	return value, true
}

func optionalStringField(input map[string]any, key string) (*string, bool) {
	value, ok := input[key]
	if !ok || value == nil {
		return nil, true
	}
	stringValue, ok := value.(string)
	if !ok {
		return nil, false
	}
	return &stringValue, true
}

func optionalStringWithDefault(input map[string]any, key string, fallback string) (string, bool) {
	value, ok := input[key]
	if !ok || value == nil {
		return fallback, true
	}
	stringValue, ok := value.(string)
	return stringValue, ok
}

func copyOptionalString(target, input map[string]any, key string) bool {
	value, ok := optionalStringField(input, key)
	if !ok {
		return false
	}
	if value != nil {
		target[key] = *value
	}
	return true
}

func copyOptionalBool(target, input map[string]any, key string) bool {
	value, ok := input[key]
	if !ok || value == nil {
		return true
	}
	boolValue, ok := value.(bool)
	if !ok {
		return false
	}
	target[key] = boolValue
	return true
}

func copyOptionalNumber(target, input map[string]any, key string) bool {
	value, ok := input[key]
	if !ok || value == nil {
		return true
	}
	switch value.(type) {
	case json.Number, float64, float32, int, int64, int32, uint, uint64, uint32:
		target[key] = value
		return true
	default:
		return false
	}
}
