package db

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestSQLiteDSNEnforcesConnectionOptions(t *testing.T) {
	dsn, err := SQLiteDSN("./data/with space.sqlite3?cache=shared&_pragma=foreign_keys(0)&_journal_mode=DELETE", true)
	if err != nil {
		t.Fatalf("SQLiteDSN() error = %v", err)
	}
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse DSN: %v", err)
	}
	query := parsed.Query()
	if query.Get("mode") != "ro" || query.Get("cache") != "shared" {
		t.Fatalf("unexpected query: %v", query)
	}
	for key, required := range map[string]string{
		"_busy_timeout": "5000",
		"_foreign_keys": "1",
		"_query_only":   "1",
	} {
		if query.Get(key) != required {
			t.Errorf("DSN option %s = %q, want %q", key, query.Get(key), required)
		}
	}
	if query.Has("_pragma") || query.Get("_journal_mode") == "DELETE" {
		t.Fatalf("caller was able to keep unsafe SQLite options: %v", query)
	}
}

func TestCheckReportsSchemaDrift(t *testing.T) {
	path := filepath.Join(t.TempDir(), "drift.sqlite3")
	createSQLiteFixture(t, path, false)

	store, err := Open(context.Background(), path, Options{
		ReadOnly:           true,
		MinMigrationMillis: 200,
		ExpectedMigrations: []Migration{{CreatedAtMillis: 200, Hash: "fixture"}},
	})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	status, err := store.Check(context.Background())
	var schemaErr *SchemaError
	if !errors.As(err, &schemaErr) {
		t.Fatalf("Check() error = %v, want SchemaError", err)
	}
	if status.LatestMigrationMillis != 100 {
		t.Fatalf("latest migration = %d, want 100", status.LatestMigrationMillis)
	}
	if !contains(status.Missing, "column:photos.content_hash") || !contains(status.Missing, "table:upload_shares") || !contains(status.Missing, "migration>=200") || !contains(status.Missing, "migration-ledger:0") {
		t.Fatalf("missing = %v", status.Missing)
	}
}

func TestCheckAcceptsCompatibleReadOnlySchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "compatible.sqlite3")
	createSQLiteFixture(t, path, true)

	store, err := Open(context.Background(), "file:"+path, Options{
		ReadOnly:           true,
		MinMigrationMillis: 200,
		ExpectedMigrations: []Migration{{CreatedAtMillis: 200, Hash: "fixture"}},
	})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	status, err := store.Check(context.Background())
	if err != nil {
		t.Fatalf("Check() error = %v", err)
	}
	if status.LatestMigrationMillis != 200 || len(status.Missing) != 0 {
		t.Fatalf("status = %#v", status)
	}
	readyStatus, err := store.Ready(context.Background())
	if err != nil {
		t.Fatalf("Ready() error = %v", err)
	}
	if readyStatus.LatestMigrationMillis != status.LatestMigrationMillis || readyStatus.MigrationCount != status.MigrationCount {
		t.Fatalf("Ready() status = %#v, want cached %#v", readyStatus, status)
	}
}

func TestMigrateCreatesCurrentSchemaFromScratch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "go-migrator.sqlite3")
	store, err := Open(context.Background(), path, Options{ReadOnly: false, RequireWAL: false})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer store.Close()

	status, err := store.Migrate(context.Background())
	if err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	latest := CurrentMigrations[len(CurrentMigrations)-1]
	if status.MigrationCount != len(CurrentMigrations) ||
		status.LatestMigrationMillis != latest.CreatedAtMillis ||
		status.LatestMigrationHash != latest.Hash {
		t.Fatalf("migration status = %#v, want %d/%d/%s", status, len(CurrentMigrations), latest.CreatedAtMillis, latest.Hash)
	}
	if err := store.checkJournalMode(context.Background()); err != nil {
		t.Fatalf("migrated store WAL check error = %v", err)
	}
	readyStatus, err := store.Ready(context.Background())
	if err != nil {
		t.Fatalf("Ready() after Migrate() error = %v", err)
	}
	if readyStatus.MigrationCount != status.MigrationCount || len(readyStatus.Missing) != 0 {
		t.Fatalf("Ready() status = %#v, want %#v", readyStatus, status)
	}

	var columns int
	if err := store.SQL().QueryRowContext(
		context.Background(),
		"SELECT count(*) FROM pragma_table_info('__drizzle_migrations') WHERE name IN ('id', 'hash', 'created_at')",
	).Scan(&columns); err != nil {
		t.Fatal(err)
	}
	if columns != 3 {
		t.Fatalf("__drizzle_migrations column count = %d, want 3", columns)
	}
}

func TestMigrateRejectsUnexpectedMigrationLedger(t *testing.T) {
	path := filepath.Join(t.TempDir(), "go-migrator-drift.sqlite3")
	writer := openSQLiteWriter(t, path)
	if _, err := writer.Exec(`
		CREATE TABLE "__drizzle_migrations" (
			id SERIAL PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		);
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Exec(
		`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ('unexpected', ?)`,
		CurrentMigrations[0].CreatedAtMillis,
	); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := Open(context.Background(), path, Options{ReadOnly: false, RequireWAL: false})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer store.Close()
	if _, err := store.Migrate(context.Background()); err == nil || !strings.Contains(err.Error(), "migration-ledger:0") {
		t.Fatalf("Migrate() error = %v, want migration-ledger drift", err)
	}
}

func TestReadyRequiresSuccessfulPreflight(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-preflighted.sqlite3")
	dsn, err := SQLiteDSN(path, false)
	if err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open(DriverName, dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("CREATE TABLE placeholder (id INTEGER)"); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := Open(context.Background(), path, Options{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.Ready(context.Background()); err == nil || !strings.Contains(err.Error(), "preflight") {
		t.Fatalf("Ready() error = %v, want incomplete preflight", err)
	}
}

func TestReadyRechecksWhenMigrationLedgerChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "migration-drift.sqlite3")
	createSQLiteFixture(t, path, true)

	store, err := Open(context.Background(), path, Options{
		ReadOnly:           true,
		MinMigrationMillis: 200,
		ExpectedMigrations: []Migration{{CreatedAtMillis: 200, Hash: "fixture"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.Check(context.Background()); err != nil {
		t.Fatalf("initial Check() error = %v", err)
	}

	writer := openSQLiteWriter(t, path)
	defer writer.Close()
	if _, err := writer.Exec("INSERT INTO settings(namespace, key, type, value, is_public) VALUES ('app', 'title', 'string', 'updated', 1)"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Ready(context.Background()); err != nil {
		t.Fatalf("Ready() after ordinary data write error = %v", err)
	}
	if _, err := writer.Exec("INSERT INTO __drizzle_migrations(hash, created_at) VALUES ('unexpected', 300)"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Ready(context.Background()); err == nil || !strings.Contains(err.Error(), "migration-count") {
		t.Fatalf("Ready() after migration ledger drift error = %v, want migration-count incompatibility", err)
	}
	if _, err := writer.Exec("DELETE FROM __drizzle_migrations WHERE created_at = 300"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Ready(context.Background()); err != nil {
		t.Fatalf("Ready() after restoring migration ledger error = %v", err)
	}
}

func TestReadyRechecksWhenSQLiteSchemaChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "schema-drift.sqlite3")
	createSQLiteFixture(t, path, true)

	store, err := Open(context.Background(), path, Options{
		ReadOnly:           true,
		MinMigrationMillis: 200,
		ExpectedMigrations: []Migration{{CreatedAtMillis: 200, Hash: "fixture"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.Check(context.Background()); err != nil {
		t.Fatalf("initial Check() error = %v", err)
	}

	writer := openSQLiteWriter(t, path)
	defer writer.Close()
	if _, err := writer.Exec("DROP INDEX idx_photos_owner_content_hash"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Ready(context.Background()); err == nil || !strings.Contains(err.Error(), "idx_photos_owner_content_hash") {
		t.Fatalf("Ready() after schema drift error = %v, want missing required index", err)
	}
	if _, err := writer.Exec("CREATE INDEX idx_photos_owner_content_hash ON photos(owner_user_id, content_hash)"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Ready(context.Background()); err != nil {
		t.Fatalf("Ready() after restoring schema error = %v", err)
	}
}

func openSQLiteWriter(t *testing.T, path string) *sql.DB {
	t.Helper()
	dsn, err := SQLiteDSN(path, false)
	if err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open(DriverName, dsn)
	if err != nil {
		t.Fatal(err)
	}
	return database
}

func TestReadOnlyStoreRejectsInsertAndDDL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "read-only.sqlite3")
	dsn, err := SQLiteDSN(path, false)
	if err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open(DriverName, dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("CREATE TABLE guarded (value TEXT NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := Open(context.Background(), path, Options{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	for _, statement := range []string{
		"INSERT INTO guarded(value) VALUES ('forbidden')",
		"CREATE TABLE forbidden (id INTEGER)",
	} {
		if _, err := store.SQL().Exec(statement); err == nil {
			t.Fatalf("read-only store executed %q", statement)
		}
	}
	var count int
	if err := store.SQL().QueryRow("SELECT count(*) FROM guarded").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("guarded row count = %d, want 0", count)
	}
}

func TestReadOnlyStoreStartsAfterWALAndSeesLaterWriterCommit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "live-visibility.sqlite3")
	writerDSN, err := SQLiteDSN(path, false)
	if err != nil {
		t.Fatal(err)
	}
	writer, err := sql.Open(DriverName, writerDSN)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Exec(`
		PRAGMA journal_mode = DELETE;
		CREATE TABLE live_visibility (value TEXT NOT NULL);
		INSERT INTO live_visibility(value) VALUES ('before');
	`); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	for _, sidecar := range []string{path + "-wal", path + "-shm"} {
		if _, err := os.Stat(sidecar); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("fresh fixture sidecar %s exists or cannot be checked: %v", sidecar, err)
		}
	}
	if store, err := Open(context.Background(), path, Options{ReadOnly: true, RequireWAL: true}); err == nil {
		_ = store.Close()
		t.Fatal("Open() accepted a rollback-journal database before the writer initialized WAL")
	} else if !strings.Contains(err.Error(), "require WAL") {
		t.Fatalf("Open() error = %v, want WAL requirement", err)
	}

	command := exec.Command(os.Args[0], "-test.run=^TestWALWriterProcess$")
	command.Env = append(os.Environ(), "CFRAME_TEST_WAL_WRITER="+path)
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	childStopped := false
	t.Cleanup(func() {
		if !childStopped {
			_ = stdin.Close()
			_ = command.Wait()
		}
	})
	scanner := bufio.NewScanner(stdout)
	walReady := false
	for scanner.Scan() {
		if scanner.Text() == "wal-ready" {
			walReady = true
			break
		}
	}
	if !walReady {
		_ = stdin.Close()
		err := command.Wait()
		childStopped = true
		t.Fatalf("WAL writer did not initialize WAL (error %v): %s", err, stderr.String())
	}
	if _, err := os.Stat(path + "-wal"); err != nil {
		t.Fatalf("writer did not create WAL sidecar: %v", err)
	}
	if _, err := os.Stat(path + "-shm"); err != nil {
		t.Fatalf("writer did not create SHM sidecar: %v", err)
	}

	reader, err := Open(context.Background(), path, Options{ReadOnly: true, RequireWAL: true})
	if err != nil {
		t.Fatalf("Open() after WAL initialization error = %v", err)
	}
	t.Cleanup(func() { _ = reader.Close() })
	var value string
	if err := reader.SQL().QueryRow("SELECT value FROM live_visibility").Scan(&value); err != nil {
		t.Fatal(err)
	}
	if value != "before" {
		t.Fatalf("initial value = %q, want before", value)
	}
	if _, err := fmt.Fprintln(stdin, "update"); err != nil {
		t.Fatal(err)
	}
	updateReady := false
	for scanner.Scan() {
		if scanner.Text() == "update-ready" {
			updateReady = true
			break
		}
	}
	if !updateReady {
		_ = stdin.Close()
		err := command.Wait()
		childStopped = true
		t.Fatalf("WAL writer did not commit update (error %v): %s", err, stderr.String())
	}
	if err := reader.SQL().QueryRow("SELECT value FROM live_visibility").Scan(&value); err != nil {
		t.Fatal(err)
	}
	if value != "after" {
		t.Fatalf("value after writer enabled WAL = %q, want after", value)
	}
	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err != nil {
		t.Fatalf("WAL writer failed: %v: %s", err, stderr.String())
	}
	childStopped = true
}

func TestWALWriterProcess(t *testing.T) {
	path := os.Getenv("CFRAME_TEST_WAL_WRITER")
	if path == "" {
		t.Skip("helper process")
	}
	dsn, err := SQLiteDSN(path, false)
	if err != nil {
		t.Fatal(err)
	}
	writer, err := sql.Open(DriverName, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	var journalMode string
	if err := writer.QueryRow("PRAGMA journal_mode = WAL").Scan(&journalMode); err != nil {
		t.Fatal(err)
	}
	if journalMode != "wal" {
		t.Fatalf("journal mode = %q, want wal", journalMode)
	}
	if _, err := writer.Exec("UPDATE live_visibility SET value = 'before'"); err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprintln(os.Stdout, "wal-ready"); err != nil {
		t.Fatal(err)
	}
	command, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(command) != "update" {
		t.Fatalf("helper command = %q, want update", command)
	}
	if _, err := writer.Exec("UPDATE live_visibility SET value = 'after'"); err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprintln(os.Stdout, "update-ready"); err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, os.Stdin); err != nil {
		t.Fatal(err)
	}
}

func createSQLiteFixture(t *testing.T, path string, compatible bool) {
	t.Helper()
	dsn, err := SQLiteDSN(path, false)
	if err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open(DriverName, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	photosContentHash := ""
	uploadShares := ""
	usersPassword := ""
	usersAuthVersion := ""
	securityTrigger := ""
	photosContentHashIndex := ""
	pipelineQueueColumns := ""
	pipelineQueueReadyIndex := ""
	pipelineQueueClaimExpiresIndex := ""
	uploadSharesTokenIndex := ""
	migration := 100
	if compatible {
		photosContentHash = ", content_hash TEXT"
		pipelineQueueColumns = ", priority INTEGER, created_at INTEGER, available_at INTEGER, claimed_by TEXT, claim_token TEXT, claim_expires_at INTEGER"
		uploadShares = `CREATE TABLE upload_shares (id INTEGER, token_hash TEXT, owner_user_id INTEGER);`
		usersPassword = ", password TEXT"
		usersAuthVersion = ", auth_version INTEGER NOT NULL DEFAULT 1"
		securityTrigger = `
			CREATE TRIGGER users_security_fields_bump_auth_version
			AFTER UPDATE OF password, is_admin, is_active ON users
			FOR EACH ROW
			WHEN NEW.auth_version = OLD.auth_version
			  AND (
				NEW.password IS NOT OLD.password
				OR NEW.is_admin IS NOT OLD.is_admin
				OR NEW.is_active IS NOT OLD.is_active
			  )
			BEGIN
			  UPDATE users
			  SET auth_version = OLD.auth_version + 1
			  WHERE id = OLD.id;
			END;
		`
		photosContentHashIndex = `CREATE INDEX idx_photos_owner_content_hash ON photos(owner_user_id, content_hash);`
		pipelineQueueReadyIndex = `CREATE INDEX idx_pipeline_queue_ready ON pipeline_queue(status, available_at, priority, created_at);`
		pipelineQueueClaimExpiresIndex = `CREATE INDEX idx_pipeline_queue_claim_expires ON pipeline_queue(status, claim_expires_at);`
		uploadSharesTokenIndex = `CREATE UNIQUE INDEX idx_upload_shares_token_hash ON upload_shares(token_hash);`
		migration = 200
	}
	statements := []string{
		`CREATE TABLE __drizzle_migrations (hash TEXT, created_at INTEGER);`,
		`CREATE TABLE album_photos (album_id INTEGER, photo_id TEXT, position REAL);`,
		`CREATE TABLE albums (id INTEGER, is_hidden INTEGER, owner_user_id INTEGER);`,
		`CREATE TABLE photo_reactions (photo_id TEXT, fingerprint TEXT, reaction_type TEXT);`,
		`CREATE TABLE photos (id TEXT, owner_user_id INTEGER, storage_key TEXT` + photosContentHash + `);`,
		`CREATE TABLE pipeline_queue (id INTEGER, owner_user_id INTEGER, payload TEXT, status TEXT` + pipelineQueueColumns + `);`,
		`CREATE TABLE settings (namespace TEXT, key TEXT, type TEXT, value TEXT, is_public INTEGER);`,
		`CREATE TABLE settings_storage_providers (id INTEGER, provider TEXT, config TEXT);`,
		`CREATE TABLE users (id INTEGER, name TEXT, email TEXT` + usersPassword + `, is_admin INTEGER, is_active INTEGER` + usersAuthVersion + `);`,
		uploadShares,
		securityTrigger,
		`CREATE UNIQUE INDEX idx_namespace_key ON settings(namespace, key);`,
		photosContentHashIndex,
		pipelineQueueReadyIndex,
		pipelineQueueClaimExpiresIndex,
		uploadSharesTokenIndex,
		`INSERT INTO __drizzle_migrations(hash, created_at) VALUES ('fixture', 0);`,
	}
	statements[len(statements)-1] = "INSERT INTO __drizzle_migrations(hash, created_at) VALUES ('fixture', " + strconv.Itoa(migration) + ");"
	for _, statement := range statements {
		if statement == "" {
			continue
		}
		if _, err := database.Exec(statement); err != nil {
			t.Fatalf("exec %q: %v", statement, err)
		}
	}
}
