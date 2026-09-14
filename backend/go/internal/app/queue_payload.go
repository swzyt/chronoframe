package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/swzyt/chronoframe/backend/go/internal/auth"
)

type queuePayloadMode int

const (
	queuePayloadModeAddTask queuePayloadMode = iota
	queuePayloadModeAddTasks
	queuePayloadModePublicUpload
)

var errQueuePayloadValidation = errors.New("Validation Error")

type queueAccessError struct {
	status  int
	message string
}

func (e queueAccessError) Error() string {
	return e.message
}

func sanitizeQueuePayload(payload map[string]any, mode queuePayloadMode) (map[string]any, error) {
	taskType, ok := requiredPayloadString(payload, "type")
	if !ok {
		return nil, errQueuePayloadValidation
	}

	switch taskType {
	case "photo":
		storageKey, ok := requiredPayloadString(payload, "storageKey")
		if !ok {
			return nil, errQueuePayloadValidation
		}
		result := map[string]any{"type": taskType, "storageKey": storageKey}
		if mode != queuePayloadModeAddTasks {
			if err := copyOptionalContentHash(payload, result); err != nil {
				return nil, err
			}
		}
		if err := copyOptionalPayloadBool(payload, result, "eraseLocation"); err != nil {
			return nil, err
		}
		return result, nil
	case "live-photo-video":
		storageKey, ok := requiredPayloadString(payload, "storageKey")
		if !ok {
			return nil, errQueuePayloadValidation
		}
		return map[string]any{"type": taskType, "storageKey": storageKey}, nil
	case "video":
		if mode == queuePayloadModeAddTasks {
			return nil, errQueuePayloadValidation
		}
		storageKey, ok := requiredPayloadString(payload, "storageKey")
		if !ok {
			return nil, errQueuePayloadValidation
		}
		result := map[string]any{"type": taskType, "storageKey": storageKey}
		if err := copyOptionalContentHash(payload, result); err != nil {
			return nil, err
		}
		return result, nil
	case "photo-reverse-geocoding":
		if mode == queuePayloadModePublicUpload {
			return nil, errQueuePayloadValidation
		}
		photoID, ok := requiredPayloadString(payload, "photoId")
		if !ok {
			return nil, errQueuePayloadValidation
		}
		result := map[string]any{"type": taskType, "photoId": photoID}
		if err := copyOptionalNumberInRange(payload, result, "latitude", -90, 90); err != nil {
			return nil, err
		}
		if err := copyOptionalNumberInRange(payload, result, "longitude", -180, 180); err != nil {
			return nil, err
		}
		return result, nil
	case "photo-erase-location":
		if mode == queuePayloadModePublicUpload {
			return nil, errQueuePayloadValidation
		}
		photoID, ok := requiredPayloadString(payload, "photoId")
		if !ok {
			return nil, errQueuePayloadValidation
		}
		return map[string]any{"type": taskType, "photoId": photoID}, nil
	default:
		return nil, errQueuePayloadValidation
	}
}

func requiredPayloadString(payload map[string]any, key string) (string, bool) {
	value, ok := payload[key].(string)
	return value, ok && value != ""
}

func copyOptionalPayloadBool(source map[string]any, target map[string]any, key string) error {
	value, ok := source[key]
	if !ok {
		return nil
	}
	boolValue, ok := value.(bool)
	if !ok {
		return errQueuePayloadValidation
	}
	target[key] = boolValue
	return nil
}

func copyOptionalContentHash(source map[string]any, target map[string]any) error {
	value, ok := source["contentHash"]
	if !ok {
		return nil
	}
	hash, ok := value.(string)
	if !ok || normalizeContentHash(hash) == "" {
		return errQueuePayloadValidation
	}
	target["contentHash"] = hash
	return nil
}

func copyOptionalNumberInRange(source map[string]any, target map[string]any, key string, minimum float64, maximum float64) error {
	value, ok := source[key]
	if !ok {
		return nil
	}
	number, ok := value.(json.Number)
	if !ok {
		return errQueuePayloadValidation
	}
	parsed, err := strconv.ParseFloat(number.String(), 64)
	if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) || parsed < minimum || parsed > maximum {
		return errQueuePayloadValidation
	}
	target[key] = parsed
	return nil
}

func parseOptionalQueueNumber(value json.Number, fallback float64, minimum float64, maximum float64) (float64, error) {
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseFloat(value.String(), 64)
	if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) || parsed < minimum || parsed > maximum {
		return 0, errQueuePayloadValidation
	}
	return parsed, nil
}

type queueTaskInput struct {
	Payload     map[string]any
	Priority    float64
	MaxAttempts float64
}

type queueNumberField struct {
	Value   float64
	Present bool
}

func decodeQueueAddTaskBody(w http.ResponseWriter, r *http.Request) (queueTaskInput, bool) {
	object, ok := decodeRequiredJSONObjectBody(w, r)
	if !ok {
		return queueTaskInput{}, false
	}

	payload, issues := decodeQueuePayloadRaw(object["payload"], []any{"payload"}, queuePayloadModeAddTask)
	priority, priorityIssues := decodeOptionalQueueNumberField(object, "priority", []any{"priority"}, 0, 0, 9)
	issues = append(issues, priorityIssues...)
	maxAttempts, maxAttemptIssues := decodeOptionalQueueNumberField(object, "maxAttempts", []any{"maxAttempts"}, 3, 1, 5)
	issues = append(issues, maxAttemptIssues...)
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return queueTaskInput{}, false
	}

	return queueTaskInput{
		Payload:     payload,
		Priority:    priority.Value,
		MaxAttempts: maxAttempts.Value,
	}, true
}

func decodeQueueAddTasksBody(w http.ResponseWriter, r *http.Request) ([]queueTaskInput, bool) {
	object, ok := decodeRequiredJSONObjectBody(w, r)
	if !ok {
		return nil, false
	}

	type taskDraft struct {
		payload     map[string]any
		priority    queueNumberField
		maxAttempts queueNumberField
	}

	issues := make([]zodValidationIssue, 0)
	drafts := make([]taskDraft, 0)
	tasksRaw, tasksExist := object["tasks"]
	if !tasksExist || zodReceivedType(tasksRaw) != "array" {
		issues = append(issues, zodInvalidTypeIssue([]any{"tasks"}, "array", zodReceivedType(tasksRaw)))
	} else {
		var taskValues []json.RawMessage
		if err := json.Unmarshal(tasksRaw, &taskValues); err != nil {
			issues = append(issues, zodInvalidTypeIssue([]any{"tasks"}, "array", zodReceivedType(tasksRaw)))
		} else {
			drafts = make([]taskDraft, 0, len(taskValues))
			for index, taskRaw := range taskValues {
				itemPath := []any{"tasks", index}
				if zodReceivedType(taskRaw) != "object" {
					issues = append(issues, zodInvalidTypeIssue(itemPath, "object", zodReceivedType(taskRaw)))
					continue
				}
				var taskObject map[string]json.RawMessage
				if err := json.Unmarshal(taskRaw, &taskObject); err != nil {
					issues = append(issues, zodInvalidTypeIssue(itemPath, "object", zodReceivedType(taskRaw)))
					continue
				}
				payload, payloadIssues := decodeQueuePayloadRaw(
					taskObject["payload"],
					appendZodPath(itemPath, "payload"),
					queuePayloadModeAddTasks,
				)
				issues = append(issues, payloadIssues...)
				priority, priorityIssues := decodeOptionalQueueNumberField(
					taskObject,
					"priority",
					appendZodPath(itemPath, "priority"),
					0,
					0,
					9,
				)
				issues = append(issues, priorityIssues...)
				maxAttempts, maxAttemptIssues := decodeOptionalQueueNumberField(
					taskObject,
					"maxAttempts",
					appendZodPath(itemPath, "maxAttempts"),
					0,
					1,
					5,
				)
				issues = append(issues, maxAttemptIssues...)
				drafts = append(drafts, taskDraft{
					payload:     payload,
					priority:    priority,
					maxAttempts: maxAttempts,
				})
			}
			if len(taskValues) < 1 {
				issues = append(issues, zodTooSmallArrayIssue(
					[]any{"tasks"},
					1,
					"At least one task is required",
				))
			}
			if len(taskValues) > 1000 {
				issues = append(issues, zodTooBigArrayIssue(
					[]any{"tasks"},
					1000,
					"Too many tasks: maximum 1000 tasks per batch",
				))
			}
		}
	}

	defaultPriority, priorityIssues := decodeOptionalQueueNumberField(
		object,
		"defaultPriority",
		[]any{"defaultPriority"},
		0,
		0,
		9,
	)
	issues = append(issues, priorityIssues...)
	defaultMaxAttempts, maxAttemptIssues := decodeOptionalQueueNumberField(
		object,
		"defaultMaxAttempts",
		[]any{"defaultMaxAttempts"},
		3,
		1,
		5,
	)
	issues = append(issues, maxAttemptIssues...)
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return nil, false
	}

	tasks := make([]queueTaskInput, 0, len(drafts))
	for _, draft := range drafts {
		priority := defaultPriority.Value
		if draft.priority.Present {
			priority = draft.priority.Value
		}
		maxAttempts := defaultMaxAttempts.Value
		if draft.maxAttempts.Present {
			maxAttempts = draft.maxAttempts.Value
		}
		tasks = append(tasks, queueTaskInput{
			Payload:     draft.payload,
			Priority:    priority,
			MaxAttempts: maxAttempts,
		})
	}
	return tasks, true
}

func decodeOptionalQueueNumberField(
	object map[string]json.RawMessage,
	field string,
	path []any,
	fallback float64,
	minimum float64,
	maximum float64,
) (queueNumberField, []zodValidationIssue) {
	raw, exists := object[field]
	if !exists {
		return queueNumberField{Value: fallback}, nil
	}
	if zodReceivedType(raw) != "number" {
		return queueNumberField{Present: true}, []zodValidationIssue{
			zodInvalidTypeIssue(path, "number", zodReceivedType(raw)),
		}
	}
	value, err := strconv.ParseFloat(string(raw), 64)
	if err != nil || math.IsInf(value, 0) || math.IsNaN(value) {
		return queueNumberField{Present: true}, []zodValidationIssue{
			zodInvalidTypeIssue(path, "number", "number"),
		}
	}
	result := queueNumberField{Value: value, Present: true}
	if value < minimum {
		return result, []zodValidationIssue{zodTooSmallNumberIssue(path, int(minimum))}
	}
	if value > maximum {
		return result, []zodValidationIssue{zodTooBigNumberIssue(path, int(maximum))}
	}
	return result, nil
}

func decodeQueuePayloadRaw(
	raw json.RawMessage,
	path []any,
	mode queuePayloadMode,
) (map[string]any, []zodValidationIssue) {
	if zodReceivedType(raw) != "object" {
		return nil, []zodValidationIssue{
			zodInvalidTypeCodeFirstIssue(path, "object", zodReceivedType(raw)),
		}
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, []zodValidationIssue{
			zodInvalidTypeCodeFirstIssue(path, "object", zodReceivedType(raw)),
		}
	}

	taskType, exists, valid := decodeJSONStringField(object, "type")
	allowedTypes := queuePayloadTypes(mode)
	if !exists || !valid || !stringInList(taskType, allowedTypes) {
		return nil, []zodValidationIssue{
			zodInvalidDiscriminatorIssue(appendZodPath(path, "type"), "type", allowedTypes...),
		}
	}

	issues := make([]zodValidationIssue, 0)
	payload := map[string]any{"type": taskType}
	switch taskType {
	case "photo":
		decodeRequiredQueuePayloadString(object, "storageKey", path, payload, &issues)
		if mode != queuePayloadModeAddTasks {
			decodeOptionalQueueContentHash(object, path, payload, &issues)
		}
		decodeOptionalQueuePayloadBool(object, "eraseLocation", path, payload, &issues)
	case "live-photo-video":
		decodeRequiredQueuePayloadString(object, "storageKey", path, payload, &issues)
	case "video":
		decodeRequiredQueuePayloadString(object, "storageKey", path, payload, &issues)
		decodeOptionalQueueContentHash(object, path, payload, &issues)
	case "photo-reverse-geocoding":
		decodeRequiredQueuePayloadString(object, "photoId", path, payload, &issues)
		decodeOptionalQueuePayloadNumber(object, "latitude", path, -90, 90, payload, &issues)
		decodeOptionalQueuePayloadNumber(object, "longitude", path, -180, 180, payload, &issues)
	case "photo-erase-location":
		decodeRequiredQueuePayloadString(object, "photoId", path, payload, &issues)
	}
	return payload, issues
}

func queuePayloadTypes(mode queuePayloadMode) []string {
	if mode == queuePayloadModeAddTasks {
		return []string{"photo", "live-photo-video", "photo-reverse-geocoding", "photo-erase-location"}
	}
	return []string{"photo", "live-photo-video", "video", "photo-reverse-geocoding", "photo-erase-location"}
}

func decodeRequiredQueuePayloadString(
	object map[string]json.RawMessage,
	field string,
	basePath []any,
	payload map[string]any,
	issues *[]zodValidationIssue,
) {
	path := appendZodPath(basePath, field)
	value, exists, valid := decodeJSONStringField(object, field)
	if !exists || !valid {
		*issues = append(*issues, zodInvalidTypeIssue(path, "string", zodReceivedType(object[field])))
		return
	}
	if value == "" {
		*issues = append(*issues, zodTooSmallStringIssue(path, 1))
		return
	}
	payload[field] = value
}

func decodeOptionalQueueContentHash(
	object map[string]json.RawMessage,
	basePath []any,
	payload map[string]any,
	issues *[]zodValidationIssue,
) {
	value, exists, valid := decodeJSONStringField(object, "contentHash")
	if !exists {
		return
	}
	path := appendZodPath(basePath, "contentHash")
	if !valid {
		*issues = append(*issues, zodInvalidTypeIssue(path, "string", zodReceivedType(object["contentHash"])))
		return
	}
	if !contentHashPattern.MatchString(strings.ToLower(value)) {
		*issues = append(*issues, zodInvalidFormatIssue(
			path,
			"regex",
			"/^[a-f0-9]{64}$/i",
			"Invalid string: must match pattern /^[a-f0-9]{64}$/i",
		))
		return
	}
	payload["contentHash"] = value
}

func decodeOptionalQueuePayloadBool(
	object map[string]json.RawMessage,
	field string,
	basePath []any,
	payload map[string]any,
	issues *[]zodValidationIssue,
) {
	value, exists, valid := decodeJSONBoolField(object, field)
	if !exists {
		return
	}
	path := appendZodPath(basePath, field)
	if !valid {
		*issues = append(*issues, zodInvalidTypeIssue(path, "boolean", zodReceivedType(object[field])))
		return
	}
	payload[field] = value
}

func decodeOptionalQueuePayloadNumber(
	object map[string]json.RawMessage,
	field string,
	basePath []any,
	minimum int,
	maximum int,
	payload map[string]any,
	issues *[]zodValidationIssue,
) {
	raw, exists := object[field]
	if !exists {
		return
	}
	path := appendZodPath(basePath, field)
	if zodReceivedType(raw) != "number" {
		*issues = append(*issues, zodInvalidTypeIssue(path, "number", zodReceivedType(raw)))
		return
	}
	value, err := strconv.ParseFloat(string(raw), 64)
	if err != nil || math.IsInf(value, 0) || math.IsNaN(value) {
		*issues = append(*issues, zodInvalidTypeIssue(path, "number", "number"))
		return
	}
	if value < float64(minimum) {
		*issues = append(*issues, zodTooSmallNumberIssue(path, minimum))
		return
	}
	if value > float64(maximum) {
		*issues = append(*issues, zodTooBigNumberIssue(path, maximum))
		return
	}
	payload[field] = value
}

func appendZodPath(path []any, segments ...any) []any {
	result := make([]any, 0, len(path)+len(segments))
	result = append(result, path...)
	result = append(result, segments...)
	return result
}

func stringInList(value string, values []string) bool {
	for _, candidate := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func (a *Application) requireQueuePayloadAccess(ctx context.Context, user *auth.User, payload map[string]any) error {
	if user == nil {
		return queueAccessError{status: 401, message: "Unauthorized"}
	}
	if user.IsAdmin != 0 {
		return nil
	}

	if photoID, ok := payload["photoId"].(string); ok {
		var exists int64
		if err := a.database.SQL().QueryRowContext(ctx, `
			SELECT EXISTS(
				SELECT 1
				FROM photos
				WHERE id = ? AND owner_user_id = ?
			)
		`, photoID, user.ID).Scan(&exists); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return queueAccessError{status: 404, message: "Photo not found"}
			}
			return fmt.Errorf("queue photo access lookup: %w", err)
		}
		if exists == 0 {
			return queueAccessError{status: 404, message: "Photo not found"}
		}
		return nil
	}

	storageKey, _ := payload["storageKey"].(string)
	provider, err := a.mediaProvider(ctx)
	if err != nil {
		return queueAccessError{status: 503, message: "Storage provider unavailable"}
	}
	if !isUserUploadStorageKey(provider, user.ID, storageKey) {
		return queueAccessError{status: 404, message: "Storage object not found"}
	}
	return nil
}

func isQueueAccessError(err error) (queueAccessError, bool) {
	var accessErr queueAccessError
	if errors.As(err, &accessErr) {
		return accessErr, true
	}
	return queueAccessError{}, false
}

func uploadShareStorageKeyPrefix(provider interface{ StoragePrefix() string }, ownerUserID int64, shareID int64) string {
	return joinStorageKey(provider.StoragePrefix(), "users", fmt.Sprint(ownerUserID), "guest-uploads", fmt.Sprint(shareID))
}

func isUploadShareStorageKey(provider interface{ StoragePrefix() string }, ownerUserID int64, shareID int64, storageKey string) bool {
	prefix := uploadShareStorageKeyPrefix(provider, ownerUserID, shareID)
	return strings.HasPrefix(normalizeStorageKeyForAuth(storageKey), prefix+"/")
}
