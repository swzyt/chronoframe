package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/auth"
)

type fakeSystemStatsRedis struct {
	value string
}

func (redis fakeSystemStatsRedis) Ping(context.Context) error {
	return nil
}

func (redis fakeSystemStatsRedis) GetString(context.Context, string) (string, error) {
	if redis.value == "" {
		return "", errors.New("missing")
	}
	return redis.value, nil
}

func TestBuildSystemStatsMemberMatchesNodePrivacyScope(t *testing.T) {
	ctx := context.Background()
	_, store := newWizardTestApplication(t)
	if _, err := store.SQL().Exec(`
		INSERT INTO users(id,name,email,password,created_at,is_admin,is_active,auth_version)
		VALUES
			(1, 'admin', 'admin@example.test', '$2a$10$placeholder', unixepoch(), 1, 1, 1),
			(2, 'member', 'member@example.test', '$2a$10$placeholder', unixepoch(), 0, 1, 1)
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SQL().Exec(`
		INSERT INTO photos(id, title, date_taken, file_size, owner_user_id)
		VALUES
			('member-today', 'Member Today', '2026-09-12T01:00:00.000Z', 100, 2),
			('member-week', 'Member Week', '2026-09-10T01:00:00.000Z', 300, 2),
			('member-old', 'Member Old', '2026-08-01T01:00:00.000Z', 50, 2),
			('admin-today', 'Admin Today', '2026-09-12T01:00:00.000Z', 999, 1)
	`); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 9, 12, 3, 4, 5, 6_000_000, time.UTC)
	application := &Application{
		database: store,
		now:      func() time.Time { return now },
	}
	stats, err := application.buildSystemStats(ctx, &auth.User{ID: 2, IsAdmin: 0})
	if err != nil {
		t.Fatalf("buildSystemStats() error = %v", err)
	}

	if got := stats.Uptime; got != 0 {
		t.Fatalf("member uptime = %#v, want 0", got)
	}
	if got := stats.RunningOn; got != "unknown" {
		t.Fatalf("member runningOn = %#v, want unknown", got)
	}
	if got := stats.WorkerPool; got != nil {
		t.Fatalf("member workerPool = %#v, want nil", got)
	}
	if got, want := stats.Memory, (systemStatsMemory{Used: 0, Total: 0}); got != want {
		t.Fatalf("member memory = %#v, want %#v", got, want)
	}

	if got, want := stats.Photos, (systemStatsPhotos{
		Total:     3,
		Today:     1,
		ThisWeek:  2,
		ThisMonth: 2,
	}); got != want {
		t.Fatalf("photos = %#v, want %#v", got, want)
	}

	if got, want := stats.Storage.TotalSize, int64(450); got != want {
		t.Fatalf("storage totalSize = %#v, want %#v", got, want)
	}
	if got, want := stats.Storage.AverageSize, float64(150); got != want {
		t.Fatalf("storage averageSize = %#v, want %#v", got, want)
	}
	if got, want := stats.Storage.MaxSize, int64(300); got != want {
		t.Fatalf("storage maxSize = %#v, want %#v", got, want)
	}

	trends := stats.Trends
	if len(trends) != 7 {
		t.Fatalf("trends length = %d, want 7", len(trends))
	}
	if got, want := trends[0], (systemStatsTrend{Date: "2026-09-12", Count: 1}); got != want {
		t.Fatalf("today trend = %#v, want %#v", got, want)
	}
	if got, want := trends[2], (systemStatsTrend{Date: "2026-09-10", Count: 1}); got != want {
		t.Fatalf("week trend = %#v, want %#v", got, want)
	}
	if got, want := stats.Timestamp, "2026-09-12T03:04:05.006Z"; got != want {
		t.Fatalf("timestamp = %#v, want %#v", got, want)
	}
}

func TestBuildSystemStatsAdminUsesSharedWorkerPoolTelemetry(t *testing.T) {
	ctx := context.Background()
	_, store := newWizardTestApplication(t)
	if _, err := store.SQL().Exec(`
		INSERT INTO users(id,name,email,password,created_at,is_admin,is_active,auth_version)
		VALUES (1, 'admin', 'admin@example.test', '$2a$10$placeholder', unixepoch(), 1, 1, 1)
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SQL().Exec(`
		INSERT INTO photos(id, title, date_taken, file_size, owner_user_id)
		VALUES ('admin-today', 'Admin Today', '2026-09-12T01:00:00.000Z', 100, 1)
	`); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 9, 12, 3, 4, 5, 6_000_000, time.UTC)
	application := &Application{
		database:  store,
		redis:     fakeSystemStatsRedis{value: `{"backend":"node","pool":{"isActive":true,"workerCount":5,"totalWorkers":5,"activeWorkers":1,"totalProcessed":7,"totalErrors":0,"averageSuccessRate":100,"supportedTaskTypes":["go-only"],"workers":[{"workerId":"worker-1","isProcessing":true,"processedCount":7,"errorCount":0,"uptime":12,"successRate":100}]}}`},
		now:       func() time.Time { return now },
		startedAt: now.Add(-2 * time.Second),
	}
	stats, err := application.buildSystemStats(ctx, &auth.User{ID: 1, IsAdmin: 1})
	if err != nil {
		t.Fatalf("buildSystemStats() error = %v", err)
	}

	if got := stats.Uptime; got != 2 {
		t.Fatalf("uptime = %#v, want 2", got)
	}
	workerPool, ok := stats.WorkerPool.(map[string]any)
	if !ok {
		t.Fatalf("workerPool = %#v, want map", stats.WorkerPool)
	}
	for _, internalKey := range []string{"isActive", "workerCount", "supportedTaskTypes"} {
		if _, ok := workerPool[internalKey]; ok {
			t.Fatalf("workerPool includes internal key %q: %#v", internalKey, workerPool)
		}
	}
	if got, want := workerPool["totalWorkers"], float64(5); got != want {
		t.Fatalf("totalWorkers = %#v, want %#v", got, want)
	}
	workers, ok := workerPool["workers"].([]any)
	if !ok || len(workers) != 1 {
		t.Fatalf("workers = %#v, want one worker", workerPool["workers"])
	}
}

func TestQueueStatsPoolShapeOmitsGoOnlyInternalFields(t *testing.T) {
	input := map[string]any{
		"isActive":           true,
		"workerCount":        1,
		"totalWorkers":       1,
		"supportedTaskTypes": []string{"photo-erase-location"},
		"workers":            []any{},
	}

	got := queueStatsPoolShape(input)

	if _, ok := got["supportedTaskTypes"]; ok {
		t.Fatalf("queue stats pool includes supportedTaskTypes: %#v", got)
	}
	if _, ok := input["supportedTaskTypes"]; !ok {
		t.Fatalf("queueStatsPoolShape mutated input: %#v", input)
	}
	if got["isActive"] != true || got["workerCount"] != 1 {
		t.Fatalf("queue stats pool dropped public fields: %#v", got)
	}
}
