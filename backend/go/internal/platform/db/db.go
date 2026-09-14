package db

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"unicode"

	_ "github.com/mattn/go-sqlite3"
)

const DriverName = "sqlite3"

const busyTimeoutMilliseconds = 5000

type Migration struct {
	CreatedAtMillis int64
	Hash            string
	SQL             string
}

type Options struct {
	ReadOnly           bool
	RequireWAL         bool
	MinMigrationMillis int64
	ExpectedMigrations []Migration
}

type Store struct {
	db                 *sql.DB
	readOnly           bool
	requireWAL         bool
	minMigrationMillis int64
	expectedMigrations []Migration
	checkMu            sync.Mutex
	preflightMu        sync.RWMutex
	preflightStatus    SchemaStatus
	preflightSentinel  schemaSentinel
	preflightComplete  bool
	preflightError     error
}

type schemaSentinel struct {
	SchemaVersion         int64
	MigrationCount        int
	LatestMigrationMillis int64
	LatestMigrationHash   string
}

type SchemaStatus struct {
	LatestMigrationMillis int64    `json:"latestMigrationMillis"`
	LatestMigrationHash   string   `json:"latestMigrationHash,omitempty"`
	MigrationCount        int      `json:"migrationCount"`
	Missing               []string `json:"missing,omitempty"`
}

type SchemaError struct {
	Status SchemaStatus
}

func (e *SchemaError) Error() string {
	parts := append([]string(nil), e.Status.Missing...)
	if e.Status.LatestMigrationMillis > 0 {
		parts = append(parts, fmt.Sprintf("latest migration %d", e.Status.LatestMigrationMillis))
	}
	return "incompatible SQLite schema: " + strings.Join(parts, ", ")
}

func Open(ctx context.Context, databaseURL string, options Options) (*Store, error) {
	dsn, err := SQLiteDSN(databaseURL, options.ReadOnly)
	if err != nil {
		return nil, err
	}
	database, err := sql.Open(DriverName, dsn)
	if err != nil {
		return nil, fmt.Errorf("open SQLite: %w", err)
	}
	database.SetMaxOpenConns(1)
	// Node and Go deliberately share the same SQLite WAL. Keep the Go side's
	// idle handles short-lived so development-only fixture writes and container
	// restarts do not leave a process pinned to stale WAL metadata.
	// Transactions still pin one connection for their lifetime.
	database.SetMaxIdleConns(0)
	database.SetConnMaxIdleTime(0)

	store := &Store{
		db:                 database,
		readOnly:           options.ReadOnly,
		requireWAL:         options.RequireWAL,
		minMigrationMillis: options.MinMigrationMillis,
		expectedMigrations: append([]Migration(nil), options.ExpectedMigrations...),
	}
	if options.ExpectedMigrations == nil {
		store.expectedMigrations = append([]Migration(nil), CurrentMigrations...)
	}
	if err := store.Ping(ctx); err != nil {
		_ = database.Close()
		return nil, err
	}
	if options.RequireWAL {
		if err := store.checkJournalMode(ctx); err != nil {
			_ = database.Close()
			return nil, err
		}
	}
	return store, nil
}

func SQLiteDSN(databaseURL string, readOnly bool) (string, error) {
	raw := strings.TrimSpace(databaseURL)
	if raw == "" {
		return "", errors.New("DATABASE_URL must not be empty")
	}
	if strings.Contains(raw, "://") && !strings.HasPrefix(raw, "file://") {
		return "", errors.New("DATABASE_URL must reference a local SQLite file")
	}

	withoutScheme := strings.TrimPrefix(raw, "file:")
	pathPart, rawQuery, _ := strings.Cut(withoutScheme, "?")
	if strings.HasPrefix(pathPart, "//") {
		parsed, err := url.Parse("file:" + pathPart)
		if err != nil {
			return "", fmt.Errorf("parse DATABASE_URL: %w", err)
		}
		if parsed.Host != "" && parsed.Host != "localhost" {
			return "", errors.New("DATABASE_URL must not use a remote file host")
		}
		pathPart = parsed.Path
	}
	decodedPath, err := url.PathUnescape(pathPart)
	if err != nil {
		return "", fmt.Errorf("decode DATABASE_URL path: %w", err)
	}
	absPath, err := filepath.Abs(decodedPath)
	if err != nil {
		return "", fmt.Errorf("resolve DATABASE_URL path: %w", err)
	}

	query, err := url.ParseQuery(rawQuery)
	if err != nil {
		return "", fmt.Errorf("parse DATABASE_URL query: %w", err)
	}
	for _, key := range []string{
		"mode",
		"_pragma",
		"_busy_timeout",
		"_timeout",
		"_foreign_keys",
		"_fk",
		"_journal_mode",
		"_journal",
		"_query_only",
	} {
		query.Del(key)
	}
	query.Set("_busy_timeout", fmt.Sprintf("%d", busyTimeoutMilliseconds))
	query.Set("_foreign_keys", "1")
	if readOnly {
		query.Set("mode", "ro")
		query.Set("_query_only", "1")
	} else {
		query.Set("mode", "rwc")
	}

	return (&url.URL{Scheme: "file", Path: absPath, RawQuery: query.Encode()}).String(), nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) SQL() *sql.DB {
	return s.db
}

func (s *Store) Ping(ctx context.Context) error {
	if err := s.db.PingContext(ctx); err != nil {
		return fmt.Errorf("ping SQLite: %w", err)
	}
	return nil
}

// Ready performs the cheap checks used by the recurring readiness probe. The
// expensive integrity, foreign-key, schema, and migration checks stay in Check
// and must have completed successfully before the store can become ready.
func (s *Store) Ready(ctx context.Context) (SchemaStatus, error) {
	if err := s.Ping(ctx); err != nil {
		return SchemaStatus{}, err
	}
	if s.requireWAL {
		if err := s.checkJournalMode(ctx); err != nil {
			return SchemaStatus{}, err
		}
	}
	s.preflightMu.RLock()
	if !s.preflightComplete {
		preflightError := s.preflightError
		s.preflightMu.RUnlock()
		if preflightError != nil {
			return SchemaStatus{}, preflightError
		}
		return SchemaStatus{}, errors.New("SQLite preflight has not completed")
	}
	cachedStatus := cloneSchemaStatus(s.preflightStatus)
	cachedSentinel := s.preflightSentinel
	cachedError := s.preflightError
	s.preflightMu.RUnlock()

	currentSentinel, err := s.readSchemaSentinel(ctx)
	if err != nil {
		return SchemaStatus{}, err
	}
	if currentSentinel != cachedSentinel || cachedError != nil {
		// Ordinary application writes do not change schema_version or the
		// append-only migration ledger. Re-run the expensive integrity and
		// contract checks only when one of those schema sentinels changes or a
		// prior recheck failed and may now be able to recover.
		return s.Check(ctx)
	}
	return cachedStatus, nil
}

func (s *Store) checkJournalMode(ctx context.Context) error {
	var journalMode string
	if err := s.db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journalMode); err != nil {
		return fmt.Errorf("read SQLite journal_mode: %w", err)
	}
	if !strings.EqualFold(journalMode, "wal") {
		return fmt.Errorf("SQLite journal_mode is %q, require WAL before starting the backend", journalMode)
	}
	return nil
}

func (s *Store) enableWAL(ctx context.Context) error {
	if s.readOnly {
		return errors.New("cannot enable SQLite WAL on a read-only store")
	}
	var journalMode string
	if err := s.db.QueryRowContext(ctx, "PRAGMA journal_mode = WAL").Scan(&journalMode); err != nil {
		return fmt.Errorf("enable SQLite journal_mode WAL: %w", err)
	}
	if !strings.EqualFold(journalMode, "wal") {
		return fmt.Errorf("SQLite journal_mode is %q after WAL initialization", journalMode)
	}
	for _, statement := range []string{
		"PRAGMA synchronous = NORMAL",
		"PRAGMA cache_size = 1000",
		"PRAGMA temp_store = MEMORY",
	} {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("apply SQLite runtime pragma %q: %w", statement, err)
		}
	}
	s.requireWAL = true
	return nil
}

func (s *Store) Migrate(ctx context.Context) (SchemaStatus, error) {
	if s.readOnly {
		return SchemaStatus{}, errors.New("cannot run SQLite migrations on a read-only store")
	}
	if err := s.Ping(ctx); err != nil {
		return SchemaStatus{}, err
	}
	if err := s.enableWAL(ctx); err != nil {
		return SchemaStatus{}, err
	}
	if _, err := s.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
			id SERIAL PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		)
	`); err != nil {
		return SchemaStatus{}, fmt.Errorf("create SQLite migration ledger: %w", err)
	}
	actual, err := s.readMigrationLedger(ctx)
	if err != nil {
		return SchemaStatus{}, err
	}
	pending, err := pendingMigrations(actual, s.expectedMigrations)
	if err != nil {
		return SchemaStatus{}, err
	}
	if len(pending) == 0 {
		return s.Check(ctx)
	}

	if _, err := s.db.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
		return SchemaStatus{}, fmt.Errorf("disable SQLite foreign_keys for migration: %w", err)
	}
	defer func() {
		_, _ = s.db.ExecContext(context.Background(), "PRAGMA foreign_keys = ON")
	}()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SchemaStatus{}, fmt.Errorf("begin SQLite migration transaction: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	for _, migration := range pending {
		statements := splitMigrationStatements(migration.SQL)
		if len(statements) == 0 {
			return SchemaStatus{}, fmt.Errorf("migration %d has no SQL statements", migration.CreatedAtMillis)
		}
		for index, statement := range statements {
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return SchemaStatus{}, fmt.Errorf(
					"apply SQLite migration %d statement %d: %w",
					migration.CreatedAtMillis,
					index+1,
					err,
				)
			}
		}
		if _, err := tx.ExecContext(
			ctx,
			`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)`,
			migration.Hash,
			migration.CreatedAtMillis,
		); err != nil {
			return SchemaStatus{}, fmt.Errorf("record SQLite migration %d: %w", migration.CreatedAtMillis, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return SchemaStatus{}, fmt.Errorf("commit SQLite migrations: %w", err)
	}
	committed = true
	if _, err := s.db.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
		return SchemaStatus{}, fmt.Errorf("restore SQLite foreign_keys after migration: %w", err)
	}
	return s.Check(ctx)
}

func splitMigrationStatements(sql string) []string {
	parts := strings.Split(sql, "--> statement-breakpoint")
	statements := make([]string, 0, len(parts))
	for _, part := range parts {
		statement := strings.TrimSpace(part)
		if statement == "" {
			continue
		}
		statements = append(statements, statement)
	}
	return statements
}

func (s *Store) Check(ctx context.Context) (status SchemaStatus, checkErr error) {
	s.checkMu.Lock()
	defer s.checkMu.Unlock()

	s.preflightMu.RLock()
	hadSuccessfulPreflight := s.preflightComplete
	s.preflightMu.RUnlock()
	defer func() {
		if checkErr == nil {
			return
		}
		s.preflightMu.Lock()
		defer s.preflightMu.Unlock()
		if !hadSuccessfulPreflight {
			s.preflightStatus = SchemaStatus{}
			s.preflightSentinel = schemaSentinel{}
			s.preflightComplete = false
		}
		s.preflightError = checkErr
	}()

	if err := s.Ping(ctx); err != nil {
		return SchemaStatus{}, err
	}

	var queryOnly, foreignKeys, busyTimeout int
	if err := s.db.QueryRowContext(ctx, "PRAGMA query_only").Scan(&queryOnly); err != nil {
		return SchemaStatus{}, fmt.Errorf("read SQLite query_only: %w", err)
	}
	if err := s.db.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&foreignKeys); err != nil {
		return SchemaStatus{}, fmt.Errorf("read SQLite foreign_keys: %w", err)
	}
	if err := s.db.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&busyTimeout); err != nil {
		return SchemaStatus{}, fmt.Errorf("read SQLite busy_timeout: %w", err)
	}
	if s.readOnly && queryOnly != 1 {
		return SchemaStatus{}, errors.New("SQLite query_only is not enabled")
	}
	if foreignKeys != 1 {
		return SchemaStatus{}, errors.New("SQLite foreign_keys is not enabled")
	}
	if busyTimeout < busyTimeoutMilliseconds {
		return SchemaStatus{}, fmt.Errorf("SQLite busy_timeout is %dms, want at least %dms", busyTimeout, busyTimeoutMilliseconds)
	}
	var quickCheck string
	if err := s.db.QueryRowContext(ctx, "PRAGMA quick_check(1)").Scan(&quickCheck); err != nil {
		return SchemaStatus{}, fmt.Errorf("run SQLite quick_check: %w", err)
	}
	if quickCheck != "ok" {
		return SchemaStatus{}, errors.New("SQLite quick_check failed")
	}
	foreignKeyRows, err := s.db.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return SchemaStatus{}, fmt.Errorf("run SQLite foreign_key_check: %w", err)
	}
	hasForeignKeyViolation := foreignKeyRows.Next()
	if closeErr := foreignKeyRows.Close(); closeErr != nil {
		return SchemaStatus{}, fmt.Errorf("close SQLite foreign_key_check: %w", closeErr)
	}
	if hasForeignKeyViolation {
		return SchemaStatus{}, errors.New("SQLite foreign_key_check found violations")
	}

	status, err = s.checkSchema(ctx)
	if err != nil {
		return status, err
	}
	sentinel, err := s.readSchemaSentinel(ctx)
	if err != nil {
		return status, err
	}
	if sentinel.MigrationCount != status.MigrationCount ||
		sentinel.LatestMigrationMillis != status.LatestMigrationMillis ||
		sentinel.LatestMigrationHash != status.LatestMigrationHash {
		return status, errors.New("SQLite schema changed during preflight")
	}
	s.preflightMu.Lock()
	s.preflightStatus = cloneSchemaStatus(status)
	s.preflightSentinel = sentinel
	s.preflightComplete = true
	s.preflightError = nil
	s.preflightMu.Unlock()
	return status, nil
}

func (s *Store) readSchemaSentinel(ctx context.Context) (schemaSentinel, error) {
	sentinel := schemaSentinel{}
	if err := s.db.QueryRowContext(ctx, "PRAGMA schema_version").Scan(&sentinel.SchemaVersion); err != nil {
		return schemaSentinel{}, fmt.Errorf("read SQLite schema_version: %w", err)
	}
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			count(*),
			COALESCE((
				SELECT CAST(created_at AS INTEGER)
				FROM __drizzle_migrations
				ORDER BY CAST(created_at AS INTEGER) DESC, hash DESC
				LIMIT 1
			), 0),
			COALESCE((
				SELECT hash
				FROM __drizzle_migrations
				ORDER BY CAST(created_at AS INTEGER) DESC, hash DESC
				LIMIT 1
			), '')
		FROM __drizzle_migrations
	`).Scan(
		&sentinel.MigrationCount,
		&sentinel.LatestMigrationMillis,
		&sentinel.LatestMigrationHash,
	); err != nil {
		return schemaSentinel{}, fmt.Errorf("read SQLite migration sentinel: %w", err)
	}
	return sentinel, nil
}

func cloneSchemaStatus(status SchemaStatus) SchemaStatus {
	status.Missing = append([]string(nil), status.Missing...)
	return status
}

func (s *Store) checkSchema(ctx context.Context) (SchemaStatus, error) {
	status := SchemaStatus{}
	tables := make([]string, 0, len(requiredSchema))
	for table := range requiredSchema {
		tables = append(tables, table)
	}
	sort.Strings(tables)

	for _, table := range tables {
		var count int
		if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?", table).Scan(&count); err != nil {
			return status, fmt.Errorf("check SQLite table %s: %w", table, err)
		}
		if count == 0 {
			status.Missing = append(status.Missing, "table:"+table)
			continue
		}
		for _, column := range requiredSchema[table] {
			if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM pragma_table_info(?) WHERE name = ?", table, column).Scan(&count); err != nil {
				return status, fmt.Errorf("check SQLite column %s.%s: %w", table, column, err)
			}
			if count == 0 {
				status.Missing = append(status.Missing, "column:"+table+"."+column)
			}
		}
	}
	for _, index := range requiredIndexes {
		var count int
		if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = ?", index).Scan(&count); err != nil {
			return status, fmt.Errorf("check SQLite index %s: %w", index, err)
		}
		if count == 0 {
			status.Missing = append(status.Missing, "index:"+index)
		}
	}
	triggerNames := make([]string, 0, len(requiredTriggers))
	for trigger := range requiredTriggers {
		triggerNames = append(triggerNames, trigger)
	}
	sort.Strings(triggerNames)
	for _, trigger := range triggerNames {
		var definition string
		if err := s.db.QueryRowContext(ctx, "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?", trigger).Scan(&definition); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				status.Missing = append(status.Missing, "trigger:"+trigger)
				continue
			}
			return status, fmt.Errorf("check SQLite trigger %s: %w", trigger, err)
		}
		hash := sha256.Sum256([]byte(canonicalSchemaSQL(definition)))
		if hex.EncodeToString(hash[:]) != requiredTriggers[trigger] {
			status.Missing = append(status.Missing, "trigger-definition:"+trigger)
		}
	}

	if !contains(status.Missing, "table:__drizzle_migrations") {
		if err := s.checkMigrationLedger(ctx, &status); err != nil {
			return status, err
		}
	}
	if s.minMigrationMillis > 0 && status.LatestMigrationMillis < s.minMigrationMillis {
		status.Missing = append(status.Missing, fmt.Sprintf("migration>=%d", s.minMigrationMillis))
	}
	if len(status.Missing) > 0 {
		return status, &SchemaError{Status: status}
	}
	return status, nil
}

func canonicalSchemaSQL(value string) string {
	return strings.Map(func(character rune) rune {
		if unicode.IsSpace(character) || character == '`' || character == '"' || character == ';' {
			return -1
		}
		return unicode.ToLower(character)
	}, value)
}

func (s *Store) checkMigrationLedger(ctx context.Context, status *SchemaStatus) error {
	actual, err := s.readMigrationLedger(ctx)
	if err != nil {
		return err
	}
	status.MigrationCount = len(actual)
	if len(actual) > 0 {
		latest := actual[len(actual)-1]
		status.LatestMigrationMillis = latest.CreatedAtMillis
		status.LatestMigrationHash = latest.Hash
	}

	if len(actual) != len(s.expectedMigrations) {
		status.Missing = append(status.Missing, fmt.Sprintf("migration-count:%d!=%d", len(actual), len(s.expectedMigrations)))
	}
	limit := len(actual)
	if len(s.expectedMigrations) < limit {
		limit = len(s.expectedMigrations)
	}
	for index := 0; index < limit; index++ {
		if !sameMigrationMetadata(actual[index], s.expectedMigrations[index]) {
			status.Missing = append(status.Missing, fmt.Sprintf("migration-ledger:%d", index))
		}
	}
	return nil
}

func (s *Store) readMigrationLedger(ctx context.Context) ([]Migration, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT CAST(created_at AS INTEGER), hash FROM __drizzle_migrations ORDER BY CAST(created_at AS INTEGER), hash")
	if err != nil {
		return nil, fmt.Errorf("read SQLite migration ledger: %w", err)
	}
	defer rows.Close()

	actual := make([]Migration, 0, len(s.expectedMigrations))
	for rows.Next() {
		var migration Migration
		if err := rows.Scan(&migration.CreatedAtMillis, &migration.Hash); err != nil {
			return nil, fmt.Errorf("scan SQLite migration ledger: %w", err)
		}
		actual = append(actual, migration)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate SQLite migration ledger: %w", err)
	}
	return actual, nil
}

func pendingMigrations(actual []Migration, expected []Migration) ([]Migration, error) {
	if len(actual) > len(expected) {
		return nil, fmt.Errorf("migration-count:%d!=%d", len(actual), len(expected))
	}
	for index := range actual {
		if !sameMigrationMetadata(actual[index], expected[index]) {
			return nil, fmt.Errorf("migration-ledger:%d", index)
		}
	}
	return expected[len(actual):], nil
}

func sameMigrationMetadata(left Migration, right Migration) bool {
	return left.CreatedAtMillis == right.CreatedAtMillis && left.Hash == right.Hash
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
