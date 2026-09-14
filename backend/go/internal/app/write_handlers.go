package app

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/albums"
	"github.com/swzyt/chronoframe/backend/go/internal/auth"
	"github.com/swzyt/chronoframe/backend/go/internal/platform/httpx"
	"github.com/swzyt/chronoframe/backend/go/internal/platform/redisx"
)

const sharedSessionTTL = 30 * 24 * time.Hour
const legacySessionCookieName = "nuxt-session"
const maxSafeInteger = int64(9007199254740991)

const zodEmailPatternMessage = `/^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$/`

var zodEmailPattern = regexp.MustCompile(`^([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`)
var errAccessPasswordRequired = errors.New("Set an access password before enabling protection")

func decodeJSONBody(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	decoder.UseNumber()
	if err := decodeSingleJSONValue(decoder, target); err != nil {
		if errors.Is(err, io.EOF) {
			httpx.Error(w, http.StatusBadRequest, "Validation Error")
		} else {
			writeInvalidJSONBody(w)
		}
		return false
	}
	return true
}

func decodeSingleJSONValue(decoder *json.Decoder, target any) error {
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err != nil {
			return err
		}
		return errors.New("multiple JSON values")
	}
	return nil
}

func writeInvalidJSONBody(w http.ResponseWriter) {
	httpx.ErrorWithMessageData(
		w,
		http.StatusBadRequest,
		"Bad Request",
		"Invalid JSON body",
		nil,
	)
}

func writeJSONMethod(method string, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != method {
			w.Header().Set("Allow", method)
			httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
			return
		}
		handler(w, r)
	}
}

func setCookie(w http.ResponseWriter, r *http.Request, name, value string, maxAge int) {
	secure := strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") || r.TLS != nil
	setCookieWithSecure(w, name, value, maxAge, secure)
}

func setCookieWithSecure(w http.ResponseWriter, name, value string, maxAge int, secure bool) {
	attributes := []string{
		name + "=" + value,
		"Max-Age=" + strconv.Itoa(maxAge),
		"Path=/",
		"HttpOnly",
	}
	if secure {
		attributes = append(attributes, "Secure")
	}
	attributes = append(attributes, "SameSite=Lax")
	w.Header().Add("Set-Cookie", strings.Join(attributes, "; "))
}

func clearCookie(w http.ResponseWriter, r *http.Request, name string) {
	setCookie(w, r, name, "", 0)
}

func clearInvalidSessionCookie(w http.ResponseWriter, err error) bool {
	name, secure, ok := auth.InvalidSessionCookie(err)
	if !ok {
		return false
	}
	setCookieWithSecure(w, name, "", 0, secure)
	return true
}

func (a *Application) login(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Authentication unavailable")
		return
	}
	body, ok := decodeLoginBody(w, r)
	if !ok {
		return
	}
	rateLimit, err := a.acquireLoginRateLimit(r.Context(), r, body.Email)
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Shared identity service unavailable")
		return
	}
	if !rateLimit.Allowed {
		w.Header().Set("Retry-After", strconv.FormatInt(rateLimit.RetryAfterSeconds, 10))
		httpx.Error(w, http.StatusTooManyRequests, "Too many attempts")
		return
	}
	credentials, ok := a.auth.CredentialRepository()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "Authentication unavailable")
		return
	}
	user, passwordHash, err := credentials.FindCredentials(r.Context(), body.Email)
	if err != nil || !user.IsActive || !auth.VerifyPassword(passwordHash, body.Password) {
		// Node creates this error with `message` but without `statusMessage`, so
		// Nitro exposes its default "Server Error" status message while keeping
		// the useful client-facing message. Preserve that slightly unusual wire
		// contract so switching the provider cannot change error handling.
		httpx.ErrorWithMessageData(
			w,
			http.StatusUnauthorized,
			"Server Error",
			"Invalid credentials",
			nil,
		)
		return
	}
	store := a.auth.SessionStore()
	if store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Authentication unavailable")
		return
	}
	if err := a.resetLoginRateLimit(r.Context(), rateLimit); err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Shared identity service unavailable")
		return
	}
	token, err := issueSession(r.Context(), store, user, a.now())
	if err != nil {
		if errors.Is(err, redisx.ErrUnavailable) {
			httpx.Error(w, http.StatusServiceUnavailable, "Shared identity service unavailable")
		} else {
			httpx.Error(w, http.StatusServiceUnavailable, "Authentication unavailable")
		}
		return
	}
	setCookie(w, r, a.auth.SessionCookieName(), token, int(sharedSessionTTL/time.Second))
	w.WriteHeader(http.StatusCreated)
}

type loginRequestBody struct {
	Email    string
	Password string
}

func decodeLoginBody(w http.ResponseWriter, r *http.Request) (loginRequestBody, bool) {
	var raw map[string]json.RawMessage
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	decoder.UseNumber()
	if err := decodeSingleJSONValue(decoder, &raw); err != nil {
		if errors.Is(err, io.EOF) {
			writeMissingObjectBodyZodValidationError(w)
			return loginRequestBody{}, false
		}
		writeInvalidJSONBody(w)
		return loginRequestBody{}, false
	}
	var issues []zodValidationIssue
	email, ok := decodeLoginStringField(raw, "email")
	if !ok {
		issues = append(issues, zodInvalidTypeIssue([]any{"email"}, "string", zodReceivedType(raw["email"])))
	} else if !validZodEmail(email) {
		issues = append(issues, zodInvalidFormatIssue(
			[]any{"email"},
			"email",
			zodEmailPatternMessage,
			"Invalid email address",
		))
	}
	password, ok := decodeLoginStringField(raw, "password")
	if !ok {
		issues = append(issues, zodInvalidTypeIssue([]any{"password"}, "string", zodReceivedType(raw["password"])))
	} else if len(password) < 6 {
		issues = append(issues, zodTooSmallStringIssue([]any{"password"}, 6))
	}
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return loginRequestBody{}, false
	}
	return loginRequestBody{
		Email:    strings.ToLower(strings.TrimSpace(email)),
		Password: password,
	}, true
}

func decodeLoginStringField(raw map[string]json.RawMessage, field string) (string, bool) {
	value, exists := raw[field]
	if !exists {
		return "", false
	}
	if zodReceivedType(value) != "string" {
		return "", false
	}
	var decoded string
	if err := json.Unmarshal(value, &decoded); err != nil {
		return "", false
	}
	return decoded, true
}

func zodReceivedType(value json.RawMessage) string {
	trimmed := strings.TrimSpace(string(value))
	if trimmed == "" {
		return "undefined"
	}
	switch trimmed[0] {
	case 'n':
		return "null"
	case '"':
		return "string"
	case 't', 'f':
		return "boolean"
	case '[':
		return "array"
	case '{':
		return "object"
	default:
		return "number"
	}
}

func validZodEmail(value string) bool {
	if strings.HasPrefix(value, ".") || strings.Contains(value, "..") {
		return false
	}
	return zodEmailPattern.MatchString(value)
}

func issueSession(
	ctx context.Context,
	store *redisx.SessionStore,
	user auth.User,
	now time.Time,
) (string, error) {
	if store == nil {
		return "", errors.New("shared session store is unavailable")
	}
	token, err := redisx.GenerateToken()
	if err != nil {
		return "", err
	}
	issuedAt := now.Unix()
	if err := store.PutSession(ctx, token, redisx.Session{
		SchemaVersion: 1,
		UserID:        user.ID,
		AuthVersion:   user.AuthVersion,
		IssuedAt:      issuedAt,
		ExpiresAt:     issuedAt + int64(sharedSessionTTL/time.Second),
	}); err != nil {
		return "", err
	}
	return token, nil
}

func (a *Application) logout(w http.ResponseWriter, r *http.Request) {
	a.clearSessionCookies(w, r)
	httpx.JSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *Application) clearSessionCookies(w http.ResponseWriter, r *http.Request) {
	if a.auth != nil {
		if cookie, err := r.Cookie(a.auth.SessionCookieName()); err == nil {
			if store := a.auth.SessionStore(); store != nil {
				_ = store.DeleteSession(r.Context(), cookie.Value)
			}
		}
		clearCookie(w, r, a.auth.SessionCookieName())
		clearCookie(w, r, legacySessionCookieName)
	}
}

func (a *Application) authSession(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil {
		httpx.JSON(w, http.StatusOK, map[string]any{"id": newAnonymousSessionID()})
		return
	}
	user, err := a.auth.OptionalUser(r.Context(), r)
	if err != nil || user == nil {
		clearCookie(w, r, a.auth.SessionCookieName())
		clearCookie(w, r, legacySessionCookieName)
		httpx.JSON(w, http.StatusOK, map[string]any{"id": newAnonymousSessionID()})
		return
	}
	cookie, _ := r.Cookie(a.auth.SessionCookieName())
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": cookieValue(cookie),
		"user": map[string]any{
			"id": user.ID, "username": user.Username, "email": user.Email,
			"avatar": user.Avatar, "isAdmin": user.IsAdmin,
			"isActive": user.IsActive,
		},
	})
}

func cookieValue(cookie *http.Cookie) string {
	if cookie == nil {
		return ""
	}
	return cookie.Value
}

func newAnonymousSessionID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return ""
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(bytes[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" +
		encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32]
}

func writeMissingObjectBodyZodValidationError(w http.ResponseWriter) {
	writeSettingZodValidationError(
		w,
		zodInvalidTypeIssue([]any{}, "object", "undefined"),
	)
}

func (a *Application) authSessionDelete(w http.ResponseWriter, r *http.Request) {
	a.clearSessionCookies(w, r)
	httpx.JSON(w, http.StatusOK, map[string]any{"loggedOut": true})
}

func (a *Application) accessVerify(w http.ResponseWriter, r *http.Request) {
	if a.access == nil || a.settings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Access control unavailable")
		return
	}
	state := a.accessState(w, r, a.optionalUser(w, r) != nil)
	if !state.Enabled {
		httpx.JSON(w, http.StatusOK, map[string]any{"success": true})
		return
	}
	body, ok := decodeAccessVerifyBody(w, r)
	if !ok {
		return
	}
	rateLimit, err := a.acquireAccessRateLimit(r.Context(), r)
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Shared identity service unavailable")
		return
	}
	if !rateLimit.Allowed {
		w.Header().Set("Retry-After", strconv.FormatInt(rateLimit.RetryAfterSeconds, 10))
		httpx.Error(w, http.StatusTooManyRequests, "Too many attempts")
		return
	}
	row, err := a.settings.Value(r.Context(), "app", "access.passwordHash")
	if err != nil || !row.Value.Valid || !auth.VerifyPassword(row.Value.String, body.Password) {
		httpx.Error(w, http.StatusUnauthorized, "Invalid password")
		return
	}
	if err := a.resetAccessRateLimit(r.Context(), rateLimit); err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Shared identity service unavailable")
		return
	}
	token, err := a.access.Issue(r.Context(), a.now())
	if err != nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Shared identity service unavailable")
		return
	}
	setCookie(w, r, a.access.AccessCookieName(), token, int(sharedSessionTTL/time.Second))
	httpx.JSON(w, http.StatusOK, map[string]any{"success": true})
}

type accessVerifyBody struct {
	Password string
}

func decodeAccessVerifyBody(w http.ResponseWriter, r *http.Request) (accessVerifyBody, bool) {
	var raw map[string]json.RawMessage
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	decoder.UseNumber()
	if err := decodeSingleJSONValue(decoder, &raw); err != nil {
		if errors.Is(err, io.EOF) {
			writeMissingObjectBodyZodValidationError(w)
			return accessVerifyBody{}, false
		}
		writeInvalidJSONBody(w)
		return accessVerifyBody{}, false
	}
	password, ok := decodeLoginStringField(raw, "password")
	if !ok {
		writeSettingZodValidationError(w, zodInvalidTypeIssue([]any{"password"}, "string", zodReceivedType(raw["password"])))
		return accessVerifyBody{}, false
	}
	if len(password) < 1 {
		writeSettingZodValidationError(w, zodTooSmallStringIssue([]any{"password"}, 1))
		return accessVerifyBody{}, false
	}
	if len(password) > 128 {
		writeSettingZodValidationError(w, zodTooBigStringIssue([]any{"password"}, 128))
		return accessVerifyBody{}, false
	}
	return accessVerifyBody{Password: password}, true
}

func (a *Application) accessConfigUpdate(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.settings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Access control unavailable")
		return
	}
	admin, err := a.auth.RequireAdmin(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	body, ok := decodeAccessConfigUpdateBody(w, r)
	if !ok {
		return
	}
	passwordHash := ""
	if body.Password != nil {
		passwordHash, err = auth.HashPassword(*body.Password)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}
	result, err := a.updateAccessSecurityConfiguration(r.Context(), accessConfigWriteInput{
		Enabled:      body.Enabled,
		PasswordHash: optionalStringPointer(passwordHash, body.Password != nil),
		PhotoLimit:   body.PhotoLimit,
		AlbumLimit:   body.AlbumLimit,
		UpdatedBy:    admin.ID,
	})
	if errors.Is(err, errAccessPasswordRequired) {
		httpx.Error(w, http.StatusBadRequest, errAccessPasswordRequired.Error())
		return
	}
	if err != nil {
		a.logger.ErrorContext(r.Context(), "access setting update failed", "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"enabled": body.Enabled, "hasPassword": result.HasPassword,
		"photoLimit": body.PhotoLimit, "albumLimit": body.AlbumLimit,
	})
}

type accessConfigWriteInput struct {
	Enabled      bool
	PasswordHash *string
	PhotoLimit   int64
	AlbumLimit   int64
	UpdatedBy    int64
}

type accessConfigWriteResult struct {
	Version     int64
	HasPassword bool
}

func optionalStringPointer(value string, present bool) *string {
	if !present {
		return nil
	}
	return &value
}

func (a *Application) updateAccessSecurityConfiguration(
	ctx context.Context,
	input accessConfigWriteInput,
) (accessConfigWriteResult, error) {
	if a.database == nil {
		return accessConfigWriteResult{}, errors.New("SQLite database is unavailable")
	}
	tx, err := a.database.SQL().BeginTx(ctx, nil)
	if err != nil {
		return accessConfigWriteResult{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	var existingHash sql.NullString
	err = tx.QueryRowContext(ctx, `
		SELECT value
		FROM settings
		WHERE namespace = 'app' AND key = 'access.passwordHash'
	`).Scan(&existingHash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return accessConfigWriteResult{}, err
	}
	effectiveHash := ""
	if existingHash.Valid {
		effectiveHash = existingHash.String
	}
	if input.PasswordHash != nil {
		effectiveHash = *input.PasswordHash
	}
	if input.Enabled && effectiveHash == "" {
		return accessConfigWriteResult{}, errAccessPasswordRequired
	}

	if input.PasswordHash != nil {
		if err := updateAccessSettingInTx(ctx, tx, "access.passwordHash", *input.PasswordHash, input.UpdatedBy); err != nil {
			return accessConfigWriteResult{}, err
		}
	}
	if err := updateAccessSettingInTx(ctx, tx, "access.enabled", boolSettingValue(input.Enabled), input.UpdatedBy); err != nil {
		return accessConfigWriteResult{}, err
	}
	if err := updateAccessSettingInTx(ctx, tx, "access.previewPhotoLimit", strconv.FormatInt(input.PhotoLimit, 10), input.UpdatedBy); err != nil {
		return accessConfigWriteResult{}, err
	}
	if err := updateAccessSettingInTx(ctx, tx, "access.previewAlbumLimit", strconv.FormatInt(input.AlbumLimit, 10), input.UpdatedBy); err != nil {
		return accessConfigWriteResult{}, err
	}

	var versionValue sql.NullString
	err = tx.QueryRowContext(ctx, `
		SELECT value
		FROM settings
		WHERE namespace = 'app' AND key = 'access.version'
	`).Scan(&versionValue)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return accessConfigWriteResult{}, errors.New("Access version setting is missing or invalid")
		}
		return accessConfigWriteResult{}, err
	}
	currentVersion, err := parseAccessVersion(versionValue)
	if err != nil {
		return accessConfigWriteResult{}, err
	}
	nextVersion := currentVersion + 1
	if err := updateAccessSettingInTx(ctx, tx, "access.version", strconv.FormatInt(nextVersion, 10), input.UpdatedBy); err != nil {
		return accessConfigWriteResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return accessConfigWriteResult{}, err
	}
	committed = true
	a.publishSettingsCacheVersion(ctx)
	return accessConfigWriteResult{Version: nextVersion, HasPassword: effectiveHash != ""}, nil
}

func updateAccessSettingInTx(ctx context.Context, tx *sql.Tx, key string, value string, updatedBy int64) error {
	result, err := tx.ExecContext(ctx, `
		UPDATE settings
		SET value = ?, updated_at = unixepoch(), updated_by = ?
		WHERE namespace = 'app' AND key = ?
	`, value, updatedBy, key)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func parseAccessVersion(value sql.NullString) (int64, error) {
	parsed, err := strconv.ParseFloat(value.String, 64)
	if !value.Valid || err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) || math.Trunc(parsed) != parsed {
		return 0, errors.New("Access version setting is missing or invalid")
	}
	if parsed < 1 || parsed >= float64(maxSafeInteger) {
		return 0, errors.New("Access version setting is missing or invalid")
	}
	return int64(parsed), nil
}

func boolSettingValue(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

type accessConfigUpdateBody struct {
	Enabled    bool
	Password   *string
	PhotoLimit int64
	AlbumLimit int64
}

func decodeAccessConfigUpdateBody(w http.ResponseWriter, r *http.Request) (accessConfigUpdateBody, bool) {
	var raw map[string]json.RawMessage
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	decoder.UseNumber()
	if err := decodeSingleJSONValue(decoder, &raw); err != nil {
		if errors.Is(err, io.EOF) {
			httpx.Error(w, http.StatusBadRequest, "Validation Error")
		} else {
			writeInvalidJSONBody(w)
		}
		return accessConfigUpdateBody{}, false
	}
	var issues []zodValidationIssue
	enabled, ok := decodeRequiredBoolField(raw, "enabled")
	if !ok {
		issues = append(issues, zodInvalidTypeIssue([]any{"enabled"}, "boolean", zodReceivedType(raw["enabled"])))
	}
	password, passwordOK := decodeOptionalBoundedStringField(raw, "password", 8, 128, &issues)
	photoLimit, photoOK := decodeRequiredBoundedIntField(raw, "photoLimit", 1, 10000, &issues)
	albumLimit, albumOK := decodeRequiredBoundedIntField(raw, "albumLimit", 1, 10000, &issues)
	if len(issues) > 0 || !enabled && !ok || !passwordOK || !photoOK || !albumOK {
		writeSettingZodValidationError(w, issues...)
		return accessConfigUpdateBody{}, false
	}
	return accessConfigUpdateBody{
		Enabled:    enabled,
		Password:   password,
		PhotoLimit: photoLimit,
		AlbumLimit: albumLimit,
	}, true
}

func decodeRequiredBoolField(raw map[string]json.RawMessage, field string) (bool, bool) {
	value, exists := raw[field]
	if !exists {
		return false, false
	}
	switch strings.TrimSpace(string(value)) {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

func decodeOptionalBoundedStringField(raw map[string]json.RawMessage, field string, minimum int, maximum int, issues *[]zodValidationIssue) (*string, bool) {
	value, exists := raw[field]
	if !exists {
		return nil, true
	}
	if zodReceivedType(value) != "string" {
		*issues = append(*issues, zodInvalidTypeIssue([]any{field}, "string", zodReceivedType(value)))
		return nil, false
	}
	var decoded string
	if err := json.Unmarshal(value, &decoded); err != nil {
		*issues = append(*issues, zodInvalidTypeIssue([]any{field}, "string", zodReceivedType(value)))
		return nil, false
	}
	if len(decoded) < minimum {
		*issues = append(*issues, zodTooSmallStringIssue([]any{field}, minimum))
		return nil, false
	}
	if len(decoded) > maximum {
		*issues = append(*issues, zodTooBigStringIssue([]any{field}, maximum))
		return nil, false
	}
	return &decoded, true
}

func decodeRequiredBoundedIntField(raw map[string]json.RawMessage, field string, minimum int64, maximum int64, issues *[]zodValidationIssue) (int64, bool) {
	value, exists := raw[field]
	if !exists {
		*issues = append(*issues, zodInvalidTypeIssue([]any{field}, "number", "undefined"))
		return 0, false
	}
	if zodReceivedType(value) != "number" {
		*issues = append(*issues, zodInvalidTypeIssue([]any{field}, "number", zodReceivedType(value)))
		return 0, false
	}
	var decoded json.Number
	if err := json.Unmarshal(value, &decoded); err != nil {
		*issues = append(*issues, zodInvalidTypeIssue([]any{field}, "number", zodReceivedType(value)))
		return 0, false
	}
	parsed, err := strconv.ParseFloat(decoded.String(), 64)
	if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) || math.Trunc(parsed) != parsed {
		*issues = append(*issues, zodInvalidIntIssue([]any{field}))
		return 0, false
	}
	if parsed < float64(minimum) {
		*issues = append(*issues, zodTooSmallNumberIssue([]any{field}, int(minimum)))
		return 0, false
	}
	if parsed > float64(maximum) {
		*issues = append(*issues, zodTooBigNumberIssue([]any{field}, int(maximum)))
		return 0, false
	}
	return int64(parsed), true
}

func positiveJSONInt(value json.Number, minimum, maximum int64) (int64, bool) {
	if value == "" {
		return 0, false
	}
	parsed, err := strconv.ParseInt(value.String(), 10, 64)
	if err != nil || parsed < minimum || parsed > maximum {
		return 0, false
	}
	return parsed, true
}

type adminUserCreateBody struct {
	Username string
	Email    string
	Password string
	IsAdmin  bool
}

func decodeAdminUserCreateBody(w http.ResponseWriter, r *http.Request) (adminUserCreateBody, bool) {
	object, ok := decodeRequiredJSONObjectBody(w, r)
	if !ok {
		return adminUserCreateBody{}, false
	}
	var issues []zodValidationIssue
	username, usernameExists, usernameValid := decodeJSONStringField(object, "username")
	if !usernameExists || !usernameValid {
		issues = append(issues, zodInvalidTypeIssue([]any{"username"}, "string", zodReceivedType(object["username"])))
	} else {
		username = strings.TrimSpace(username)
		if jsStringLength(username) < 2 {
			issues = append(issues, zodTooSmallStringIssue([]any{"username"}, 2))
		} else if jsStringLength(username) > 64 {
			issues = append(issues, zodTooBigStringIssue([]any{"username"}, 64))
		}
	}
	email, emailExists, emailValid := decodeJSONStringField(object, "email")
	if !emailExists || !emailValid {
		issues = append(issues, zodInvalidTypeIssue([]any{"email"}, "string", zodReceivedType(object["email"])))
	} else if !validZodEmail(email) {
		issues = append(issues, zodInvalidFormatIssue(
			[]any{"email"},
			"email",
			zodEmailPatternMessage,
			"Invalid email address",
		))
	}
	password, passwordExists, passwordValid := decodeJSONStringField(object, "password")
	if !passwordExists || !passwordValid {
		received := zodReceivedType(object["password"])
		issues = append(issues, zodInvalidTypeIssue([]any{"password"}, "string", received))
		if received == "array" {
			var values []json.RawMessage
			if err := json.Unmarshal(object["password"], &values); err == nil {
				if len(values) < 8 {
					issues = append(issues, zodTooSmallArrayIssue(
						[]any{"password"},
						8,
						"Too small: expected array to have >=8 items",
					))
				} else if len(values) > 128 {
					issues = append(issues, zodTooBigArrayIssue(
						[]any{"password"},
						128,
						"Too big: expected array to have <=128 items",
					))
				}
			}
		}
	} else if jsStringLength(password) < 8 {
		issues = append(issues, zodTooSmallStringIssue([]any{"password"}, 8))
	} else if jsStringLength(password) > 128 {
		issues = append(issues, zodTooBigStringIssue([]any{"password"}, 128))
	}
	isAdmin := false
	if value, exists, valid := decodeJSONBoolField(object, "isAdmin"); exists {
		if !valid {
			issues = append(issues, zodInvalidTypeIssue([]any{"isAdmin"}, "boolean", zodReceivedType(object["isAdmin"])))
		} else {
			isAdmin = value
		}
	}
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return adminUserCreateBody{}, false
	}
	return adminUserCreateBody{
		Username: username,
		Email:    strings.ToLower(strings.TrimSpace(email)),
		Password: password,
		IsAdmin:  isAdmin,
	}, true
}

func (a *Application) adminUserCreate(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Authentication unavailable")
		return
	}
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	body, ok := decodeAdminUserCreateBody(w, r)
	if !ok {
		return
	}
	password, err := auth.HashPassword(body.Password)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	result, err := a.database.SQL().ExecContext(r.Context(), `
		INSERT INTO users(name,email,password,created_at,is_admin,is_active,auth_version)
		VALUES(?,?,?,?,?,1,1)
	`, body.Username, body.Email, password, a.now().Unix(), boolInt(body.IsAdmin))
	if err != nil {
		httpx.Error(w, http.StatusConflict, "Username or email already exists")
		return
	}
	id, _ := result.LastInsertId()
	a.writeUserMutationByID(w, r, id, http.StatusOK)
}

func boolInt(value bool) int64 {
	if value {
		return 1
	}
	return 0
}

type adminUserUpdateBody struct {
	Username *string
	Email    *string
	Password *string
	IsAdmin  *bool
	IsActive *bool
}

func decodeAdminUserUpdateBody(w http.ResponseWriter, r *http.Request) (adminUserUpdateBody, bool) {
	object, ok := decodeRequiredJSONObjectBody(w, r)
	if !ok {
		return adminUserUpdateBody{}, false
	}
	body := adminUserUpdateBody{}
	issues := make([]zodValidationIssue, 0)
	knownFieldCount := 0

	if raw, exists := object["username"]; exists {
		knownFieldCount++
		if zodReceivedType(raw) != "string" {
			issues = append(issues, zodInvalidTypeIssue([]any{"username"}, "string", zodReceivedType(raw)))
		} else {
			var value string
			if err := json.Unmarshal(raw, &value); err != nil {
				issues = append(issues, zodInvalidTypeIssue([]any{"username"}, "string", zodReceivedType(raw)))
			} else {
				value = strings.TrimSpace(value)
				if jsStringLength(value) < 2 {
					issues = append(issues, zodTooSmallStringIssue([]any{"username"}, 2))
				} else if jsStringLength(value) > 64 {
					issues = append(issues, zodTooBigStringIssue([]any{"username"}, 64))
				}
				body.Username = &value
			}
		}
	}

	if raw, exists := object["email"]; exists {
		knownFieldCount++
		if zodReceivedType(raw) != "string" {
			issues = append(issues, zodInvalidTypeIssue([]any{"email"}, "string", zodReceivedType(raw)))
		} else {
			var value string
			if err := json.Unmarshal(raw, &value); err != nil {
				issues = append(issues, zodInvalidTypeIssue([]any{"email"}, "string", zodReceivedType(raw)))
			} else {
				if !validZodEmail(value) {
					issues = append(issues, zodInvalidFormatIssue(
						[]any{"email"},
						"email",
						zodEmailPatternMessage,
						"Invalid email address",
					))
				}
				value = strings.ToLower(strings.TrimSpace(value))
				body.Email = &value
			}
		}
	}

	if raw, exists := object["password"]; exists {
		knownFieldCount++
		received := zodReceivedType(raw)
		if received != "string" {
			issues = append(issues, zodInvalidTypeIssue([]any{"password"}, "string", received))
			if received == "array" {
				var values []json.RawMessage
				if err := json.Unmarshal(raw, &values); err == nil {
					if len(values) < 8 {
						issues = append(issues, zodTooSmallArrayIssue(
							[]any{"password"},
							8,
							"Too small: expected array to have >=8 items",
						))
					} else if len(values) > 128 {
						issues = append(issues, zodTooBigArrayIssue(
							[]any{"password"},
							128,
							"Too big: expected array to have <=128 items",
						))
					}
				}
			}
		} else {
			var value string
			if err := json.Unmarshal(raw, &value); err != nil {
				issues = append(issues, zodInvalidTypeIssue([]any{"password"}, "string", received))
			} else {
				if jsStringLength(value) < 8 {
					issues = append(issues, zodTooSmallStringIssue([]any{"password"}, 8))
				} else if jsStringLength(value) > 128 {
					issues = append(issues, zodTooBigStringIssue([]any{"password"}, 128))
				}
				body.Password = &value
			}
		}
	}

	if raw, exists := object["isAdmin"]; exists {
		knownFieldCount++
		if zodReceivedType(raw) != "boolean" {
			issues = append(issues, zodInvalidTypeIssue([]any{"isAdmin"}, "boolean", zodReceivedType(raw)))
		} else {
			var value bool
			if err := json.Unmarshal(raw, &value); err != nil {
				issues = append(issues, zodInvalidTypeIssue([]any{"isAdmin"}, "boolean", zodReceivedType(raw)))
			} else {
				body.IsAdmin = &value
			}
		}
	}

	if raw, exists := object["isActive"]; exists {
		knownFieldCount++
		if zodReceivedType(raw) != "boolean" {
			issues = append(issues, zodInvalidTypeIssue([]any{"isActive"}, "boolean", zodReceivedType(raw)))
		} else {
			var value bool
			if err := json.Unmarshal(raw, &value); err != nil {
				issues = append(issues, zodInvalidTypeIssue([]any{"isActive"}, "boolean", zodReceivedType(raw)))
			} else {
				body.IsActive = &value
			}
		}
	}

	if len(issues) == 0 && knownFieldCount == 0 {
		issues = append(issues, zodCustomIssue([]any{}, "Invalid input"))
	}
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return adminUserUpdateBody{}, false
	}
	return body, true
}

func adminUserPathID(value string) (int64, bool) {
	parsed, ok := parseJavaScriptNumber(value)
	if !ok || math.IsInf(parsed, 0) || math.IsNaN(parsed) ||
		math.Trunc(parsed) != parsed || parsed <= 0 || parsed > float64(maxSafeInteger) {
		return 0, false
	}
	return int64(parsed), true
}

func (a *Application) adminUserUpdate(w http.ResponseWriter, r *http.Request) {
	actor, err := a.auth.RequireAdmin(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	id, ok := adminUserPathID(r.PathValue("id"))
	if !ok {
		httpx.Error(w, http.StatusInternalServerError, "Server Error")
		return
	}
	body, ok := decodeAdminUserUpdateBody(w, r)
	if !ok {
		return
	}
	var current auth.User
	var currentIsActive int64
	if err := a.database.SQL().QueryRowContext(r.Context(), `
		SELECT id,name,email,avatar,created_at,is_admin,is_active,auth_version FROM users WHERE id = ?
	`, id).Scan(&current.ID, &current.Username, &current.Email, &current.Avatar, new(int64), &current.IsAdmin, &currentIsActive, &current.AuthVersion); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "User not found")
		} else {
			httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		}
		return
	}
	if id == actor.ID && ((body.IsAdmin != nil && !*body.IsAdmin) || (body.IsActive != nil && !*body.IsActive)) {
		httpx.Error(w, http.StatusBadRequest, "You cannot demote or disable your own account")
		return
	}
	leavesNoActiveAdmin, err := wouldLeaveNoActiveAdmin(
		r.Context(), a.database.SQL(), id, current.IsAdmin, currentIsActive,
		body.IsAdmin, body.IsActive,
	)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if leavesNoActiveAdmin {
		httpx.Error(w, http.StatusBadRequest, "At least one active administrator is required")
		return
	}
	sets, args := make([]string, 0, 5), make([]any, 0, 5)
	if body.Username != nil {
		sets, args = append(sets, "name = ?"), append(args, *body.Username)
	}
	if body.Email != nil {
		sets, args = append(sets, "email = ?"), append(args, *body.Email)
	}
	if body.Password != nil {
		hash, hashErr := auth.HashPassword(*body.Password)
		if hashErr != nil {
			httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		sets, args = append(sets, "password = ?"), append(args, hash)
	}
	if body.IsAdmin != nil {
		sets, args = append(sets, "is_admin = ?"), append(args, boolInt(*body.IsAdmin))
	}
	if body.IsActive != nil {
		sets, args = append(sets, "is_active = ?"), append(args, boolInt(*body.IsActive))
	}
	args = append(args, id)
	if _, err := a.database.SQL().ExecContext(r.Context(), "UPDATE users SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...); err != nil {
		// The Node handler does not catch update constraint failures, so Nitro
		// exposes its generic 500 Server Error contract here. Creation is
		// intentionally different because the Node create handler maps every
		// insert failure to 409.
		httpx.Error(w, http.StatusInternalServerError, "Server Error")
		return
	}
	a.writeUserMutationByID(w, r, id, http.StatusOK)
}

func wouldLeaveNoActiveAdmin(
	ctx context.Context,
	database *sql.DB,
	userID int64,
	currentIsAdmin int64,
	currentIsActive int64,
	nextIsAdmin *bool,
	nextIsActive *bool,
) (bool, error) {
	if currentIsAdmin == 0 || currentIsActive == 0 {
		return false, nil
	}
	if (nextIsAdmin == nil || *nextIsAdmin) && (nextIsActive == nil || *nextIsActive) {
		return false, nil
	}
	var remainingAdmins int64
	if err := database.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM users
		WHERE is_admin = 1 AND is_active = 1 AND id != ?
	`, userID).Scan(&remainingAdmins); err != nil {
		return false, err
	}
	return remainingAdmins == 0, nil
}

func (a *Application) adminUserDelete(w http.ResponseWriter, r *http.Request) {
	actor, err := a.auth.RequireAdmin(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	id, ok := adminUserPathID(r.PathValue("id"))
	if !ok {
		httpx.Error(w, http.StatusInternalServerError, "Server Error")
		return
	}
	if id == actor.ID {
		httpx.Error(w, http.StatusBadRequest, "You cannot delete your own account")
		return
	}
	var isAdmin int64
	if err := a.database.SQL().QueryRowContext(r.Context(), "SELECT is_admin FROM users WHERE id = ?", id).Scan(&isAdmin); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "User not found")
		} else {
			httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		}
		return
	}
	if isAdmin != 0 {
		httpx.Error(w, http.StatusBadRequest, "Demote the administrator before deleting the account")
		return
	}
	tx, err := a.database.SQL().BeginTx(r.Context(), nil)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	defer tx.Rollback()
	for _, table := range []string{"photos", "albums", "pipeline_queue"} {
		if _, err := tx.ExecContext(r.Context(), "UPDATE "+table+" SET owner_user_id = ? WHERE owner_user_id = ?", actor.ID, id); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
	}
	if _, err := tx.ExecContext(r.Context(), "DELETE FROM users WHERE id = ?", id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *Application) writeUserMutationByID(w http.ResponseWriter, r *http.Request, id int64, status int) {
	var (
		user     auth.User
		isActive int64
	)
	err := a.database.SQL().QueryRowContext(r.Context(), `
		SELECT id,name,email,is_admin,is_active FROM users WHERE id = ?
	`, id).Scan(&user.ID, &user.Username, &user.Email, &user.IsAdmin, &isActive)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	user.IsActive = isActive != 0
	httpx.JSON(w, status, map[string]any{
		"id": user.ID, "username": user.Username, "email": user.Email,
		"isAdmin": user.IsAdmin, "isActive": user.IsActive,
	})
}

func pathInt64(value string) (int64, bool) {
	parsed, err := strconv.ParseInt(value, 10, 64)
	return parsed, err == nil && parsed > 0
}

type albumCreateBody struct {
	Title       string   `json:"title"`
	Description *string  `json:"description"`
	CoverPhoto  *string  `json:"coverPhotoId"`
	PhotoIDs    []string `json:"photoIds"`
	IsHidden    bool     `json:"isHidden"`
}

type albumUpdateBody struct {
	Title       *string   `json:"title"`
	Description *string   `json:"description"`
	CoverPhoto  *string   `json:"coverPhotoId"`
	PhotoIDs    *[]string `json:"photoIds"`
	IsHidden    *bool     `json:"isHidden"`
}

func decodeAlbumCreateBody(w http.ResponseWriter, r *http.Request) (albumCreateBody, bool) {
	object, ok := decodeRequiredJSONObjectBody(w, r)
	if !ok {
		return albumCreateBody{}, false
	}
	var issues []zodValidationIssue
	title, titleExists, titleValid := decodeJSONStringField(object, "title")
	if !titleExists || !titleValid {
		issues = append(issues, zodInvalidTypeIssue([]any{"title"}, "string", zodReceivedType(object["title"])))
	} else if jsStringLength(title) < 1 {
		issues = append(issues, zodTooSmallStringIssue([]any{"title"}, 1))
	} else if jsStringLength(title) > 255 {
		issues = append(issues, zodTooBigStringIssue([]any{"title"}, 255))
	}

	var description *string
	if value, exists, valid := decodeJSONStringField(object, "description"); exists {
		if !valid {
			issues = append(issues, zodInvalidTypeIssue([]any{"description"}, "string", zodReceivedType(object["description"])))
		} else if jsStringLength(value) > 1000 {
			issues = append(issues, zodTooBigStringIssue([]any{"description"}, 1000))
		} else {
			description = &value
		}
	}

	var coverPhotoID *string
	if value, exists, valid := decodeJSONStringField(object, "coverPhotoId"); exists {
		if !valid {
			issues = append(issues, zodInvalidTypeIssue([]any{"coverPhotoId"}, "string", zodReceivedType(object["coverPhotoId"])))
		} else {
			coverPhotoID = &value
		}
	}

	photoIDs := decodeOptionalJSONStringArray(object, "photoIds", &issues)
	isHidden := false
	if value, exists, valid := decodeJSONBoolField(object, "isHidden"); exists {
		if !valid {
			issues = append(issues, zodInvalidTypeIssue([]any{"isHidden"}, "boolean", zodReceivedType(object["isHidden"])))
		} else {
			isHidden = value
		}
	}
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return albumCreateBody{}, false
	}
	return albumCreateBody{
		Title:       title,
		Description: description,
		CoverPhoto:  coverPhotoID,
		PhotoIDs:    photoIDs,
		IsHidden:    isHidden,
	}, true
}

func decodeAlbumUpdateBody(w http.ResponseWriter, r *http.Request) (albumUpdateBody, bool) {
	object, ok := decodeRequiredJSONObjectBody(w, r)
	if !ok {
		return albumUpdateBody{}, false
	}
	var (
		body   albumUpdateBody
		issues []zodValidationIssue
	)
	if value, exists, valid := decodeJSONStringField(object, "title"); exists {
		if !valid {
			issues = append(issues, zodInvalidTypeIssue([]any{"title"}, "string", zodReceivedType(object["title"])))
		} else {
			body.Title = &value
			if jsStringLength(value) < 1 {
				issues = append(issues, zodTooSmallStringIssue([]any{"title"}, 1))
			} else if jsStringLength(value) > 255 {
				issues = append(issues, zodTooBigStringIssue([]any{"title"}, 255))
			}
		}
	}
	if value, exists, valid := decodeJSONStringField(object, "description"); exists {
		if !valid {
			issues = append(issues, zodInvalidTypeIssue([]any{"description"}, "string", zodReceivedType(object["description"])))
		} else {
			body.Description = &value
			if jsStringLength(value) > 1000 {
				issues = append(issues, zodTooBigStringIssue([]any{"description"}, 1000))
			}
		}
	}
	if value, exists, valid := decodeJSONStringField(object, "coverPhotoId"); exists {
		if !valid {
			issues = append(issues, zodInvalidTypeIssue([]any{"coverPhotoId"}, "string", zodReceivedType(object["coverPhotoId"])))
		} else {
			body.CoverPhoto = &value
		}
	}
	if _, exists := object["photoIds"]; exists {
		values := decodeOptionalJSONStringArray(object, "photoIds", &issues)
		body.PhotoIDs = &values
	}
	if value, exists, valid := decodeJSONBoolField(object, "isHidden"); exists {
		if !valid {
			issues = append(issues, zodInvalidTypeIssue([]any{"isHidden"}, "boolean", zodReceivedType(object["isHidden"])))
		} else {
			body.IsHidden = &value
		}
	}
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return albumUpdateBody{}, false
	}
	return body, true
}

func (a *Application) albumCreate(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	body, ok := decodeAlbumCreateBody(w, r)
	if !ok {
		return
	}
	relationPhotoIDs := uniqueAlbumPhotoIDs(body.PhotoIDs, body.CoverPhoto)
	owned, err := a.albumPhotosOwned(r.Context(), relationPhotoIDs, user)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if !owned {
		httpx.Error(w, http.StatusNotFound, "Photo not found")
		return
	}
	id, err := a.createAlbumTransaction(r.Context(), body, user.ID, relationPhotoIDs)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "Album could not be created")
		return
	}
	album, err := a.albums.FindByID(r.Context(), id)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, albumMutationResponse(album))
}

func emptyStringAsNil(value *string) any {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	return strings.TrimSpace(*value)
}

// albumEmptyStringAsNil matches JavaScript's `value || null` without changing
// any non-empty text. Album titles, descriptions, and cover IDs are intentionally
// not trimmed by the Node implementation.
func albumEmptyStringAsNil(value *string) any {
	if value == nil || *value == "" {
		return nil
	}
	return *value
}

// albumMutationResponse mirrors Drizzle's raw albums table row returned by
// the Node create/update handlers. Owner and relation projections belong to
// read endpoints and must not leak into these mutation responses.
func albumMutationResponse(album albums.Album) map[string]any {
	return map[string]any{
		"id": album.ID, "title": album.Title, "description": album.Description,
		"coverPhotoId": album.CoverPhotoID, "isHidden": album.IsHidden,
		"createdAt": album.CreatedAt, "updatedAt": album.UpdatedAt,
		"ownerUserId": album.OwnerUserID,
	}
}

func (a *Application) albumUpdate(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	id, ok := parseAlbumIDPath(w, r.PathValue("albumID"))
	if !ok {
		return
	}
	body, ok := decodeAlbumUpdateBody(w, r)
	if !ok {
		return
	}
	if !a.albumOwned(r.Context(), id, user) {
		httpx.Error(w, http.StatusNotFound, "Album not found")
		return
	}
	sets, args := make([]string, 0, 5), make([]any, 0, 5)
	if body.Title != nil {
		sets, args = append(sets, "title = ?"), append(args, *body.Title)
	}
	if body.Description != nil {
		sets, args = append(sets, "description = ?"), append(args, albumEmptyStringAsNil(body.Description))
	}
	if body.CoverPhoto != nil {
		sets, args = append(sets, "cover_photo_id = ?"), append(args, albumEmptyStringAsNil(body.CoverPhoto))
	}
	if body.IsHidden != nil {
		sets, args = append(sets, "is_hidden = ?"), append(args, boolInt(*body.IsHidden))
	}
	requestedPhotoIDs := []string{}
	if body.PhotoIDs != nil {
		requestedPhotoIDs = *body.PhotoIDs
	}
	requestedPhotoIDs = uniqueAlbumPhotoIDs(requestedPhotoIDs, body.CoverPhoto)
	owned, err := a.albumPhotosOwned(r.Context(), requestedPhotoIDs, user)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if !owned {
		httpx.Error(w, http.StatusNotFound, "Photo not found")
		return
	}
	var replacementPhotoIDs *[]string
	if body.PhotoIDs != nil {
		unique := uniqueAlbumPhotoIDs(*body.PhotoIDs, body.CoverPhoto)
		replacementPhotoIDs = &unique
	}
	sets = append(sets, "updated_at = unixepoch()")
	if err := a.updateAlbumTransaction(r.Context(), id, sets, args, replacementPhotoIDs); err != nil {
		httpx.Error(w, http.StatusBadRequest, "Album could not be updated")
		return
	}
	album, err := a.albums.FindByID(r.Context(), id)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, albumMutationResponse(album))
}

func (a *Application) albumDelete(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	id, ok := parseAlbumIDPath(w, r.PathValue("albumID"))
	if !ok {
		return
	}
	if !a.albumOwned(r.Context(), id, user) {
		httpx.Error(w, http.StatusNotFound, "Album not found")
		return
	}
	if _, err := a.database.SQL().ExecContext(r.Context(), "DELETE FROM albums WHERE id = ?", id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *Application) albumPhotoDelete(w http.ResponseWriter, r *http.Request) {
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	albumID, albumOK := parseAlbumIDPath(w, r.PathValue("albumID"))
	if !albumOK {
		return
	}
	photoID := r.PathValue("photoID")
	if photoID == "" || !a.albumOwned(r.Context(), albumID, user) {
		httpx.Error(w, http.StatusNotFound, "Album not found")
		return
	}
	result, err := a.database.SQL().ExecContext(r.Context(),
		"DELETE FROM album_photos WHERE album_id = ? AND photo_id = ?", albumID, photoID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "Photo not found in album")
		return
	}
	_, _ = a.database.SQL().ExecContext(r.Context(),
		"UPDATE albums SET cover_photo_id = NULL, updated_at = unixepoch() WHERE id = ? AND cover_photo_id = ?",
		albumID, photoID)
	httpx.JSON(w, http.StatusOK, map[string]any{"success": true})
}

func (a *Application) albumOwned(ctx context.Context, id int64, user *auth.User) bool {
	if user == nil {
		return false
	}
	var owner int64
	err := a.database.SQL().QueryRowContext(ctx, "SELECT owner_user_id FROM albums WHERE id = ?", id).Scan(&owner)
	return err == nil && (user.IsAdmin != 0 || owner == user.ID)
}

func jsStringLength(value string) int {
	length := 0
	for _, character := range value {
		length++
		if character > 0xffff {
			length++
		}
	}
	return length
}

func uniqueAlbumPhotoIDs(photoIDs []string, coverPhotoID *string) []string {
	unique := make([]string, 0, len(photoIDs))
	seen := map[string]struct{}{}
	for _, value := range photoIDs {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		unique = append(unique, value)
	}
	if coverPhotoID != nil && *coverPhotoID != "" {
		if _, exists := seen[*coverPhotoID]; !exists {
			unique = append(unique, *coverPhotoID)
		}
	}
	return unique
}

func (a *Application) albumPhotosOwned(
	ctx context.Context,
	photoIDs []string,
	user *auth.User,
) (bool, error) {
	if user == nil {
		return false, nil
	}
	for _, photoID := range photoIDs {
		var owner int64
		err := a.database.SQL().QueryRowContext(
			ctx,
			"SELECT owner_user_id FROM photos WHERE id = ?",
			photoID,
		).Scan(&owner)
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if user.IsAdmin == 0 && owner != user.ID {
			return false, nil
		}
	}
	return true, nil
}

func (a *Application) createAlbumTransaction(
	ctx context.Context,
	body albumCreateBody,
	ownerID int64,
	photoIDs []string,
) (int64, error) {
	tx, err := a.database.SQL().BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	now := a.now().Unix()
	result, err := tx.ExecContext(ctx, `
		INSERT INTO albums(title,description,cover_photo_id,is_hidden,created_at,updated_at,owner_user_id)
		VALUES(?,?,?,?,?,?,?)
	`, body.Title, albumEmptyStringAsNil(body.Description), albumEmptyStringAsNil(body.CoverPhoto),
		boolInt(body.IsHidden), now, now, ownerID)
	if err != nil {
		return 0, err
	}
	albumID, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}
	if err := replaceAlbumPhotosTx(ctx, tx, albumID, photoIDs); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return albumID, nil
}

func (a *Application) updateAlbumTransaction(
	ctx context.Context,
	albumID int64,
	sets []string,
	args []any,
	photoIDs *[]string,
) error {
	tx, err := a.database.SQL().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	updateArgs := append(append([]any{}, args...), albumID)
	if _, err := tx.ExecContext(
		ctx,
		"UPDATE albums SET "+strings.Join(sets, ", ")+" WHERE id = ?",
		updateArgs...,
	); err != nil {
		return err
	}
	if photoIDs != nil {
		if err := replaceAlbumPhotosTx(ctx, tx, albumID, *photoIDs); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func replaceAlbumPhotosTx(
	ctx context.Context,
	tx *sql.Tx,
	albumID int64,
	photoIDs []string,
) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM album_photos WHERE album_id = ?", albumID); err != nil {
		return err
	}
	position := float64(1000000)
	for _, photoID := range photoIDs {
		position += 10
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO album_photos(album_id,photo_id,position,added_at) VALUES(?,?,?,unixepoch())",
			albumID, photoID, position); err != nil {
			return err
		}
	}
	return nil
}
