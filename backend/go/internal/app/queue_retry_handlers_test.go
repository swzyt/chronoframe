package app

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDecodeQueueRetryBodyMatchesNodeZodSchema(t *testing.T) {
	for _, test := range []struct {
		name    string
		body    string
		message string
	}{
		{
			name:    "missing task id",
			body:    `{}`,
			message: zodValidationMessage(zodInvalidTypeIssue([]any{"taskId"}, "number", "undefined")),
		},
		{
			name:    "null task id",
			body:    `{"taskId":null}`,
			message: zodValidationMessage(zodInvalidTypeIssue([]any{"taskId"}, "number", "null")),
		},
		{
			name:    "fractional task id",
			body:    `{"taskId":1.5}`,
			message: zodValidationMessage(zodInvalidIntIssue([]any{"taskId"})),
		},
		{
			name:    "non-positive task id",
			body:    `{"taskId":0}`,
			message: zodValidationMessage(zodPositiveNumberIssue([]any{"taskId"})),
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			_, ok := decodeQueueRetryBody(
				response,
				httptest.NewRequest(http.MethodPost, "/api/queue/task/retry", strings.NewReader(test.body)),
			)
			if ok {
				t.Fatal("decodeQueueRetryBody() ok = true, want false")
			}
			expectAlbumValidationError(t, response, test.message)
		})
	}
}

func TestQueueTaskPathIDMatchesJavaScriptNumberCoercion(t *testing.T) {
	for raw, want := range map[string]int64{
		"910001":    910001,
		"910001.0":  910001,
		"9.10001e5": 910001,
		"0xde2b1":   910001,
		" 910001  ": 910001,
	} {
		got, ok := queueTaskPathID(raw)
		if !ok || got != want {
			t.Fatalf("queueTaskPathID(%q) = (%d, %v), want (%d, true)", raw, got, ok, want)
		}
	}
	for _, raw := range []string{"not-a-number", "1.5", "Infinity", "0xnope"} {
		if got, ok := queueTaskPathID(raw); ok {
			t.Fatalf("queueTaskPathID(%q) = (%d, true), want invalid", raw, got)
		}
	}
}

func TestDecodeQueueRetryBatchBodyMatchesNodeZodSchema(t *testing.T) {
	response := httptest.NewRecorder()
	_, ok := decodeQueueRetryBatchBody(
		response,
		httptest.NewRequest(
			http.MethodPost,
			"/api/queue/task/retry-batch",
			strings.NewReader(`{"taskIds":null,"retryAll":null}`),
		),
	)
	if ok {
		t.Fatal("decodeQueueRetryBatchBody() ok = true, want false")
	}
	wantMessage := zodValidationMessage(
		zodInvalidTypeIssue([]any{"taskIds"}, "array", "null"),
		zodInvalidTypeIssue([]any{"retryAll"}, "boolean", "null"),
	)
	expectAlbumValidationError(t, response, wantMessage)

	response = httptest.NewRecorder()
	body, ok := decodeQueueRetryBatchBody(
		response,
		httptest.NewRequest(
			http.MethodPost,
			"/api/queue/task/retry-batch",
			strings.NewReader(`{"taskIds":[7,7],"retryAll":false}`),
		),
	)
	if !ok {
		t.Fatalf("valid retry batch body rejected: %s", response.Body.String())
	}
	if !reflect.DeepEqual(body.TaskIDs, []int64{7, 7}) || body.RetryAll {
		t.Fatalf("decoded retry batch body = %#v, want duplicate IDs preserved", body)
	}
}

func TestQueueRetrySummariesMatchNodeResponseShape(t *testing.T) {
	payload := map[string]any{
		"type":        "photo",
		"storageKey":  "users/1/retry.jpg",
		"contentHash": "ignored-by-retry-response",
	}

	if got, want := queueRetryPayloadSummary(payload), map[string]any{
		"type":       "photo",
		"storageKey": "users/1/retry.jpg",
	}; !reflect.DeepEqual(got, want) {
		t.Fatalf("queueRetryPayloadSummary() = %#v, want %#v", got, want)
	}

	task := queueRetryTask{ID: 91001, Status: "failed", Payload: payload}
	if got, want := queueRetryTaskSummary(task), map[string]any{
		"id":         int64(91001),
		"type":       "photo",
		"storageKey": "users/1/retry.jpg",
	}; !reflect.DeepEqual(got, want) {
		t.Fatalf("queueRetryTaskSummary() = %#v, want %#v", got, want)
	}

	skipped := queueRetrySkippedTaskSummary(queueRetryTask{ID: 91002, Status: "pending"})
	if got, want := skipped, map[string]any{
		"id":     int64(91002),
		"status": "pending",
		"reason": "Task is not in failed status (current: pending)",
	}; !reflect.DeepEqual(got, want) {
		t.Fatalf("queueRetrySkippedTaskSummary() = %#v, want %#v", got, want)
	}
}

func TestQueueRetryTasksAndResetMatchNodeSemantics(t *testing.T) {
	ctx := context.Background()
	_, store := newWizardTestApplication(t)
	insertWizardUser(t, store.SQL(), "owner@example.test")
	if _, err := store.SQL().Exec(`
		INSERT INTO pipeline_queue(
			id, payload, priority, attempts, max_attempts, status,
			status_stage, error_message, created_at, available_at,
			claimed_by, claim_token, claim_expires_at, completed_at,
			owner_user_id
		)
		VALUES
			(
				91001,
				'{"type":"photo","storageKey":"users/1/failed.jpg","contentHash":"abc"}',
				0, 2, 3, 'failed',
				'thumbnail', 'boom', 1, 1,
				'go-worker', 'claim-token', 2, 3,
				1
			),
			(
				91002,
				'{"type":"photo","storageKey":"users/1/pending.jpg"}',
				0, 0, 3, 'pending',
				NULL, NULL, 1, 1,
				NULL, NULL, NULL, NULL,
				1
			)
	`); err != nil {
		t.Fatal(err)
	}

	application := &Application{database: store}
	tasks, err := application.queueRetryTasks(ctx, false, []int64{91001, 91002, 99999})
	if err != nil {
		t.Fatalf("queueRetryTasks() error = %v", err)
	}
	if len(tasks) != 2 || tasks[0].ID != 91001 || tasks[1].ID != 91002 {
		t.Fatalf("queueRetryTasks() = %#v, want failed and pending existing tasks only", tasks)
	}
	if got := tasks[0].Payload["storageKey"]; got != "users/1/failed.jpg" {
		t.Fatalf("failed task storageKey = %#v", got)
	}

	if err := application.resetQueueTasksForRetry(ctx, []int64{91001}); err != nil {
		t.Fatalf("resetQueueTasksForRetry() error = %v", err)
	}

	var (
		status         string
		attempts       int64
		statusStage    sql.NullString
		errorMessage   sql.NullString
		claimedBy      sql.NullString
		claimToken     sql.NullString
		claimExpiresAt sql.NullInt64
	)
	if err := store.SQL().QueryRow(`
		SELECT status, attempts, status_stage, error_message,
		       claimed_by, claim_token, claim_expires_at
		FROM pipeline_queue WHERE id = 91001
	`).Scan(&status, &attempts, &statusStage, &errorMessage, &claimedBy, &claimToken, &claimExpiresAt); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || attempts != 0 {
		t.Fatalf("reset status/attempts = %s/%d, want pending/0", status, attempts)
	}
	for name, value := range map[string]bool{
		"status_stage":     statusStage.Valid,
		"error_message":    errorMessage.Valid,
		"claimed_by":       claimedBy.Valid,
		"claim_token":      claimToken.Valid,
		"claim_expires_at": claimExpiresAt.Valid,
	} {
		if value {
			t.Fatalf("%s should be NULL after retry reset", name)
		}
	}

	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if err := application.resetQueueTasksForRetry(ctx, []int64{91001}); err == nil {
		t.Fatal("resetQueueTasksForRetry(closed DB) error = nil")
	}
}

func TestQueueClearOptionsMatchNodeQueryDefaults(t *testing.T) {
	now := time.Date(2026, 9, 12, 3, 4, 5, 6_000_000, time.UTC)

	defaults, err := parseQueueClearOptions(map[string][]string{}, now)
	if err != nil {
		t.Fatalf("parseQueueClearOptions(defaults) error = %v", err)
	}
	if !defaults.IncludeCompleted || !defaults.IncludeFailed || defaults.OlderThanDays != nil {
		t.Fatalf("default options = %#v, want completed+failed without age filter", defaults)
	}

	filtered, err := parseQueueClearOptions(map[string][]string{
		"includeCompleted": {"0"},
		"includeFailed":    {"true"},
		"olderThanDays":    {"2"},
	}, now)
	if err != nil {
		t.Fatalf("parseQueueClearOptions(filtered) error = %v", err)
	}
	if filtered.IncludeCompleted || !filtered.IncludeFailed {
		t.Fatalf("filtered include flags = completed:%v failed:%v, want false/true", filtered.IncludeCompleted, filtered.IncludeFailed)
	}
	if filtered.OlderThanDays == nil || *filtered.OlderThanDays != 2 {
		t.Fatalf("olderThanDays = %#v, want 2", filtered.OlderThanDays)
	}
	if got, want := filtered.ThresholdDate, "2026-09-10T03:04:05.006Z"; got != want {
		t.Fatalf("thresholdDate = %q, want %q", got, want)
	}
	large, err := parseQueueClearOptions(map[string][]string{
		"olderThanDays": {"200000"},
	}, now)
	if err != nil {
		t.Fatalf("parseQueueClearOptions(large olderThanDays) error = %v", err)
	}
	if got, want := large.ThresholdUnix, int64(-15490817755); got != want {
		t.Fatalf("large threshold unix = %d, want %d", got, want)
	}
	if got, want := large.ThresholdDate, "1479-02-12T03:04:05.006Z"; got != want {
		t.Fatalf("large threshold date = %q, want %q", got, want)
	}
	for raw, want := range map[string]int64{
		"200000x":  200000,
		"200000.5": 200000,
		" 200000 ": 200000,
		"0x30d40":  200000,
		"+200000":  200000,
	} {
		parsed, err := parseQueueClearOptions(map[string][]string{
			"olderThanDays": {raw},
		}, now)
		if err != nil {
			t.Fatalf("parseQueueClearOptions(%q) error = %v", raw, err)
		}
		if parsed.OlderThanDays == nil || *parsed.OlderThanDays != want {
			t.Fatalf("parseQueueClearOptions(%q) olderThanDays = %#v, want %d", raw, parsed.OlderThanDays, want)
		}
	}

	if _, err := parseQueueClearOptions(map[string][]string{
		"includeCompleted": {"false"},
		"includeFailed":    {"false"},
	}, now); err == nil || err.Error() != "At least one of includeCompleted or includeFailed must be true" {
		t.Fatalf("disabled flags error = %v", err)
	}
	if _, err := parseQueueClearOptions(map[string][]string{
		"olderThanDays": {"-1"},
	}, now); err == nil || err.Error() != "olderThanDays must be a non-negative integer" {
		t.Fatalf("negative age error = %v", err)
	}
	for _, query := range []map[string][]string{
		{"includeCompleted": {"false", "true"}},
		{"includeFailed": {"false", "true"}},
		{"olderThanDays": {"1", "2"}},
	} {
		if _, err := parseQueueClearOptions(query, now); !errors.Is(err, errQueueClearQueryShape) {
			t.Fatalf("repeated query error = %v, want errQueueClearQueryShape", err)
		}
	}
}

func TestClearQueueTasksMatchesNodeResponseShape(t *testing.T) {
	ctx := context.Background()
	_, store := newWizardTestApplication(t)
	insertWizardUser(t, store.SQL(), "owner@example.test")

	now := time.Date(2026, 9, 12, 3, 4, 5, 6_000_000, time.UTC)
	days := int64(2)
	threshold := now.Add(-time.Duration(days) * 24 * time.Hour)
	if _, err := store.SQL().Exec(`
		INSERT INTO pipeline_queue(
			id, payload, priority, attempts, max_attempts, status,
			status_stage, error_message, created_at, available_at,
			claimed_by, claim_token, claim_expires_at, completed_at,
			owner_user_id
		)
		VALUES
			(92001, '{"type":"photo","storageKey":"users/1/completed.jpg"}', 0, 0, 3, 'completed', NULL, NULL, ?, ?, NULL, NULL, NULL, ?, 1),
			(92002, '{"type":"photo","storageKey":"users/1/failed.jpg"}', 0, 1, 3, 'failed', NULL, 'boom', ?, ?, NULL, NULL, NULL, NULL, 1),
			(92003, '{"type":"photo","storageKey":"users/1/recent-failed.jpg"}', 0, 1, 3, 'failed', NULL, 'new', ?, ?, NULL, NULL, NULL, NULL, 1),
			(92004, '{"type":"photo","storageKey":"users/1/pending.jpg"}', 0, 0, 3, 'pending', NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, 1)
	`,
		threshold.Unix()-1, threshold.Unix()-1, threshold.Unix()-1,
		threshold.Unix()-2, threshold.Unix()-2,
		threshold.Unix()+1, threshold.Unix()+1,
		threshold.Unix()-3, threshold.Unix()-3,
	); err != nil {
		t.Fatal(err)
	}

	application := &Application{database: store}
	response, err := application.clearQueueTasks(ctx, queueClearOptions{
		IncludeCompleted: true,
		IncludeFailed:    true,
		OlderThanDays:    &days,
		ThresholdUnix:    threshold.Unix(),
		ThresholdDate:    threshold.UTC().Format("2006-01-02T15:04:05.000Z"),
	})
	if err != nil {
		t.Fatalf("clearQueueTasks() error = %v", err)
	}

	want := map[string]any{
		"success":      true,
		"message":      "Successfully cleared 2 non-active tasks",
		"deletedCount": int64(2),
		"breakdown": map[string]any{
			"completed": int64(1),
			"failed":    int64(1),
		},
		"filter": map[string]any{
			"olderThanDays": int64(2),
			"thresholdDate": "2026-09-10T03:04:05.006Z",
		},
	}
	if !reflect.DeepEqual(response, want) {
		t.Fatalf("clearQueueTasks() = %#v, want %#v", response, want)
	}

	var remaining int
	if err := store.SQL().QueryRow(`
		SELECT COUNT(*)
		FROM pipeline_queue
		WHERE id IN (92003, 92004)
	`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 2 {
		t.Fatalf("remaining active/recent rows = %d, want 2", remaining)
	}

	empty, err := application.clearQueueTasks(ctx, queueClearOptions{
		IncludeCompleted: true,
		IncludeFailed:    false,
	})
	if err != nil {
		t.Fatalf("clearQueueTasks(empty) error = %v", err)
	}
	wantEmpty := map[string]any{
		"success":      true,
		"message":      "No tasks found to clear",
		"deletedCount": int64(0),
		"breakdown": map[string]any{
			"completed": int64(0),
			"failed":    int64(0),
		},
	}
	if !reflect.DeepEqual(empty, wantEmpty) {
		t.Fatalf("clearQueueTasks(empty) = %#v, want %#v", empty, wantEmpty)
	}
}

func TestParseJavaScriptParseInt10Int64MatchesStorageRouteCoercion(t *testing.T) {
	for raw, want := range map[string]int64{
		"910001":               910001,
		"910001abc":            910001,
		"910001.9":             910001,
		"  +910001x ":          910001,
		"0x0de291":             0,
		"-1.5":                 -1,
		"-9223372036854775808": math.MinInt64,
	} {
		got, ok := parseJavaScriptParseInt10Int64(raw)
		if !ok || got != want {
			t.Fatalf("parseJavaScriptParseInt10Int64(%q) = (%d, %v), want (%d, true)", raw, got, ok, want)
		}
	}
	for _, raw := range []string{"", " ", "abc", ".5", "+", "9223372036854775808"} {
		if got, ok := parseJavaScriptParseInt10Int64(raw); ok {
			t.Fatalf("parseJavaScriptParseInt10Int64(%q) = (%d, true), want invalid", raw, got)
		}
	}
}
