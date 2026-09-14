package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/auth"
	"github.com/swzyt/chronoframe/backend/go/internal/photos"
	"github.com/swzyt/chronoframe/backend/go/internal/platform/httpx"
	"github.com/swzyt/chronoframe/backend/go/internal/queue"
	"github.com/swzyt/chronoframe/backend/go/internal/settings"
	"github.com/swzyt/chronoframe/backend/go/internal/storage"
	"github.com/swzyt/chronoframe/backend/go/internal/uploads"
)

var knownSettingNamespaces = map[string]struct{}{
	"system":    {},
	"app":       {},
	"privacy":   {},
	"map":       {},
	"location":  {},
	"storage":   {},
	"analytics": {},
	"site":      {},
}

var knownSettingNamespaceValues = []string{
	"system",
	"app",
	"privacy",
	"map",
	"location",
	"storage",
	"analytics",
	"site",
}

var knownSettingKeys = map[string]struct{}{
	"access.enabled":                {},
	"access.passwordHash":           {},
	"access.previewAlbumLimit":      {},
	"access.previewPhotoLimit":      {},
	"access.version":                {},
	"amap.key":                      {},
	"amap.securityJsCode":           {},
	"amap.webServiceKey":            {},
	"appearance.theme":              {},
	"auth.github.clientId":          {},
	"auth.github.clientSecret":      {},
	"auth.github.enabled":           {},
	"author":                        {},
	"avatarUrl":                     {},
	"backend.readProvider":          {},
	"backup.cron":                   {},
	"backup.enabled":                {},
	"backup.encryptionPassphrase":   {},
	"backup.mailFrom":               {},
	"backup.mailTo":                 {},
	"backup.retentionDays":          {},
	"backup.smtpHost":               {},
	"backup.smtpPassword":           {},
	"backup.smtpPort":               {},
	"backup.smtpSecure":             {},
	"backup.smtpUser":               {},
	"backup.timezone":               {},
	"bodyScripts":                   {},
	"customFooter":                  {},
	"customHeader":                  {},
	"firstLaunch":                   {},
	"headScripts":                   {},
	"icpNumber":                     {},
	"language":                      {},
	"mapbox.style":                  {},
	"mapbox.token":                  {},
	"maplibre.style":                {},
	"maplibre.token":                {},
	"nominatim.baseUrl":             {},
	"policeNumber":                  {},
	"provider":                      {},
	"slogan":                        {},
	"title":                         {},
	"upload.autoEraseLocation":      {},
	"upload.duplicateCheck.enabled": {},
	"upload.duplicateCheck.mode":    {},
	"upload.maxFileSize":            {},
	"webglImageViewerDebug":         {},
}

var knownSettingKeyValues = []string{
	"firstLaunch",
	"backend.readProvider",
	"title",
	"slogan",
	"author",
	"avatarUrl",
	"appearance.theme",
	"access.enabled",
	"access.passwordHash",
	"access.version",
	"access.previewPhotoLimit",
	"access.previewAlbumLimit",
	"upload.maxFileSize",
	"upload.duplicateCheck.enabled",
	"upload.duplicateCheck.mode",
	"webglImageViewerDebug",
	"auth.github.enabled",
	"auth.github.clientId",
	"auth.github.clientSecret",
	"backup.enabled",
	"backup.cron",
	"backup.timezone",
	"backup.retentionDays",
	"backup.smtpHost",
	"backup.smtpPort",
	"backup.smtpSecure",
	"backup.smtpUser",
	"backup.smtpPassword",
	"backup.mailFrom",
	"backup.mailTo",
	"backup.encryptionPassphrase",
	"upload.autoEraseLocation",
	"provider",
	"mapbox.token",
	"mapbox.style",
	"maplibre.token",
	"maplibre.style",
	"amap.key",
	"amap.securityJsCode",
	"language",
	"nominatim.baseUrl",
	"amap.webServiceKey",
	"headScripts",
	"bodyScripts",
	"icpNumber",
	"policeNumber",
	"customHeader",
	"customFooter",
}

const jsMaxSafeInteger = int64(9007199254740991)

func isKnownSettingNamespace(namespace string) bool {
	_, ok := knownSettingNamespaces[namespace]
	return ok
}

func isKnownSettingKey(key string) bool {
	_, ok := knownSettingKeys[key]
	return ok
}

type zodEnumIssue struct {
	path   []any
	values []string
}

func writeSettingParamValidationError(w http.ResponseWriter, issues ...zodEnumIssue) {
	validationIssues := make([]zodValidationIssue, 0, len(issues))
	for _, issue := range issues {
		validationIssues = append(validationIssues, zodEnumValidationIssue(issue))
	}
	writeSettingZodValidationError(w, validationIssues...)
}

type zodValidationIssue struct {
	kind          string
	path          []any
	values        []string
	expected      string
	received      string
	minimum       int
	maximum       int
	format        string
	pattern       string
	message       string
	discriminator string
}

func writeSettingZodValidationError(w http.ResponseWriter, issues ...zodValidationIssue) {
	message := zodValidationMessage(issues...)
	httpx.ErrorWithMessageData(
		w,
		http.StatusBadRequest,
		"Validation Error",
		message,
		zodErrorData{Name: "ZodError", Message: message},
	)
}

func zodEnumValidationMessage(issues ...zodEnumIssue) string {
	validationIssues := make([]zodValidationIssue, 0, len(issues))
	for _, issue := range issues {
		validationIssues = append(validationIssues, zodEnumValidationIssue(issue))
	}
	return zodValidationMessage(validationIssues...)
}

func zodEnumValidationIssue(issue zodEnumIssue) zodValidationIssue {
	return zodValidationIssue{
		kind:   "invalid_value",
		path:   issue.path,
		values: issue.values,
	}
}

func zodInvalidTypeIssue(path []any, expected string, received string) zodValidationIssue {
	kind := "invalid_type_expected_first"
	if expected == "nonoptional" {
		kind = "invalid_type_code_first"
	}
	return zodValidationIssue{
		kind:     kind,
		path:     path,
		expected: expected,
		received: received,
	}
}

func zodInvalidTypeCodeFirstIssue(path []any, expected string, received string) zodValidationIssue {
	return zodValidationIssue{
		kind:     "invalid_type_code_first",
		path:     path,
		expected: expected,
		received: received,
	}
}

func zodInvalidDiscriminatorIssue(path []any, discriminator string, values ...string) zodValidationIssue {
	return zodValidationIssue{
		kind:          "invalid_discriminator_union",
		path:          path,
		discriminator: discriminator,
		values:        values,
	}
}

func zodTooSmallStringIssue(path []any, minimum int) zodValidationIssue {
	return zodValidationIssue{
		kind:    "too_small_string",
		path:    path,
		minimum: minimum,
	}
}

func zodTooSmallNumberIssue(path []any, minimum int) zodValidationIssue {
	return zodValidationIssue{
		kind:    "too_small_number",
		path:    path,
		minimum: minimum,
	}
}

func zodPositiveNumberIssue(path []any) zodValidationIssue {
	return zodValidationIssue{
		kind:    "positive_number",
		path:    path,
		minimum: 0,
	}
}

func zodTooBigStringIssue(path []any, maximum int) zodValidationIssue {
	return zodValidationIssue{
		kind:    "too_big_string",
		path:    path,
		maximum: maximum,
	}
}

func zodTooBigNumberIssue(path []any, maximum int) zodValidationIssue {
	return zodValidationIssue{
		kind:    "too_big_number",
		path:    path,
		maximum: maximum,
	}
}

func zodTooSmallArrayIssue(path []any, minimum int, message string) zodValidationIssue {
	return zodValidationIssue{
		kind:    "too_small_array",
		path:    path,
		minimum: minimum,
		message: message,
	}
}

func zodTooBigArrayIssue(path []any, maximum int, message string) zodValidationIssue {
	return zodValidationIssue{
		kind:    "too_big_array",
		path:    path,
		maximum: maximum,
		message: message,
	}
}

func zodInvalidIntIssue(path []any) zodValidationIssue {
	return zodValidationIssue{
		kind:     "invalid_type_int",
		path:     path,
		expected: "int",
		received: "number",
	}
}

func zodInvalidFormatIssue(path []any, format string, pattern string, message string) zodValidationIssue {
	return zodValidationIssue{
		kind:    "invalid_format_string",
		path:    path,
		format:  format,
		pattern: pattern,
		message: message,
	}
}

func zodCustomIssue(path []any, message string) zodValidationIssue {
	return zodValidationIssue{
		kind:    "custom",
		path:    path,
		message: message,
	}
}

func zodValidationMessage(issues ...zodValidationIssue) string {
	var builder strings.Builder
	builder.WriteString("[\n")
	for issueIndex, issue := range issues {
		if issueIndex > 0 {
			builder.WriteString(",\n")
		}
		builder.WriteString("  {\n")
		switch issue.kind {
		case "invalid_value":
			builder.WriteString("    \"code\": \"invalid_value\",\n")
			builder.WriteString("    \"values\": [\n")
			for valueIndex, value := range issue.values {
				builder.WriteString("      \"")
				builder.WriteString(value)
				builder.WriteString("\"")
				if valueIndex < len(issue.values)-1 {
					builder.WriteString(",")
				}
				builder.WriteString("\n")
			}
			builder.WriteString("    ],\n")
			writeZodPath(&builder, issue.path)
			builder.WriteString("    \"message\": \"")
			writeZodEnumIssueMessage(&builder, issue.values)
			builder.WriteString("\"\n")
		case "invalid_type_expected_first":
			builder.WriteString("    \"expected\": \"")
			builder.WriteString(issue.expected)
			builder.WriteString("\",\n")
			builder.WriteString("    \"code\": \"invalid_type\",\n")
			writeZodPath(&builder, issue.path)
			builder.WriteString("    \"message\": \"Invalid input: expected ")
			builder.WriteString(issue.expected)
			builder.WriteString(", received ")
			builder.WriteString(issue.received)
			builder.WriteString("\"\n")
		case "invalid_type_code_first":
			builder.WriteString("    \"code\": \"invalid_type\",\n")
			builder.WriteString("    \"expected\": \"")
			builder.WriteString(issue.expected)
			builder.WriteString("\",\n")
			writeZodPath(&builder, issue.path)
			builder.WriteString("    \"message\": \"Invalid input: expected ")
			builder.WriteString(issue.expected)
			builder.WriteString(", received ")
			builder.WriteString(issue.received)
			builder.WriteString("\"\n")
		case "invalid_discriminator_union":
			builder.WriteString("    \"code\": \"invalid_union\",\n")
			builder.WriteString("    \"errors\": [],\n")
			builder.WriteString("    \"note\": \"No matching discriminator\",\n")
			builder.WriteString("    \"discriminator\": \"")
			builder.WriteString(issue.discriminator)
			builder.WriteString("\",\n")
			builder.WriteString("    \"options\": [\n")
			for valueIndex, value := range issue.values {
				builder.WriteString("      \"")
				builder.WriteString(value)
				builder.WriteString("\"")
				if valueIndex < len(issue.values)-1 {
					builder.WriteString(",")
				}
				builder.WriteString("\n")
			}
			builder.WriteString("    ],\n")
			writeZodPath(&builder, issue.path)
			builder.WriteString("    \"message\": \"")
			writeZodDiscriminatorIssueMessage(&builder, issue.values)
			builder.WriteString("\"\n")
		case "too_small_string":
			builder.WriteString("    \"origin\": \"string\",\n")
			builder.WriteString("    \"code\": \"too_small\",\n")
			builder.WriteString("    \"minimum\": ")
			builder.WriteString(strconv.Itoa(issue.minimum))
			builder.WriteString(",\n")
			builder.WriteString("    \"inclusive\": true,\n")
			writeZodPath(&builder, issue.path)
			builder.WriteString("    \"message\": \"Too small: expected string to have >=")
			builder.WriteString(strconv.Itoa(issue.minimum))
			builder.WriteString(" characters\"\n")
		case "too_small_number":
			builder.WriteString("    \"origin\": \"number\",\n")
			builder.WriteString("    \"code\": \"too_small\",\n")
			builder.WriteString("    \"minimum\": ")
			builder.WriteString(strconv.Itoa(issue.minimum))
			builder.WriteString(",\n")
			builder.WriteString("    \"inclusive\": true,\n")
			writeZodPath(&builder, issue.path)
			builder.WriteString("    \"message\": \"Too small: expected number to be >=")
			builder.WriteString(strconv.Itoa(issue.minimum))
			builder.WriteString("\"\n")
		case "positive_number":
			builder.WriteString("    \"origin\": \"number\",\n")
			builder.WriteString("    \"code\": \"too_small\",\n")
			builder.WriteString("    \"minimum\": ")
			builder.WriteString(strconv.Itoa(issue.minimum))
			builder.WriteString(",\n")
			builder.WriteString("    \"inclusive\": false,\n")
			writeZodPath(&builder, issue.path)
			builder.WriteString("    \"message\": \"Too small: expected number to be >0\"\n")
		case "too_big_string":
			builder.WriteString("    \"origin\": \"string\",\n")
			builder.WriteString("    \"code\": \"too_big\",\n")
			builder.WriteString("    \"maximum\": ")
			builder.WriteString(strconv.Itoa(issue.maximum))
			builder.WriteString(",\n")
			builder.WriteString("    \"inclusive\": true,\n")
			writeZodPath(&builder, issue.path)
			builder.WriteString("    \"message\": \"Too big: expected string to have <=")
			builder.WriteString(strconv.Itoa(issue.maximum))
			builder.WriteString(" characters\"\n")
		case "too_big_number":
			builder.WriteString("    \"origin\": \"number\",\n")
			builder.WriteString("    \"code\": \"too_big\",\n")
			builder.WriteString("    \"maximum\": ")
			builder.WriteString(strconv.Itoa(issue.maximum))
			builder.WriteString(",\n")
			builder.WriteString("    \"inclusive\": true,\n")
			writeZodPath(&builder, issue.path)
			builder.WriteString("    \"message\": \"Too big: expected number to be <=")
			builder.WriteString(strconv.Itoa(issue.maximum))
			builder.WriteString("\"\n")
		case "too_small_array":
			builder.WriteString("    \"origin\": \"array\",\n")
			builder.WriteString("    \"code\": \"too_small\",\n")
			builder.WriteString("    \"minimum\": ")
			builder.WriteString(strconv.Itoa(issue.minimum))
			builder.WriteString(",\n")
			builder.WriteString("    \"inclusive\": true,\n")
			writeZodPath(&builder, issue.path)
			builder.WriteString("    \"message\": \"")
			builder.WriteString(issue.message)
			builder.WriteString("\"\n")
		case "too_big_array":
			builder.WriteString("    \"origin\": \"array\",\n")
			builder.WriteString("    \"code\": \"too_big\",\n")
			builder.WriteString("    \"maximum\": ")
			builder.WriteString(strconv.Itoa(issue.maximum))
			builder.WriteString(",\n")
			builder.WriteString("    \"inclusive\": true,\n")
			writeZodPath(&builder, issue.path)
			builder.WriteString("    \"message\": \"")
			builder.WriteString(issue.message)
			builder.WriteString("\"\n")
		case "invalid_type_int":
			builder.WriteString("    \"expected\": \"int\",\n")
			builder.WriteString("    \"format\": \"safeint\",\n")
			builder.WriteString("    \"code\": \"invalid_type\",\n")
			writeZodPath(&builder, issue.path)
			builder.WriteString("    \"message\": \"Invalid input: expected int, received number\"\n")
		case "invalid_format_string":
			builder.WriteString("    \"origin\": \"string\",\n")
			builder.WriteString("    \"code\": \"invalid_format\",\n")
			builder.WriteString("    \"format\": \"")
			builder.WriteString(issue.format)
			builder.WriteString("\",\n")
			builder.WriteString("    \"pattern\": \"")
			builder.WriteString(issue.pattern)
			builder.WriteString("\",\n")
			writeZodPath(&builder, issue.path)
			builder.WriteString("    \"message\": \"")
			builder.WriteString(issue.message)
			builder.WriteString("\"\n")
		default:
			builder.WriteString("    \"code\": \"custom\",\n")
			writeZodPath(&builder, issue.path)
			builder.WriteString("    \"message\": \"")
			if issue.message == "" {
				builder.WriteString("Validation Error")
			} else {
				builder.WriteString(issue.message)
			}
			builder.WriteString("\"\n")
		}
		builder.WriteString("  }")
	}
	builder.WriteString("\n]")
	return builder.String()
}

func writeZodPath(builder *strings.Builder, path []any) {
	if len(path) == 0 {
		builder.WriteString("    \"path\": [],\n")
		return
	}
	builder.WriteString("    \"path\": [")
	builder.WriteString("\n")
	for index, segment := range path {
		builder.WriteString("      ")
		switch typed := segment.(type) {
		case int:
			builder.WriteString(strconv.Itoa(typed))
		case int64:
			builder.WriteString(strconv.FormatInt(typed, 10))
		default:
			builder.WriteString("\"")
			builder.WriteString(fmt.Sprint(typed))
			builder.WriteString("\"")
		}
		if index < len(path)-1 {
			builder.WriteString(",")
		}
		builder.WriteString("\n")
	}
	builder.WriteString("    ],\n")
}

func writeZodEnumIssueMessage(builder *strings.Builder, values []string) {
	if len(values) == 1 {
		builder.WriteString("Invalid input: expected \\\"")
		builder.WriteString(values[0])
		builder.WriteString("\\\"")
		return
	}
	builder.WriteString("Invalid option: expected one of ")
	for valueIndex, value := range values {
		if valueIndex > 0 {
			builder.WriteString("|")
		}
		builder.WriteString("\\\"")
		builder.WriteString(value)
		builder.WriteString("\\\"")
	}
}

func writeZodDiscriminatorIssueMessage(builder *strings.Builder, values []string) {
	builder.WriteString("Invalid discriminator value. Expected ")
	for valueIndex, value := range values {
		if valueIndex > 0 {
			builder.WriteString(" | ")
		}
		builder.WriteString("'")
		builder.WriteString(value)
		builder.WriteString("'")
	}
}

func invalidSettingNamespaceIssue() zodEnumIssue {
	return zodEnumIssue{path: []any{"namespace"}, values: knownSettingNamespaceValues}
}

func invalidSettingKeyIssue() zodEnumIssue {
	return zodEnumIssue{path: []any{"key"}, values: knownSettingKeyValues}
}

func invalidSettingNamespaceIssueAt(path ...any) zodEnumIssue {
	return zodEnumIssue{path: path, values: knownSettingNamespaceValues}
}

func invalidSettingKeyIssueAt(path ...any) zodEnumIssue {
	return zodEnumIssue{path: path, values: knownSettingKeyValues}
}

func (a *Application) managedAlbums(w http.ResponseWriter, r *http.Request) {
	if a.albums == nil || a.photos == nil || a.auth == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	albums, err := a.albums.ListManage(r.Context(), user.ID, user.IsAdmin != 0)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "managed albums failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	response := make([]map[string]any, 0, len(albums))
	for _, album := range albums {
		response = append(response, map[string]any{
			"id":           album.ID,
			"title":        album.Title,
			"description":  album.Description,
			"coverPhotoId": album.CoverPhotoID,
			"isHidden":     album.IsHidden,
			"createdAt":    album.CreatedAt,
			"updatedAt":    album.UpdatedAt,
			"ownerUserId":  album.OwnerUserID,
			"owner":        album.Owner,
			"photoIds":     album.PhotoIDs,
		})
	}
	httpx.JSON(w, http.StatusOK, response)
}

func (a *Application) managedPhotos(w http.ResponseWriter, r *http.Request) {
	if a.photos == nil || a.auth == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	query := r.URL.Query()
	paginated := nodeQueryHas(query, "page") || nodeQueryHas(query, "pageSize")
	page := parsePositiveInt64(nodeQueryString(query, "page"), 1, jsMaxSafeInteger)
	pageSize := parsePositiveInt64(nodeQueryString(query, "pageSize"), 50, 200)
	metaOnlyValue := nodeQueryString(query, "metaOnly")
	metaOnly := metaOnlyValue == "1" || metaOnlyValue == "true"
	search := strings.TrimSpace(nodeQueryString(query, "search"))
	mediaType := nodeQueryString(query, "mediaType")
	if paginated && metaOnly {
		result, err := a.photos.ListManage(r.Context(), photos.ManageListOptions{
			UserID: user.ID, IsAdmin: user.IsAdmin != 0,
			Page: page, PageSize: pageSize, Paginated: true,
			Search: search, MediaType: mediaType,
		})
		if err != nil {
			a.logger.ErrorContext(r.Context(), "managed photo count failed",
				"request_id", httpx.RequestID(r.Context()), "error", err)
			httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{
			"items": []any{}, "total": result.Total, "page": page,
			"pageSize": pageSize, "totalPages": result.TotalPages,
		})
		return
	}
	result, err := a.photos.ListManage(r.Context(), photos.ManageListOptions{
		UserID: user.ID, IsAdmin: user.IsAdmin != 0,
		Page: page, PageSize: pageSize, Paginated: paginated,
		Search: search, MediaType: mediaType,
	})
	if err != nil {
		a.logger.ErrorContext(r.Context(), "managed photos failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	owners, err := a.photos.Owners(r.Context(), result.Items)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "managed photo owners failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	albumMap, err := a.photos.AlbumsForPhotos(r.Context(), photoIDs(result.Items))
	if err != nil {
		a.logger.ErrorContext(r.Context(), "managed photo albums failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	items := make([]map[string]any, 0, len(result.Items))
	for _, photo := range result.Items {
		item := privatePhotoRecord(photo)
		item["owner"] = publicOwner(owners[photo.OwnerUserID])
		summaries := albumMap[photo.ID]
		item["albums"] = summaries
		albumIDs := make([]int64, 0, len(summaries))
		for _, summary := range summaries {
			albumIDs = append(albumIDs, summary.ID)
		}
		item["albumIds"] = albumIDs
		items = append(items, item)
	}
	if !paginated {
		httpx.JSON(w, http.StatusOK, items)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "total": result.Total, "page": page,
		"pageSize": pageSize, "totalPages": result.TotalPages,
	})
}

func photoIDs(records []photos.Record) []string {
	result := make([]string, 0, len(records))
	for _, record := range records {
		result = append(result, record.ID)
	}
	return result
}

func publicOwner(user *auth.User) any {
	if user == nil {
		return nil
	}
	return map[string]any{
		"id": user.ID, "username": user.Username, "avatar": user.Avatar,
		"isAdmin": user.IsAdmin,
	}
}

func parsePositiveInt64(value string, fallback, maximum int64) int64 {
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return fallback
	}
	parsed = math.Floor(parsed)
	if parsed < 1 {
		return 1
	}
	if parsed > float64(maximum) {
		return maximum
	}
	return int64(parsed)
}

func (a *Application) settingsNamespace(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.settings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	namespace := r.PathValue("namespace")
	if !isKnownSettingNamespace(namespace) {
		writeSettingParamValidationError(w, invalidSettingNamespaceIssue())
		return
	}
	values, err := a.settings.Namespace(r.Context(), namespace)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "settings namespace failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusNotFound,
			"Namespace "+namespace+" not found or empty")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"namespace": namespace, "settings": values,
	})
}

func (a *Application) settingsKey(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.settings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	namespace, key := r.PathValue("namespace"), r.PathValue("key")
	if !isKnownSettingNamespace(namespace) || !isKnownSettingKey(key) {
		issues := make([]zodEnumIssue, 0, 2)
		if !isKnownSettingNamespace(namespace) {
			issues = append(issues, invalidSettingNamespaceIssue())
		}
		if !isKnownSettingKey(key) {
			issues = append(issues, invalidSettingKeyIssue())
		}
		writeSettingParamValidationError(w, issues...)
		return
	}
	row, err := a.settings.Value(r.Context(), namespace, key)
	if errors.Is(err, sql.ErrNoRows) {
		// Node's SettingsManager.get returns null for a globally valid key that
		// does not exist in the requested namespace. Preserve that observable
		// cross-namespace lookup behavior instead of turning it into a 404.
		httpx.JSON(w, http.StatusOK, map[string]any{
			"namespace": namespace,
			"key":       key,
			"value":     nil,
		})
		return
	}
	if err != nil {
		a.logger.ErrorContext(r.Context(), "setting lookup failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"namespace": namespace,
		"key":       key,
		"value":     settings.DecodeValue(row.Type, row.Value),
	})
}

func (a *Application) settingsSchema(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.settings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	rows, err := a.settings.Schema(r.Context())
	if err != nil {
		a.logger.ErrorContext(r.Context(), "settings schema failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	response := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		value := map[string]any{
			"namespace":    row.Namespace,
			"key":          row.Key,
			"type":         row.Type,
			"value":        row.Value,
			"defaultValue": row.DefaultValue,
			"label":        row.Label,
			"description":  row.Description,
			"isReadonly":   row.IsReadonly,
			"isSecret":     row.IsSecret,
		}
		if len(row.Enum) > 0 {
			value["enum"] = row.Enum
		}
		response = append(response, value)
	}
	httpx.JSON(w, http.StatusOK, response)
}

func (a *Application) settingsFields(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.settings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	rawNamespaces, hasNamespace := r.URL.Query()["namespace"]
	if !hasNamespace {
		writeSettingZodValidationError(w,
			zodInvalidTypeIssue([]any{"namespace"}, "string", "undefined"),
		)
		return
	}
	if nodeQueryIsArray(r.URL.Query(), "namespace") {
		writeSettingZodValidationError(w,
			zodInvalidTypeIssue([]any{"namespace"}, "string", "array"),
		)
		return
	}
	namespace := ""
	if len(rawNamespaces) > 0 {
		namespace = rawNamespaces[0]
	}
	if namespace == "" {
		writeSettingZodValidationError(w,
			zodTooSmallStringIssue([]any{"namespace"}, 1),
		)
		return
	}
	rows, err := a.settings.Schema(r.Context())
	if err != nil {
		a.logger.ErrorContext(r.Context(), "settings fields schema failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	fields := make([]map[string]any, 0)
	for _, row := range rows {
		if row.Namespace != namespace || !isDefaultSettingPair(row.Namespace, row.Key) {
			continue
		}
		field := map[string]any{
			"namespace":    row.Namespace,
			"key":          row.Key,
			"type":         row.Type,
			"value":        row.Value,
			"defaultValue": row.DefaultValue,
			"label":        row.Label,
			"description":  row.Description,
			"isReadonly":   row.IsReadonly,
			"isSecret":     row.IsSecret,
			"ui":           settings.UIConfig(row.Namespace, row.Key),
		}
		if len(row.Enum) > 0 {
			field["enum"] = row.Enum
		}
		fields = append(fields, field)
	}
	if len(fields) == 0 {
		httpx.Error(w, http.StatusNotFound,
			"Namespace "+namespace+" not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"namespace": namespace, "fields": fields,
	})
}

func isDefaultSettingPair(namespace, key string) bool {
	for _, setting := range settings.DefaultSettings {
		if setting.Namespace == namespace && setting.Key == key {
			return true
		}
	}
	return false
}

func (a *Application) storageProviders(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.storage == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	providers, err := a.storage.List(r.Context())
	if err != nil {
		a.logger.ErrorContext(r.Context(), "storage provider list failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	response := make([]map[string]any, 0, len(providers))
	for _, provider := range providers {
		response = append(response, storageProviderMap(provider))
	}
	httpx.JSON(w, http.StatusOK, response)
}

func (a *Application) storageProvider(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.storage == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	id, ok := parseJavaScriptParseInt10Int64(r.PathValue("id"))
	if !ok {
		httpx.Error(w, http.StatusNotFound, "Storage configuration not found")
		return
	}
	provider, err := a.storage.FindByID(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Error(w, http.StatusNotFound, "Storage configuration not found")
		return
	}
	if err != nil {
		a.logger.ErrorContext(r.Context(), "storage provider lookup failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, storageProviderMap(provider))
}

func storageProviderMap(provider storage.Provider) map[string]any {
	return map[string]any{
		"id": provider.ID, "name": provider.Name, "provider": provider.Provider,
		"config": provider.Config, "createdAt": provider.CreatedAt,
		"updatedAt": provider.UpdatedAt,
	}
}

func (a *Application) queueTaskList(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.queue == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	query := r.URL.Query()
	tasks, err := a.queue.List(r.Context(), queue.ListOptions{
		Status: nodeQueryString(query, "status"),
		Type:   nodeQueryString(query, "type"),
	})
	if err != nil {
		a.logger.ErrorContext(r.Context(), "queue task list failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Failed to fetch task list")
		return
	}
	response := make([]map[string]any, 0, len(tasks))
	for _, task := range tasks {
		response = append(response, queueTaskMap(task, false))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"success": true, "data": response,
	})
}

func (a *Application) queueStats(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.queue == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	if consumer := a.PipelineConsumer(); consumer != nil {
		counts, err := a.queue.Counts(r.Context())
		if err != nil {
			a.logger.ErrorContext(r.Context(), "queue counts failed",
				"request_id", httpx.RequestID(r.Context()), "error", err)
			httpx.Error(w, http.StatusInternalServerError, "Failed to get queue status")
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{
			"timestamp": a.now().UTC().Format(time.RFC3339Nano),
			"pool":      queueStatsPoolShape(consumer.PoolStats()),
			"queue":     counts,
		})
		return
	}
	if a.redis != nil {
		if payload := a.sharedPipelineWorkerTelemetry(r.Context()); payload != nil {
			delete(payload, "backend")
			httpx.JSON(w, http.StatusOK, payload)
			return
		}
	}
	counts, err := a.queue.Counts(r.Context())
	if err != nil {
		a.logger.ErrorContext(r.Context(), "queue counts failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Failed to get queue status")
		return
	}
	pool := map[string]any{
		"isActive": false, "workerCount": 0, "totalWorkers": 0,
		"activeWorkers": 0, "totalProcessed": 0, "totalErrors": 0,
		"averageSuccessRate": 0, "workers": []any{},
	}
	if consumer := a.PipelineConsumer(); consumer != nil {
		pool = consumer.PoolStats()
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"timestamp": a.now().UTC().Format(time.RFC3339Nano),
		"pool":      pool,
		"queue":     counts,
	})
}

func (a *Application) sharedPipelineWorkerTelemetry(ctx context.Context) map[string]any {
	if a.redis == nil {
		return nil
	}
	raw, err := a.redis.GetString(ctx, pipelineWorkerTelemetryKey(a.config.Environment))
	if err != nil || strings.TrimSpace(raw) == "" {
		return nil
	}
	var payload map[string]any
	if json.Unmarshal([]byte(raw), &payload) != nil {
		return nil
	}
	return payload
}

func (a *Application) sharedPipelineWorkerPool(ctx context.Context) any {
	payload := a.sharedPipelineWorkerTelemetry(ctx)
	if payload == nil {
		return nil
	}
	if pool, ok := payload["pool"].(map[string]any); ok {
		return systemStatsWorkerPoolShape(pool)
	}
	return payload["pool"]
}

func queueStatsPoolShape(pool map[string]any) map[string]any {
	result := copyMap(pool)
	delete(result, "supportedTaskTypes")
	return result
}

func systemStatsWorkerPoolShape(pool map[string]any) map[string]any {
	result := queueStatsPoolShape(pool)
	delete(result, "isActive")
	delete(result, "workerCount")
	return result
}

func copyMap(input map[string]any) map[string]any {
	output := make(map[string]any, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func pipelineWorkerTelemetryKey(environment string) string {
	if strings.TrimSpace(environment) == "" {
		environment = "development"
	}
	return "cf:v1:" + environment + ":pipeline:worker_pool:stats"
}

func (a *Application) queueTaskStats(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.queue == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	id, ok := queueTaskPathID(r.PathValue("taskID"))
	if !ok {
		httpx.Error(w, http.StatusNotFound, "Task not found")
		return
	}
	task, err := a.queue.FindForUser(r.Context(), id, user.ID, user.IsAdmin != 0)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Error(w, http.StatusNotFound, "Task not found")
		return
	}
	if err != nil {
		a.logger.ErrorContext(r.Context(), "queue task lookup failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Failed to get queue status")
		return
	}
	httpx.JSON(w, http.StatusOK, queueTaskMap(task, true))
}

// queueTaskPathID mirrors Number(taskId) as used by the Node handler. Values
// such as whitespace-padded decimals, hexadecimal integers, exponent notation
// and an integer with a .0 suffix therefore address the same SQLite row.
func queueTaskPathID(value string) (int64, bool) {
	parsed, ok := parseJavaScriptNumber(value)
	if !ok || math.IsInf(parsed, 0) || math.IsNaN(parsed) ||
		math.Trunc(parsed) != parsed || parsed < float64(math.MinInt64) ||
		parsed >= 9223372036854775808.0 {
		return 0, false
	}
	return int64(parsed), true
}

func queueTaskMap(task queue.Task, includeOwner bool) map[string]any {
	value := map[string]any{
		"id": task.ID, "payload": task.Payload, "priority": task.Priority,
		"attempts": task.Attempts, "maxAttempts": task.MaxAttempts,
		"status": task.Status, "statusStage": task.StatusStage,
		"errorMessage": task.ErrorMessage, "createdAt": task.CreatedAt,
		"availableAt": task.AvailableAt, "claimedBy": task.ClaimedBy,
		"claimExpiresAt": task.ClaimExpiresAt, "completedAt": task.CompletedAt,
	}
	if includeOwner {
		value["ownerUserId"] = task.OwnerUserID
		value["claimToken"] = task.ClaimToken
	}
	return value
}

func (a *Application) uploadShares(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.uploads == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	shares, err := a.uploads.ListByOwner(r.Context(), user.ID)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "upload share list failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	origin := requestOrigin(r)
	response := make([]map[string]any, 0, len(shares))
	for _, share := range shares {
		response = append(response, uploads.SerializeShare(share, origin))
	}
	httpx.JSON(w, http.StatusOK, response)
}

func (a *Application) publicUploadShare(w http.ResponseWriter, r *http.Request) {
	if a.uploads == nil || a.settings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	token := r.PathValue("token")
	share, owner, err := a.uploads.FindUsable(r.Context(), token, a.now())
	if err != nil {
		switch {
		case errors.Is(err, uploads.ErrExpired):
			httpx.Error(w, http.StatusGone, "Upload link expired")
		case errors.Is(err, uploads.ErrLimitReached):
			httpx.Error(w, http.StatusTooManyRequests, "Upload link limit reached")
		default:
			httpx.Error(w, http.StatusNotFound, "Upload link not found")
		}
		return
	}
	maxFileSize := a.settingInt(r.Context(), "system", "upload.maxFileSize", 256)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": share.ID, "label": share.Label, "expiresAt": share.ExpiresAt,
		"uploadCount": share.UploadCount, "maxUploads": share.MaxUploads,
		"owner":         map[string]any{"username": owner.Username, "avatar": owner.Avatar},
		"maxFileSizeMB": maxFileSize,
	})
}

func (a *Application) systemStats(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.database == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	response, err := a.buildSystemStats(r.Context(), user)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "system stats failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, response)
}

type systemStatsResponse struct {
	Uptime     float64            `json:"uptime"`
	RunningOn  string             `json:"runningOn"`
	Memory     systemStatsMemory  `json:"memory"`
	Photos     systemStatsPhotos  `json:"photos"`
	WorkerPool any                `json:"workerPool"`
	Storage    systemStatsStorage `json:"storage"`
	Trends     []systemStatsTrend `json:"trends"`
	Timestamp  string             `json:"timestamp"`
}

type systemStatsMemory struct {
	Used  uint64 `json:"used"`
	Total uint64 `json:"total"`
}

type systemStatsPhotos struct {
	Total     int64 `json:"total"`
	Today     int64 `json:"today"`
	ThisWeek  int64 `json:"thisWeek"`
	ThisMonth int64 `json:"thisMonth"`
}

type systemStatsStorage struct {
	TotalSize   int64   `json:"totalSize"`
	AverageSize float64 `json:"averageSize"`
	MaxSize     int64   `json:"maxSize"`
}

type systemStatsTrend struct {
	Date  string `json:"date"`
	Count int64  `json:"count"`
}

func (a *Application) buildSystemStats(ctx context.Context, user *auth.User) (systemStatsResponse, error) {
	where := ""
	args := []any{}
	if user.IsAdmin == 0 {
		where = " WHERE owner_user_id = ?"
		args = append(args, user.ID)
	}
	countSince := func(since string) (int64, error) {
		query := "SELECT COUNT(*) FROM photos" + where
		queryArgs := append([]any{}, args...)
		if since != "" {
			if where == "" {
				query += " WHERE date_taken >= ?"
			} else {
				query += " AND date_taken >= ?"
			}
			queryArgs = append(queryArgs, since)
		}
		var count int64
		if err := a.database.SQL().QueryRowContext(ctx, query, queryArgs...).Scan(&count); err != nil {
			return 0, err
		}
		return count, nil
	}
	now := a.now().UTC()
	startOfDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	startOfWeek := startOfDay.AddDate(0, 0, -7)
	startOfMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	storageQuery := "SELECT COALESCE(SUM(file_size),0), COALESCE(AVG(file_size),0), COALESCE(MAX(file_size),0) FROM photos" + where
	var totalSize, maxSize int64
	var averageSize float64
	if err := a.database.SQL().QueryRowContext(ctx, storageQuery, args...).Scan(&totalSize, &averageSize, &maxSize); err != nil {
		return systemStatsResponse{}, err
	}
	totalPhotos, err := countSince("")
	if err != nil {
		return systemStatsResponse{}, err
	}
	todayPhotos, err := countSince(startOfDay.Format(time.RFC3339))
	if err != nil {
		return systemStatsResponse{}, err
	}
	weekPhotos, err := countSince(startOfWeek.Format(time.RFC3339))
	if err != nil {
		return systemStatsResponse{}, err
	}
	monthPhotos, err := countSince(startOfMonth.Format(time.RFC3339))
	if err != nil {
		return systemStatsResponse{}, err
	}
	trends := make([]systemStatsTrend, 0, 7)
	for offset := 0; offset < 7; offset++ {
		day := startOfDay.AddDate(0, 0, -offset)
		next := day.AddDate(0, 0, 1)
		countQuery := "SELECT COUNT(*) FROM photos" + where
		countArgs := append([]any{}, args...)
		if where == "" {
			countQuery += " WHERE date_taken >= ? AND date_taken < ?"
		} else {
			countQuery += " AND date_taken >= ? AND date_taken < ?"
		}
		countArgs = append(countArgs, day.Format(time.RFC3339), next.Format(time.RFC3339))
		var count int64
		if err := a.database.SQL().QueryRowContext(ctx, countQuery, countArgs...).Scan(&count); err != nil {
			return systemStatsResponse{}, err
		}
		trends = append(trends, systemStatsTrend{Date: day.Format("2006-01-02"), Count: count})
	}
	uptime := float64(0)
	runningOn := "unknown"
	memory := systemStatsMemory{Used: 0, Total: 0}
	var workerPool any
	if user.IsAdmin != 0 {
		uptime = a.uptimeSeconds(now)
		memory = goSystemMemoryStats()
		if isDockerRuntime() {
			runningOn = "docker"
		}
		if consumer := a.PipelineConsumer(); consumer != nil {
			workerPool = systemStatsWorkerPoolShape(consumer.PoolStats())
		} else if sharedWorkerPool := a.sharedPipelineWorkerPool(ctx); sharedWorkerPool != nil {
			workerPool = sharedWorkerPool
		}
	}
	return systemStatsResponse{
		Uptime:    uptime,
		RunningOn: runningOn,
		Memory:    memory,
		Photos: systemStatsPhotos{
			Total:     totalPhotos,
			Today:     todayPhotos,
			ThisWeek:  weekPhotos,
			ThisMonth: monthPhotos,
		},
		WorkerPool: workerPool,
		Storage: systemStatsStorage{
			TotalSize:   totalSize,
			AverageSize: averageSize,
			MaxSize:     maxSize,
		},
		Trends:    trends,
		Timestamp: now.Format("2006-01-02T15:04:05.000Z"),
	}, nil
}

func (a *Application) uptimeSeconds(now time.Time) float64 {
	if a.startedAt.IsZero() {
		return 0
	}
	elapsed := now.Sub(a.startedAt).Seconds()
	if elapsed < 0 {
		return 0
	}
	return elapsed
}

func goSystemMemoryStats() systemStatsMemory {
	if isDockerRuntime() {
		if memory, ok := procMemoryStats(); ok {
			return memory
		}
	}
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	return systemStatsMemory{Used: mem.Alloc, Total: mem.Sys}
}

func procMemoryStats() (systemStatsMemory, bool) {
	raw, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return systemStatsMemory{}, false
	}
	var total, available uint64
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch strings.TrimSuffix(fields[0], ":") {
		case "MemTotal":
			total = value * 1024
		case "MemAvailable":
			available = value * 1024
		}
	}
	if total == 0 {
		return systemStatsMemory{}, false
	}
	used := uint64(0)
	if total > available {
		used = total - available
	}
	return systemStatsMemory{Used: used, Total: total}, true
}

func isDockerRuntime() bool {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return true
	}
	if _, err := os.Stat("/proc/1/cgroup"); err == nil {
		return true
	}
	return false
}

func requestOrigin(r *http.Request) string {
	// The Node dispatcher deliberately removes the upstream Host header and
	// records the public request URL instead. Build user-facing upload-share
	// links from that URL so a Go response never leaks the internal go:8080
	// service address. Caddy strips this header from public requests before
	// proxying to Node, so only the trusted dispatcher can supply it here.
	if original := strings.TrimSpace(r.Header.Get("X-ChronoFrame-Original-URL")); original != "" {
		if parsed, err := url.Parse(original); err == nil &&
			(parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != "" {
			return parsed.Scheme + "://" + parsed.Host
		}
	}
	scheme := "http"
	if strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") || r.TLS != nil {
		scheme = "https"
	}
	if r.Host == "" {
		return ""
	}
	return scheme + "://" + r.Host
}

func wizardStorageFields() []map[string]any {
	definitions := []struct {
		key          string
		valueType    string
		defaultValue any
		label        string
	}{
		{key: "provider", valueType: "string", defaultValue: "local", label: "settings.storage.provider.label"},
		{key: "name", valueType: "string", defaultValue: "Default Storage", label: "settings.storage.name.label"},
		{key: "local.basePath", valueType: "string", defaultValue: "./data/storage", label: "settings.storage.local.basePath.label"},
		{key: "local.baseUrl", valueType: "string", defaultValue: "/storage", label: "settings.storage.local.baseUrl.label"},
		{key: "local.prefix", valueType: "string", defaultValue: "photos/", label: "settings.storage.local.prefix.label"},
		{key: "s3.endpoint", valueType: "string", defaultValue: "", label: "settings.storage.s3.endpoint.label"},
		{key: "s3.bucket", valueType: "string", defaultValue: "", label: "settings.storage.s3.bucket.label"},
		{key: "s3.region", valueType: "string", defaultValue: "auto", label: "settings.storage.s3.region.label"},
		{key: "s3.accessKeyId", valueType: "string", defaultValue: "", label: "settings.storage.s3.accessKeyId.label"},
		{key: "s3.secretAccessKey", valueType: "string", defaultValue: "", label: "settings.storage.s3.secretAccessKey.label"},
		{key: "s3.prefix", valueType: "string", defaultValue: "/photos", label: "settings.storage.s3.prefix.label"},
		{key: "s3.cdnUrl", valueType: "string", defaultValue: "", label: "settings.storage.s3.cdnUrl.label"},
		{key: "s3.forcePathStyle", valueType: "boolean", defaultValue: false, label: "settings.storage.s3.forcePathStyle.label"},
		{key: "s3.maxKeys", valueType: "number", defaultValue: 1000, label: "settings.storage.s3.maxKeys.label"},
		{key: "openlist.baseUrl", valueType: "string", defaultValue: "", label: "settings.storage.openlist.baseUrl.label"},
		{key: "openlist.rootPath", valueType: "string", defaultValue: "/photos", label: "settings.storage.openlist.rootPath.label"},
		{key: "openlist.token", valueType: "string", defaultValue: "", label: "settings.storage.openlist.token.label"},
		{key: "openlist.cdnUrl", valueType: "string", defaultValue: "", label: "settings.storage.openlist.cdnUrl.label"},
		{key: "openlist.uploadEndpoint", valueType: "string", defaultValue: "/api/fs/put", label: "settings.storage.openlist.uploadEndpoint.label"},
		{key: "openlist.downloadEndpoint", valueType: "string", defaultValue: "", label: "settings.storage.openlist.downloadEndpoint.label"},
		{key: "openlist.listEndpoint", valueType: "string", defaultValue: "", label: "settings.storage.openlist.listEndpoint.label"},
		{key: "openlist.deleteEndpoint", valueType: "string", defaultValue: "/api/fs/remove", label: "settings.storage.openlist.deleteEndpoint.label"},
		{key: "openlist.metaEndpoint", valueType: "string", defaultValue: "/api/fs/get", label: "settings.storage.openlist.metaEndpoint.label"},
		{key: "openlist.pathField", valueType: "string", defaultValue: "path", label: "settings.storage.openlist.pathField.label"},
	}
	fields := make([]map[string]any, 0, len(definitions))
	for _, definition := range definitions {
		fields = append(fields, map[string]any{
			"namespace":    "storage",
			"key":          definition.key,
			"type":         definition.valueType,
			"defaultValue": definition.defaultValue,
			"value":        definition.defaultValue,
			"label":        definition.label,
			"ui":           settings.UIConfig("storage", definition.key),
		})
	}
	return fields
}

func wizardMapProviderUI() map[string]any {
	return map[string]any{
		"type": "custom",
		"options": []map[string]any{
			{"label": "wizard.map.provider.mapbox.label", "value": "mapbox", "icon": "simple-icons:mapbox", "description": "wizard.map.provider.mapbox.description"},
			{"label": "wizard.map.provider.maplibre.label", "value": "maplibre", "icon": "simple-icons:maplibre", "description": "wizard.map.provider.maplibre.description"},
			{"label": "wizard.map.provider.amap.label", "value": "amap", "icon": "tabler:map-pin", "description": "wizard.map.provider.amap.description"},
		},
	}
}

func wizardSettingField(row settings.SchemaSetting) map[string]any {
	ui := settings.UIConfig(row.Namespace, row.Key)
	if row.Namespace == "map" && row.Key == "provider" {
		ui = wizardMapProviderUI()
	}
	value := row.Value
	defaultValue := row.DefaultValue
	if row.IsSecret || ui["type"] == "password" {
		value = ""
		defaultValue = ""
	}
	field := map[string]any{
		"namespace":    row.Namespace,
		"key":          row.Key,
		"type":         row.Type,
		"value":        value,
		"defaultValue": defaultValue,
		"label":        row.Label,
		"description":  row.Description,
		"isReadonly":   row.IsReadonly,
		"isSecret":     row.IsSecret,
		"ui":           ui,
	}
	if len(row.Enum) > 0 {
		field["enum"] = row.Enum
	}
	return field
}

func (a *Application) wizardSchema(w http.ResponseWriter, r *http.Request) {
	if a.settings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	row, err := a.settings.Value(r.Context(), "system", "firstLaunch")
	if err != nil || settings.DecodeValue(row.Type, row.Value) != true {
		httpx.Error(w, http.StatusForbidden, "Setup is already complete")
		return
	}
	query := r.URL.Query()
	rawNamespaces, hasNamespace := query["namespace"]
	if !hasNamespace {
		writeSettingZodValidationError(w,
			zodInvalidTypeIssue([]any{"namespace"}, "string", "undefined"),
		)
		return
	}
	if nodeQueryIsArray(query, "namespace") {
		writeSettingZodValidationError(w,
			zodInvalidTypeIssue([]any{"namespace"}, "string", "array"),
		)
		return
	}
	namespace := rawNamespaces[0]
	if namespace == "" {
		writeSettingZodValidationError(w,
			zodTooSmallStringIssue([]any{"namespace"}, 1),
		)
		return
	}
	if namespace == "admin" {
		adminName := a.config.AdminName
		if adminName == "" {
			adminName = "admin"
		}
		httpx.JSON(w, http.StatusOK, map[string]any{
			"namespace": "admin",
			"fields": []map[string]any{
				{"namespace": "admin", "key": "username", "type": "string", "defaultValue": adminName, "value": adminName, "label": "wizard.admin.username.label", "ui": map[string]any{"type": "input", "required": true, "placeholder": "admin"}},
				{"namespace": "admin", "key": "email", "type": "string", "defaultValue": a.config.AdminEmail, "value": a.config.AdminEmail, "label": "wizard.admin.email.label", "ui": map[string]any{"type": "input", "required": true, "placeholder": "admin@example.com"}},
				{"namespace": "admin", "key": "password", "type": "string", "defaultValue": "", "value": "", "label": "wizard.admin.password.label", "ui": map[string]any{"type": "password", "required": true}},
				{"namespace": "admin", "key": "confirmPassword", "type": "string", "defaultValue": "", "value": "", "label": "wizard.admin.confirmPassword.label", "ui": map[string]any{"type": "password", "required": true}},
			},
		})
		return
	}
	if namespace == "storage" {
		httpx.JSON(w, http.StatusOK, map[string]any{
			"namespace": "storage",
			"fields":    wizardStorageFields(),
		})
		return
	}
	rows, err := a.settings.Schema(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Failed to fetch wizard schema")
		return
	}
	fields := make([]map[string]any, 0)
	for _, row := range rows {
		if row.Namespace != namespace {
			continue
		}
		fields = append(fields, wizardSettingField(row))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"namespace": namespace, "fields": fields})
}
