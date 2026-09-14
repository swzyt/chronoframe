package queue

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	DefaultTaskLeaseTTL = 10 * time.Minute
	claimTokenBytes     = 16
)

var ErrTaskLeaseLost = errors.New("queue task lease is no longer held")

type Task struct {
	ID             int64
	Payload        any
	Priority       float64
	Attempts       int64
	MaxAttempts    float64
	Status         string
	StatusStage    *string
	ErrorMessage   *string
	CreatedAt      string
	AvailableAt    string
	ClaimedBy      *string
	ClaimToken     *string
	ClaimExpiresAt *string
	CompletedAt    *string
	OwnerUserID    int64
}

func (task Task) ClaimTokenValue() string {
	if task.ClaimToken == nil {
		return ""
	}
	return *task.ClaimToken
}

type ListOptions struct {
	Status string
	Type   string
}

type Repository struct {
	db *sql.DB
}

type scanner interface {
	Scan(dest ...any) error
}

func NewSQLiteRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

func (r *Repository) List(ctx context.Context, options ListOptions) ([]Task, error) {
	conditions := make([]string, 0, 2)
	args := make([]any, 0, 2)
	switch options.Status {
	case "", "pending", "in-stages", "completed", "failed":
		if options.Status != "" {
			conditions = append(conditions, "status = ?")
			args = append(args, options.Status)
		}
	default:
		return nil, errors.New("invalid queue status")
	}
	switch options.Type {
	case "":
	case "photo", "live-photo-video", "video", "photo-reverse-geocoding", "photo-erase-location":
		conditions = append(conditions, "json_extract(payload, '$.type') = ?")
		args = append(args, options.Type)
	default:
		return nil, errors.New("invalid queue task type")
	}
	query := `
		SELECT id, payload, priority, attempts, max_attempts, status,
		       status_stage, error_message, created_at, available_at,
		       claimed_by, claim_token, claim_expires_at, completed_at, owner_user_id
		FROM pipeline_queue`
	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}
	query += " ORDER BY created_at DESC"
	return r.query(ctx, query, args...)
}

func (r *Repository) FindForUser(
	ctx context.Context,
	taskID int64,
	userID int64,
	isAdmin bool,
) (Task, error) {
	query := `
		SELECT id, payload, priority, attempts, max_attempts, status,
		       status_stage, error_message, created_at, available_at,
		       claimed_by, claim_token, claim_expires_at, completed_at, owner_user_id
		FROM pipeline_queue
		WHERE id = ?`
	args := []any{taskID}
	if !isAdmin {
		query += " AND owner_user_id = ?"
		args = append(args, userID)
	}
	tasks, err := r.query(ctx, query, args...)
	if err != nil {
		return Task{}, err
	}
	if len(tasks) == 0 {
		return Task{}, sql.ErrNoRows
	}
	return tasks[0], nil
}

func (r *Repository) Counts(ctx context.Context) (map[string]int64, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT status, COUNT(*)
		FROM pipeline_queue
		GROUP BY status
	`)
	if err != nil {
		return nil, fmt.Errorf("queue counts: %w", err)
	}
	defer rows.Close()
	result := make(map[string]int64)
	for rows.Next() {
		var status string
		var count int64
		if err := rows.Scan(&status, &count); err != nil {
			return nil, fmt.Errorf("scan queue count: %w", err)
		}
		result[status] = count
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate queue counts: %w", err)
	}
	return result, nil
}

func (r *Repository) ClaimNext(ctx context.Context, supportedTypes []string, workerID string, now time.Time) (*Task, error) {
	if len(supportedTypes) == 0 {
		return nil, nil
	}
	workerID = strings.TrimSpace(workerID)
	if workerID == "" {
		return nil, errors.New("queue worker id is required")
	}
	typePlaceholders := make([]string, 0, len(supportedTypes))
	typeArgs := make([]any, 0, len(supportedTypes))
	for _, taskType := range supportedTypes {
		normalized := strings.TrimSpace(taskType)
		if normalized == "" {
			continue
		}
		typePlaceholders = append(typePlaceholders, "?")
		typeArgs = append(typeArgs, normalized)
	}
	if len(typePlaceholders) == 0 {
		return nil, nil
	}
	readyAt := now.Unix()
	claimExpiresAt := now.Add(DefaultTaskLeaseTTL).Unix()

	for attempt := 0; attempt < 5; attempt++ {
		claimToken, err := newClaimToken()
		if err != nil {
			return nil, fmt.Errorf("create queue claim token: %w", err)
		}
		tx, err := r.db.BeginTx(ctx, nil)
		if err != nil {
			return nil, fmt.Errorf("begin queue claim: %w", err)
		}
		selectArgs := append([]any{readyAt}, typeArgs...)
		task, err := scanTask(tx.QueryRowContext(ctx, `
				SELECT id, payload, priority, attempts, max_attempts, status,
				       status_stage, error_message, created_at, available_at,
				       claimed_by, claim_token, claim_expires_at, completed_at, owner_user_id
				FROM pipeline_queue
				WHERE status = 'pending'
				  AND available_at <= ?
				  AND json_extract(payload, '$.type') IN (`+strings.Join(typePlaceholders, ",")+`)
				ORDER BY priority DESC, available_at ASC, created_at ASC
				LIMIT 1
			`, selectArgs...))
		if errors.Is(err, sql.ErrNoRows) {
			_ = tx.Rollback()
			return nil, nil
		}
		if err != nil {
			_ = tx.Rollback()
			return nil, fmt.Errorf("select queue claim: %w", err)
		}
		result, err := tx.ExecContext(ctx,
			`UPDATE pipeline_queue
			 SET status = 'in-stages', claimed_by = ?, claim_token = ?, claim_expires_at = ?
			 WHERE id = ? AND status = 'pending' AND available_at <= ?`,
			workerID,
			claimToken,
			claimExpiresAt,
			task.ID,
			readyAt,
		)
		if err != nil {
			_ = tx.Rollback()
			return nil, fmt.Errorf("update queue claim: %w", err)
		}
		affected, _ := result.RowsAffected()
		if affected != 1 {
			_ = tx.Rollback()
			continue
		}
		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("commit queue claim: %w", err)
		}
		task.Status = "in-stages"
		task.ClaimedBy = stringPtr(workerID)
		task.ClaimToken = stringPtr(claimToken)
		task.ClaimExpiresAt = stringPtr(formatUnixUTC(claimExpiresAt))
		return &task, nil
	}
	return nil, nil
}

func (r *Repository) ResetExpiredClaims(ctx context.Context, now time.Time) (int64, error) {
	result, err := r.db.ExecContext(ctx, `
		UPDATE pipeline_queue
		SET status = 'pending',
		    status_stage = NULL,
		    available_at = ?,
		    claimed_by = NULL,
		    claim_token = NULL,
		    claim_expires_at = NULL
		WHERE status = 'in-stages'
		  AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
	`, now.Unix(), now.Unix())
	if err != nil {
		return 0, fmt.Errorf("reset expired queue claims: %w", err)
	}
	affected, _ := result.RowsAffected()
	return affected, nil
}

func (r *Repository) RefreshClaim(ctx context.Context, taskID int64, claimToken string, now time.Time) (bool, error) {
	claimToken = strings.TrimSpace(claimToken)
	if claimToken == "" {
		return false, ErrTaskLeaseLost
	}
	result, err := r.db.ExecContext(ctx, `
		UPDATE pipeline_queue
		SET claim_expires_at = ?
		WHERE id = ?
		  AND status = 'in-stages'
		  AND claim_token = ?
	`, now.Add(DefaultTaskLeaseTTL).Unix(), taskID, claimToken)
	if err != nil {
		return false, fmt.Errorf("refresh queue claim: %w", err)
	}
	affected, _ := result.RowsAffected()
	return affected == 1, nil
}

func (r *Repository) UpdateStage(ctx context.Context, taskID int64, stage string, claimToken ...string) error {
	if len(claimToken) == 0 {
		_, err := r.db.ExecContext(ctx, "UPDATE pipeline_queue SET status_stage = ? WHERE id = ?", stage, taskID)
		if err != nil {
			return fmt.Errorf("update queue stage: %w", err)
		}
		return nil
	}
	token := strings.TrimSpace(claimToken[0])
	if token == "" {
		return ErrTaskLeaseLost
	}
	result, err := r.db.ExecContext(ctx, `
		UPDATE pipeline_queue
		SET status_stage = ?
		WHERE id = ?
		  AND status = 'in-stages'
		  AND claim_token = ?
	`, stage, taskID, token)
	if err != nil {
		return fmt.Errorf("update queue stage: %w", err)
	}
	affected, _ := result.RowsAffected()
	if affected != 1 {
		return ErrTaskLeaseLost
	}
	return nil
}

func (r *Repository) MarkCompleted(ctx context.Context, taskID int64, claimToken string) error {
	claimToken = strings.TrimSpace(claimToken)
	if claimToken == "" {
		return ErrTaskLeaseLost
	}
	result, err := r.db.ExecContext(ctx, `
		UPDATE pipeline_queue
		SET status = 'completed',
		    completed_at = unixepoch(),
		    claimed_by = NULL,
		    claim_token = NULL,
		    claim_expires_at = NULL
		WHERE id = ?
		  AND status = 'in-stages'
		  AND claim_token = ?
	`, taskID, claimToken)
	if err != nil {
		return fmt.Errorf("mark queue task completed: %w", err)
	}
	affected, _ := result.RowsAffected()
	if affected != 1 {
		return ErrTaskLeaseLost
	}
	return nil
}

func (r *Repository) MarkFailedWithRetry(ctx context.Context, taskID int64, claimToken string, message string, now time.Time) error {
	claimToken = strings.TrimSpace(claimToken)
	if claimToken == "" {
		return ErrTaskLeaseLost
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin queue failure: %w", err)
	}
	defer tx.Rollback()

	var attempts int64
	var maxAttempts float64
	if err := tx.QueryRowContext(ctx,
		`SELECT attempts, max_attempts
		 FROM pipeline_queue
		 WHERE id = ?
		   AND status = 'in-stages'
		   AND claim_token = ?`,
		taskID,
		claimToken,
	).Scan(&attempts, &maxAttempts); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrTaskLeaseLost
		}
		return fmt.Errorf("load failed queue task: %w", err)
	}
	newAttempts := attempts + 1
	shouldRetry := float64(newAttempts) < maxAttempts
	status := "failed"
	availableAt := now.Unix()
	if shouldRetry {
		status = "pending"
		delay := time.Duration(1<<max(newAttempts-1, 0)) * time.Second
		if delay > 30*time.Second {
			delay = 30 * time.Second
		}
		availableAt = now.Add(delay).Unix()
	}
	if strings.TrimSpace(message) == "" {
		message = "Unknown error"
	}

	var result sql.Result
	if shouldRetry {
		result, err = tx.ExecContext(ctx, `
				UPDATE pipeline_queue
				SET status = ?,
				    attempts = ?,
				    error_message = ?,
				    status_stage = NULL,
				    available_at = ?,
				    claimed_by = NULL,
				    claim_token = NULL,
				    claim_expires_at = NULL
				WHERE id = ?
				  AND status = 'in-stages'
				  AND claim_token = ?
			`, status, newAttempts, message, availableAt, taskID, claimToken)
	} else {
		result, err = tx.ExecContext(ctx, `
				UPDATE pipeline_queue
				SET status = ?,
				    attempts = ?,
				    error_message = ?,
				    claimed_by = NULL,
				    claim_token = NULL,
				    claim_expires_at = NULL
				WHERE id = ?
				  AND status = 'in-stages'
				  AND claim_token = ?
			`, status, newAttempts, message, taskID, claimToken)
	}
	if err != nil {
		return fmt.Errorf("mark queue task failed: %w", err)
	}
	affected, _ := result.RowsAffected()
	if affected != 1 {
		return ErrTaskLeaseLost
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit queue failure: %w", err)
	}
	return nil
}

func (r *Repository) query(
	ctx context.Context,
	query string,
	args ...any,
) ([]Task, error) {
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query queue: %w", err)
	}
	defer rows.Close()

	result := make([]Task, 0)
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("scan queue task: %w", err)
		}
		result = append(result, task)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate queue tasks: %w", err)
	}
	return result, nil
}

func scanTask(row scanner) (Task, error) {
	var (
		task           Task
		payload        sql.NullString
		statusStage    sql.NullString
		errorMsg       sql.NullString
		createdAt      int64
		availableAt    int64
		claimedBy      sql.NullString
		claimToken     sql.NullString
		claimExpiresAt sql.NullInt64
		completedAt    sql.NullInt64
	)
	if err := row.Scan(
		&task.ID,
		&payload,
		&task.Priority,
		&task.Attempts,
		&task.MaxAttempts,
		&task.Status,
		&statusStage,
		&errorMsg,
		&createdAt,
		&availableAt,
		&claimedBy,
		&claimToken,
		&claimExpiresAt,
		&completedAt,
		&task.OwnerUserID,
	); err != nil {
		return Task{}, err
	}
	if payload.Valid && strings.TrimSpace(payload.String) != "" {
		if err := json.Unmarshal([]byte(payload.String), &task.Payload); err != nil {
			task.Payload = nil
		}
	}
	if statusStage.Valid {
		task.StatusStage = &statusStage.String
	}
	if errorMsg.Valid {
		task.ErrorMessage = &errorMsg.String
	}
	if claimedBy.Valid {
		task.ClaimedBy = &claimedBy.String
	}
	if claimToken.Valid {
		task.ClaimToken = &claimToken.String
	}
	task.CreatedAt = formatUnixUTC(createdAt)
	task.AvailableAt = formatUnixUTC(availableAt)
	if claimExpiresAt.Valid {
		value := formatUnixUTC(claimExpiresAt.Int64)
		task.ClaimExpiresAt = &value
	}
	if completedAt.Valid {
		value := formatUnixUTC(completedAt.Int64)
		task.CompletedAt = &value
	}
	return task, nil
}

func newClaimToken() (string, error) {
	buffer := make([]byte, claimTokenBytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func formatUnixUTC(value int64) string {
	return time.Unix(value, 0).UTC().Format("2006-01-02T15:04:05.000Z")
}

func stringPtr(value string) *string {
	return &value
}
