package config

import (
	"os"
	"strings"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	clearConfigEnvironment(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Address != ":8080" || cfg.Environment != "development" {
		t.Fatalf("unexpected defaults: %#v", cfg)
	}
	if cfg.Mode != "sandbox" {
		t.Fatalf("unsafe mode default: got %q, want sandbox", cfg.Mode)
	}
	if cfg.AdminName != "admin" || cfg.AdminEmail != "" {
		t.Fatalf("unexpected wizard admin defaults: name:%q email:%q", cfg.AdminName, cfg.AdminEmail)
	}
	if !cfg.OAuthCookieSecure {
		t.Fatal("OAuthCookieSecure = false, want production-compatible secure default")
	}
	if cfg.RedisRequired {
		t.Fatal("Redis should be optional when no URL is configured")
	}
	if cfg.DBMigrator != "none" || cfg.PipelineConsumer != "none" || cfg.BackupScheduler != "none" || cfg.MigrateOnly {
		t.Fatalf("unsafe ownership defaults: %#v", cfg)
	}
	if cfg.PipelineWorkerCount != 1 || cfg.PipelinePollInterval.String() != "3s" {
		t.Fatalf("unexpected pipeline defaults: %#v", cfg)
	}
	if cfg.BackupScheduleRefresh.String() != "1m0s" {
		t.Fatalf("BackupScheduleRefresh = %s, want 1m0s", cfg.BackupScheduleRefresh)
	}
	if !cfg.UploadMIMEWhitelistEnabled || !strings.Contains(cfg.UploadMIMEWhitelist, "image/jpeg") {
		t.Fatalf("upload MIME defaults = enabled:%v whitelist:%q", cfg.UploadMIMEWhitelistEnabled, cfg.UploadMIMEWhitelist)
	}
	if !cfg.MediaToolPreflight {
		t.Fatal("MediaToolPreflight = false, want true by default")
	}
}

func TestLoadRejectsUnsupportedOwners(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("CFRAME_DB_MIGRATOR", "node")
	t.Setenv("CFRAME_PIPELINE_CONSUMER", "node")
	t.Setenv("CFRAME_BACKUP_SCHEDULER", "node")

	_, err := Load()
	if err == nil {
		t.Fatal("Load() error = nil, want ownership validation error")
	}
	for _, message := range []string{
		"CFRAME_DB_MIGRATOR must be none or go",
		"CFRAME_PIPELINE_CONSUMER must be none or go",
		"CFRAME_BACKUP_SCHEDULER must be none or go",
	} {
		if !strings.Contains(err.Error(), message) {
			t.Errorf("Load() error %q does not contain %q", err, message)
		}
	}
}

func TestLoadAllowsGoMigratorOwner(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("CFRAME_DB_MIGRATOR", "go")
	t.Setenv("CFRAME_GO_MIGRATE_ONLY", "true")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.DBMigrator != "go" || !cfg.MigrateOnly {
		t.Fatalf("migrator config = owner:%q migrateOnly:%v, want go/true", cfg.DBMigrator, cfg.MigrateOnly)
	}
}

func TestLoadRejectsMigrateOnlyWithoutGoMigrator(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("CFRAME_GO_MIGRATE_ONLY", "true")

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "CFRAME_GO_MIGRATE_ONLY=true requires CFRAME_DB_MIGRATOR=go") {
		t.Fatalf("Load() error = %v, want migrate-only ownership error", err)
	}
}

func TestLoadAllowsGoPipelineConsumerOwner(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("CFRAME_PIPELINE_CONSUMER", "go")
	t.Setenv("CFRAME_GO_PIPELINE_WORKER_COUNT", "3")
	t.Setenv("CFRAME_GO_PIPELINE_POLL_INTERVAL", "250ms")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.PipelineConsumer != "go" {
		t.Fatalf("PipelineConsumer = %q, want go", cfg.PipelineConsumer)
	}
	if cfg.PipelineWorkerCount != 3 || cfg.PipelinePollInterval.String() != "250ms" {
		t.Fatalf("pipeline config = count:%d interval:%s, want 3/250ms", cfg.PipelineWorkerCount, cfg.PipelinePollInterval)
	}
}

func TestLoadRejectsInvalidGoPipelineWorkerConfig(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("CFRAME_GO_PIPELINE_WORKER_COUNT", "0")
	t.Setenv("CFRAME_GO_PIPELINE_POLL_INTERVAL", "0s")

	_, err := Load()
	if err == nil {
		t.Fatal("Load() error = nil, want pipeline validation error")
	}
	for _, message := range []string{
		"CFRAME_GO_PIPELINE_WORKER_COUNT",
		"CFRAME_GO_PIPELINE_POLL_INTERVAL",
	} {
		if !strings.Contains(err.Error(), message) {
			t.Errorf("Load() error %q does not contain %q", err, message)
		}
	}
}

func TestLoadAllowsGoBackupSchedulerOwner(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("CFRAME_BACKUP_SCHEDULER", "go")
	t.Setenv("CFRAME_GO_BACKUP_SCHEDULE_REFRESH_INTERVAL", "250ms")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.BackupScheduler != "go" {
		t.Fatalf("BackupScheduler = %q, want go", cfg.BackupScheduler)
	}
	if cfg.BackupScheduleRefresh.String() != "250ms" {
		t.Fatalf("BackupScheduleRefresh = %s, want 250ms", cfg.BackupScheduleRefresh)
	}
}

func TestLoadRejectsInvalidGoBackupSchedulerRefresh(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("CFRAME_GO_BACKUP_SCHEDULE_REFRESH_INTERVAL", "0s")

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "CFRAME_GO_BACKUP_SCHEDULE_REFRESH_INTERVAL") {
		t.Fatalf("Load() error = %v, want backup schedule refresh validation error", err)
	}
}

func TestLoadMirrorsNodeUploadMIMEEnvironment(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("NUXT_UPLOAD_MIME_WHITELIST_ENABLED", "false")
	t.Setenv("NUXT_UPLOAD_MIME_WHITELIST", "image/jpeg,video/mp4")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.UploadMIMEWhitelistEnabled {
		t.Fatal("UploadMIMEWhitelistEnabled = true, want false")
	}
	if cfg.UploadMIMEWhitelist != "image/jpeg,video/mp4" {
		t.Fatalf("UploadMIMEWhitelist = %q", cfg.UploadMIMEWhitelist)
	}
}

func TestLoadMirrorsNodeWizardAdminEnvironment(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("CFRAME_ADMIN_NAME", "Learning Admin")
	t.Setenv("CFRAME_ADMIN_EMAIL", " learner@example.test ")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.AdminName != "Learning Admin" || cfg.AdminEmail != "learner@example.test" {
		t.Fatalf("wizard admin environment = name:%q email:%q", cfg.AdminName, cfg.AdminEmail)
	}
}

func TestLoadMirrorsNodeOAuthCookieEnvironment(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("NODE_ENV", "development")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.OAuthCookieSecure {
		t.Fatal("OAuthCookieSecure = true, want false for NODE_ENV=development")
	}
}

func TestLoadAllowsDisablingMediaToolPreflight(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("CFRAME_GO_MEDIA_TOOL_PREFLIGHT", "false")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.MediaToolPreflight {
		t.Fatal("MediaToolPreflight = true, want false")
	}
}

func TestLoadRequiresRedisURLWhenRequested(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("CFRAME_REDIS_REQUIRED", "true")

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "CFRAME_REDIS_URL") {
		t.Fatalf("Load() error = %v, want missing Redis URL", err)
	}
}

func TestLoadRejectsNonCanonicalRedisRequiredValues(t *testing.T) {
	for _, value := range []string{"", "TRUE", "1", " true", "false "} {
		clearConfigEnvironment(t)
		t.Setenv("CFRAME_REDIS_REQUIRED", value)
		if _, err := Load(); err == nil || !strings.Contains(err.Error(), "exactly true or false") {
			t.Fatalf("Load() with %q error = %v, want strict boolean error", value, err)
		}
	}
}

func TestLoadRejectsInvalidSharedCookieNames(t *testing.T) {
	clearConfigEnvironment(t)
	t.Setenv("CFRAME_SESSION_COOKIE", "session cookie")
	t.Setenv("CFRAME_ACCESS_COOKIE", "access;cookie")

	_, err := Load()
	if err == nil {
		t.Fatal("Load() error = nil, want Cookie name validation errors")
	}
	for _, message := range []string{
		"CFRAME_SESSION_COOKIE is not a valid Cookie name",
		"CFRAME_ACCESS_COOKIE is not a valid Cookie name",
	} {
		if !strings.Contains(err.Error(), message) {
			t.Errorf("Load() error %q does not contain %q", err, message)
		}
	}
}

func clearConfigEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range []string{
		"CFRAME_GO_ADDR", "CFRAME_ENV", "CFRAME_BACKEND_VERSION", "CFRAME_GO_MATURITY",
		"CFRAME_GO_MODE", "CFRAME_ADMIN_NAME", "CFRAME_ADMIN_EMAIL", "DATABASE_URL", "CFRAME_SCHEMA_MIN_CREATED_AT", "CFRAME_REDIS_URL",
		"CFRAME_REDIS_USERNAME", "CFRAME_REDIS_PASSWORD", "CFRAME_REDIS_PASSWORD_FILE",
		"CFRAME_REDIS_REQUIRED", "CFRAME_SESSION_COOKIE", "CFRAME_ACCESS_COOKIE", "CFRAME_ROUTE_MANIFEST", "CFRAME_DB_MIGRATOR",
		"CFRAME_GO_MIGRATE_ONLY", "CFRAME_PIPELINE_CONSUMER", "CFRAME_BACKUP_SCHEDULER", "CFRAME_HTTP_READ_HEADER_TIMEOUT",
		"CFRAME_HTTP_READ_TIMEOUT", "CFRAME_HTTP_WRITE_TIMEOUT", "CFRAME_HTTP_IDLE_TIMEOUT",
		"CFRAME_SHUTDOWN_TIMEOUT", "CFRAME_GO_PIPELINE_WORKER_COUNT", "CFRAME_GO_PIPELINE_POLL_INTERVAL",
		"CFRAME_GO_BACKUP_SCHEDULE_REFRESH_INTERVAL",
		"NUXT_UPLOAD_MIME_WHITELIST_ENABLED", "NUXT_UPLOAD_MIME_WHITELIST",
		"CFRAME_GO_MEDIA_TOOL_PREFLIGHT", "NODE_ENV",
	} {
		t.Setenv(name, "")
		if err := os.Unsetenv(name); err != nil {
			t.Fatalf("unset %s: %v", name, err)
		}
	}
}
