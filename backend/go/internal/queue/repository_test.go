package queue

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

func TestListAcceptsVideoTaskType(t *testing.T) {
	database := openQueueTestDatabase(t)
	defer database.Close()
	repository := NewSQLiteRepository(database)
	insertQueueTask(t, database, 1, `{"type":"video","storageKey":"uploads/clip.mp4"}`, 0, 0, 3, "pending", 10)

	tasks, err := repository.List(context.Background(), ListOptions{Type: "video"})
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].ID != 1 {
		t.Fatalf("List(video) = %#v, want task 1", tasks)
	}
}

func TestListPreservesFractionalQueueNumbersWrittenByNode(t *testing.T) {
	database := openQueueTestDatabase(t)
	defer database.Close()
	repository := NewSQLiteRepository(database)
	insertQueueTask(t, database, 1, `{"type":"photo","storageKey":"uploads/photo.jpg"}`, 1.5, 0, 2.5, "pending", 10)

	tasks, err := repository.List(context.Background(), ListOptions{Type: "photo"})
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].Priority != 1.5 || tasks[0].MaxAttempts != 2.5 {
		t.Fatalf("List(photo) = %#v, want fractional priority 1.5 and maxAttempts 2.5", tasks)
	}
}

func TestClaimNextOnlyClaimsSupportedTypesByPriorityAndAge(t *testing.T) {
	database := openQueueTestDatabase(t)
	defer database.Close()
	repository := NewSQLiteRepository(database)
	insertQueueTask(t, database, 1, `{"type":"photo","storageKey":"uploads/photo.jpg"}`, 9, 0, 3, "pending", 10)
	insertQueueTask(t, database, 2, `{"type":"live-photo-video","storageKey":"uploads/photo.MOV"}`, 1, 0, 3, "pending", 20)
	insertQueueTask(t, database, 3, `{"type":"live-photo-video","storageKey":"uploads/newer.MOV"}`, 1, 0, 3, "pending", 30)
	insertQueueTask(t, database, 4, `{"type":"photo-erase-location","photoId":"photo-a"}`, 8, 0, 3, "pending", 40)

	now := time.Unix(100, 0)
	task, err := repository.ClaimNext(context.Background(), []string{"live-photo-video", "photo-erase-location"}, "go-worker-test", now)
	if err != nil {
		t.Fatal(err)
	}
	if task == nil || task.ID != 4 || task.Status != "in-stages" {
		t.Fatalf("ClaimNext() = %#v, want highest priority supported task 4 in-stages", task)
	}
	if task.ClaimedBy == nil || *task.ClaimedBy != "go-worker-test" || task.ClaimToken == nil || *task.ClaimToken == "" || task.ClaimExpiresAt == nil {
		t.Fatalf("claimed fields = claimedBy:%v claimToken:%v claimExpiresAt:%v, want lease metadata", task.ClaimedBy, task.ClaimToken, task.ClaimExpiresAt)
	}

	statuses := queueStatuses(t, database)
	if statuses[1] != "pending" || statuses[2] != "pending" || statuses[3] != "pending" || statuses[4] != "in-stages" {
		t.Fatalf("statuses = %#v, want unsupported photo left pending and claimed task in-stages", statuses)
	}
}

func TestClaimNextSkipsTasksBeforeAvailableAt(t *testing.T) {
	database := openQueueTestDatabase(t)
	defer database.Close()
	repository := NewSQLiteRepository(database)
	insertQueueTask(t, database, 1, `{"type":"video","storageKey":"uploads/future.mp4"}`, 9, 0, 3, "pending", 10)
	insertQueueTask(t, database, 2, `{"type":"video","storageKey":"uploads/ready.mp4"}`, 1, 0, 3, "pending", 20)
	setQueueTaskAvailableAt(t, database, 1, 999)

	task, err := repository.ClaimNext(context.Background(), []string{"video"}, "go-worker-test", time.Unix(100, 0))
	if err != nil {
		t.Fatal(err)
	}
	if task == nil || task.ID != 2 {
		t.Fatalf("ClaimNext() = %#v, want ready task 2", task)
	}
}

func TestMarkCompletedRejectsLostLease(t *testing.T) {
	database := openQueueTestDatabase(t)
	defer database.Close()
	repository := NewSQLiteRepository(database)
	insertQueueTask(t, database, 1, `{"type":"video","storageKey":"uploads/clip.mp4"}`, 0, 0, 3, "in-stages", 10)
	setQueueTaskClaim(t, database, 1, "go-worker-test", "good-token", 200)

	if err := repository.MarkCompleted(context.Background(), 1, "bad-token"); !errors.Is(err, ErrTaskLeaseLost) {
		t.Fatalf("MarkCompleted with bad token error = %v, want ErrTaskLeaseLost", err)
	}
	if status := queueStatuses(t, database)[1]; status != "in-stages" {
		t.Fatalf("status after bad token = %s, want in-stages", status)
	}

	if err := repository.MarkCompleted(context.Background(), 1, "good-token"); err != nil {
		t.Fatal(err)
	}
	status, token := queueStatusAndClaimToken(t, database, 1)
	if status != "completed" || token != "" {
		t.Fatalf("completed state = status:%s token:%q, want completed with cleared token", status, token)
	}
}

func TestStageAndRefreshRejectLostLease(t *testing.T) {
	database := openQueueTestDatabase(t)
	defer database.Close()
	repository := NewSQLiteRepository(database)
	insertQueueTask(t, database, 1, `{"type":"video","storageKey":"uploads/clip.mp4"}`, 0, 0, 3, "in-stages", 10)
	setQueueTaskClaim(t, database, 1, "go-worker-test", "good-token", 200)

	if err := repository.UpdateStage(context.Background(), 1, "metadata", "bad-token"); !errors.Is(err, ErrTaskLeaseLost) {
		t.Fatalf("UpdateStage with bad token error = %v, want ErrTaskLeaseLost", err)
	}
	status, stage, token, expiresAt := queueClaimState(t, database, 1)
	if status != "in-stages" || stage != "" || token != "good-token" || expiresAt != 200 {
		t.Fatalf("state after bad stage update = status:%s stage:%q token:%q expiresAt:%d, want unchanged active claim", status, stage, token, expiresAt)
	}

	refreshed, err := repository.RefreshClaim(context.Background(), 1, "bad-token", time.Unix(100, 0))
	if err != nil {
		t.Fatal(err)
	}
	if refreshed {
		t.Fatal("RefreshClaim with bad token = true, want false")
	}
	_, _, token, expiresAt = queueClaimState(t, database, 1)
	if token != "good-token" || expiresAt != 200 {
		t.Fatalf("state after bad refresh = token:%q expiresAt:%d, want unchanged active claim", token, expiresAt)
	}

	if err := repository.UpdateStage(context.Background(), 1, "metadata", "good-token"); err != nil {
		t.Fatal(err)
	}
	refreshed, err = repository.RefreshClaim(context.Background(), 1, "good-token", time.Unix(100, 0))
	if err != nil {
		t.Fatal(err)
	}
	if !refreshed {
		t.Fatal("RefreshClaim with good token = false, want true")
	}
	status, stage, token, expiresAt = queueClaimState(t, database, 1)
	if status != "in-stages" || stage != "metadata" || token != "good-token" || expiresAt <= 200 {
		t.Fatalf("state after good updates = status:%s stage:%q token:%q expiresAt:%d, want refreshed claim", status, stage, token, expiresAt)
	}
}

func TestMarkFailedWithRetryMatchesNodeRetryThreshold(t *testing.T) {
	database := openQueueTestDatabase(t)
	defer database.Close()
	repository := NewSQLiteRepository(database)
	insertQueueTask(t, database, 1, `{"type":"live-photo-video","storageKey":"uploads/photo.MOV"}`, 0, 0, 2, "in-stages", 10)
	setQueueTaskClaim(t, database, 1, "go-worker-test", "retry-token-1", 200)

	now := time.Unix(100, 0)
	if err := repository.MarkFailedWithRetry(context.Background(), 1, "retry-token-1", "temporary", now); err != nil {
		t.Fatal(err)
	}
	status, attempts, message, availableAt, token := queueFailureState(t, database, 1)
	if status != "pending" || attempts != 1 || message != "temporary" || availableAt <= now.Unix() || token != "" {
		t.Fatalf("first failure = status:%s attempts:%d message:%s availableAt:%d token:%q, want pending retry after now with cleared token", status, attempts, message, availableAt, token)
	}

	setQueueTaskClaim(t, database, 1, "go-worker-test", "retry-token-2", 300)
	if err := repository.MarkFailedWithRetry(context.Background(), 1, "retry-token-2", "permanent", now); err != nil {
		t.Fatal(err)
	}
	status, attempts, message, _, token = queueFailureState(t, database, 1)
	if status != "failed" || attempts != 2 || message != "permanent" || token != "" {
		t.Fatalf("second failure = status:%s attempts:%d message:%s token:%q, want permanent failed with cleared token", status, attempts, message, token)
	}
}

func TestMarkFailedWithRetrySupportsFractionalNodeThreshold(t *testing.T) {
	database := openQueueTestDatabase(t)
	defer database.Close()
	repository := NewSQLiteRepository(database)
	insertQueueTask(t, database, 1, `{"type":"photo","storageKey":"uploads/photo.jpg"}`, 1.5, 1, 2.5, "in-stages", 10)
	setQueueTaskClaim(t, database, 1, "go-worker-test", "retry-token-1", 200)

	now := time.Unix(100, 0)
	if err := repository.MarkFailedWithRetry(context.Background(), 1, "retry-token-1", "temporary", now); err != nil {
		t.Fatal(err)
	}
	status, attempts, _, _, _ := queueFailureState(t, database, 1)
	if status != "pending" || attempts != 2 {
		t.Fatalf("first fractional failure = status:%s attempts:%d, want pending at attempt 2", status, attempts)
	}

	setQueueTaskClaim(t, database, 1, "go-worker-test", "retry-token-2", 300)
	if err := repository.MarkFailedWithRetry(context.Background(), 1, "retry-token-2", "permanent", now); err != nil {
		t.Fatal(err)
	}
	status, attempts, _, _, _ = queueFailureState(t, database, 1)
	if status != "failed" || attempts != 3 {
		t.Fatalf("second fractional failure = status:%s attempts:%d, want failed at attempt 3", status, attempts)
	}
}

func TestResetExpiredClaimsOnlyRequeuesExpiredLeases(t *testing.T) {
	database := openQueueTestDatabase(t)
	defer database.Close()
	repository := NewSQLiteRepository(database)
	insertQueueTask(t, database, 1, `{"type":"video","storageKey":"uploads/expired.mp4"}`, 0, 0, 3, "in-stages", 10)
	insertQueueTask(t, database, 2, `{"type":"video","storageKey":"uploads/active.mp4"}`, 0, 0, 3, "in-stages", 20)
	setQueueTaskClaim(t, database, 1, "go-worker-test", "expired-token", 99)
	setQueueTaskClaim(t, database, 2, "go-worker-test", "active-token", 200)

	reset, err := repository.ResetExpiredClaims(context.Background(), time.Unix(100, 0))
	if err != nil {
		t.Fatal(err)
	}
	if reset != 1 {
		t.Fatalf("ResetExpiredClaims() = %d, want 1", reset)
	}

	statuses := queueStatuses(t, database)
	if statuses[1] != "pending" || statuses[2] != "in-stages" {
		t.Fatalf("statuses = %#v, want only expired task requeued", statuses)
	}
}

func openQueueTestDatabase(t *testing.T) *sql.DB {
	t.Helper()
	database, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	database.SetMaxOpenConns(1)
	_, err = database.Exec(`
		CREATE TABLE pipeline_queue (
			id INTEGER PRIMARY KEY,
			payload TEXT NOT NULL,
			priority INTEGER NOT NULL DEFAULT 0,
			attempts INTEGER NOT NULL DEFAULT 0,
			max_attempts INTEGER NOT NULL DEFAULT 3,
			status TEXT NOT NULL DEFAULT 'pending',
				status_stage TEXT,
				error_message TEXT,
				created_at INTEGER NOT NULL,
				available_at INTEGER NOT NULL DEFAULT 0,
				claimed_by TEXT,
				claim_token TEXT,
				claim_expires_at INTEGER,
				completed_at INTEGER,
				owner_user_id INTEGER NOT NULL
			);
	`)
	if err != nil {
		t.Fatal(err)
	}
	return database
}

func insertQueueTask(
	t *testing.T,
	database *sql.DB,
	id int64,
	payload string,
	priority float64,
	attempts int64,
	maxAttempts float64,
	status string,
	createdAt int64,
) {
	t.Helper()
	if _, err := database.Exec(`
			INSERT INTO pipeline_queue(id,payload,priority,attempts,max_attempts,status,created_at,available_at,owner_user_id)
			VALUES(?,?,?,?,?,?,?,?,1)
		`, id, payload, priority, attempts, maxAttempts, status, createdAt, createdAt); err != nil {
		t.Fatal(err)
	}
}

func setQueueTaskAvailableAt(t *testing.T, database *sql.DB, id int64, availableAt int64) {
	t.Helper()
	if _, err := database.Exec("UPDATE pipeline_queue SET available_at = ? WHERE id = ?", availableAt, id); err != nil {
		t.Fatal(err)
	}
}

func setQueueTaskClaim(t *testing.T, database *sql.DB, id int64, workerID string, claimToken string, claimExpiresAt int64) {
	t.Helper()
	if _, err := database.Exec(`
		UPDATE pipeline_queue
		SET status = 'in-stages', claimed_by = ?, claim_token = ?, claim_expires_at = ?
		WHERE id = ?
	`, workerID, claimToken, claimExpiresAt, id); err != nil {
		t.Fatal(err)
	}
}

func queueStatuses(t *testing.T, database *sql.DB) map[int64]string {
	t.Helper()
	rows, err := database.Query("SELECT id, status FROM pipeline_queue ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	result := map[int64]string{}
	for rows.Next() {
		var id int64
		var status string
		if err := rows.Scan(&id, &status); err != nil {
			t.Fatal(err)
		}
		result[id] = status
	}
	return result
}

func queueStatusAndClaimToken(t *testing.T, database *sql.DB, id int64) (string, string) {
	t.Helper()
	var status, claimToken string
	if err := database.QueryRow(
		"SELECT status, COALESCE(claim_token,'') FROM pipeline_queue WHERE id = ?",
		id,
	).Scan(&status, &claimToken); err != nil {
		t.Fatal(err)
	}
	return status, claimToken
}

func queueFailureState(t *testing.T, database *sql.DB, id int64) (string, int64, string, int64, string) {
	t.Helper()
	var status, message, claimToken string
	var attempts, availableAt int64
	if err := database.QueryRow(
		"SELECT status, attempts, COALESCE(error_message,''), available_at, COALESCE(claim_token,'') FROM pipeline_queue WHERE id = ?",
		id,
	).Scan(&status, &attempts, &message, &availableAt, &claimToken); err != nil {
		t.Fatal(err)
	}
	return status, attempts, message, availableAt, claimToken
}

func queueClaimState(t *testing.T, database *sql.DB, id int64) (string, string, string, int64) {
	t.Helper()
	var status, stage, claimToken string
	var claimExpiresAt int64
	if err := database.QueryRow(
		"SELECT status, COALESCE(status_stage,''), COALESCE(claim_token,''), COALESCE(claim_expires_at,0) FROM pipeline_queue WHERE id = ?",
		id,
	).Scan(&status, &stage, &claimToken, &claimExpiresAt); err != nil {
		t.Fatal(err)
	}
	return status, stage, claimToken, claimExpiresAt
}
