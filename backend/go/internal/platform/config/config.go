package config

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultAddress             = ":8080"
	defaultEnvironment         = "development"
	defaultBackendVersion      = "dev"
	defaultMaturity            = "experimental"
	defaultMode                = "sandbox"
	defaultSchemaMinCreatedAt  = int64(1787086800000)
	defaultUploadMIMEWhitelist = "image/jpeg,image/png,image/webp,image/gif,image/bmp,image/tiff,image/heic,image/heif,video/quicktime,video/mp4"
)

var environmentPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)
var cookieNamePattern = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

// Config is the shared, environment-driven runtime contract for the Go backend.
// The Go process can own migrations through the same generated Drizzle SQL
// ledger used by Node. Pipeline and backup ownership remain explicit so a
// shared deployment never starts two singleton actors accidentally.
type Config struct {
	Address                    string
	Environment                string
	BackendVersion             string
	Maturity                   string
	Mode                       string
	AdminName                  string
	AdminEmail                 string
	OAuthCookieSecure          bool
	DatabaseURL                string
	LogFile                    string
	SchemaMinCreatedAt         int64
	RedisURL                   string
	RedisUsername              string
	RedisPassword              string
	RedisRequired              bool
	SessionCookie              string
	AccessCookie               string
	RouteManifest              string
	DBMigrator                 string
	PipelineConsumer           string
	BackupScheduler            string
	BackupScheduleRefresh      time.Duration
	MigrateOnly                bool
	PipelineWorkerCount        int64
	PipelinePollInterval       time.Duration
	ReadHeaderTimeout          time.Duration
	ReadTimeout                time.Duration
	WriteTimeout               time.Duration
	IdleTimeout                time.Duration
	ShutdownTimeout            time.Duration
	UploadMIMEWhitelistEnabled bool
	UploadMIMEWhitelist        string
	MediaToolPreflight         bool
}

func Load() (Config, error) {
	redisPassword, err := loadSecret("CFRAME_REDIS_PASSWORD", "CFRAME_REDIS_PASSWORD_FILE")
	if err != nil {
		return Config{}, err
	}

	cfg := Config{
		Address:           envOr("CFRAME_GO_ADDR", defaultAddress),
		Environment:       envOr("CFRAME_ENV", defaultEnvironment),
		BackendVersion:    envOr("CFRAME_BACKEND_VERSION", defaultBackendVersion),
		Maturity:          envOr("CFRAME_GO_MATURITY", defaultMaturity),
		Mode:              envOr("CFRAME_GO_MODE", defaultMode),
		AdminName:         envOr("CFRAME_ADMIN_NAME", "admin"),
		AdminEmail:        strings.TrimSpace(os.Getenv("CFRAME_ADMIN_EMAIL")),
		OAuthCookieSecure: strings.TrimSpace(os.Getenv("NODE_ENV")) != "development",
		DatabaseURL:       envOr("DATABASE_URL", "./data/app.sqlite3"),
		LogFile:           envOr("CFRAME_LOG_FILE", "./data/logs/app.log"),
		RedisURL:          strings.TrimSpace(os.Getenv("CFRAME_REDIS_URL")),
		RedisUsername:     strings.TrimSpace(os.Getenv("CFRAME_REDIS_USERNAME")),
		RedisPassword:     redisPassword,
		SessionCookie:     envOr("CFRAME_SESSION_COOKIE", "cf_session"),
		AccessCookie:      envOr("CFRAME_ACCESS_COOKIE", "cf_access"),
		RouteManifest:     envOr("CFRAME_ROUTE_MANIFEST", "/app/contracts/routes.yaml"),
		DBMigrator:        envOr("CFRAME_DB_MIGRATOR", "none"),
		PipelineConsumer:  envOr("CFRAME_PIPELINE_CONSUMER", "none"),
		BackupScheduler:   envOr("CFRAME_BACKUP_SCHEDULER", "none"),
		BackupScheduleRefresh: durationOr("CFRAME_GO_BACKUP_SCHEDULE_REFRESH_INTERVAL",
			time.Minute),
		PipelinePollInterval: durationOr("CFRAME_GO_PIPELINE_POLL_INTERVAL", 3*time.Second),
		ReadHeaderTimeout:    durationOr("CFRAME_HTTP_READ_HEADER_TIMEOUT", 5*time.Second),
		ReadTimeout:          durationOr("CFRAME_HTTP_READ_TIMEOUT", 15*time.Second),
		WriteTimeout:         durationOr("CFRAME_HTTP_WRITE_TIMEOUT", 30*time.Second),
		IdleTimeout:          durationOr("CFRAME_HTTP_IDLE_TIMEOUT", 60*time.Second),
		ShutdownTimeout:      durationOr("CFRAME_SHUTDOWN_TIMEOUT", 15*time.Second),
		UploadMIMEWhitelist:  envOr("NUXT_UPLOAD_MIME_WHITELIST", defaultUploadMIMEWhitelist),
	}

	cfg.SchemaMinCreatedAt, err = int64Or("CFRAME_SCHEMA_MIN_CREATED_AT", defaultSchemaMinCreatedAt)
	if err != nil {
		return Config{}, err
	}
	cfg.PipelineWorkerCount, err = int64Or("CFRAME_GO_PIPELINE_WORKER_COUNT", 1)
	if err != nil {
		return Config{}, err
	}
	cfg.RedisRequired, err = boolOr("CFRAME_REDIS_REQUIRED", cfg.RedisURL != "")
	if err != nil {
		return Config{}, err
	}
	cfg.MigrateOnly, err = boolOr("CFRAME_GO_MIGRATE_ONLY", false)
	if err != nil {
		return Config{}, err
	}
	cfg.UploadMIMEWhitelistEnabled, err = boolOr("NUXT_UPLOAD_MIME_WHITELIST_ENABLED", true)
	if err != nil {
		return Config{}, err
	}
	cfg.MediaToolPreflight, err = boolOr("CFRAME_GO_MEDIA_TOOL_PREFLIGHT", true)
	if err != nil {
		return Config{}, err
	}

	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	var problems []string
	if strings.TrimSpace(c.Address) == "" {
		problems = append(problems, "CFRAME_GO_ADDR must not be empty")
	}
	if !environmentPattern.MatchString(c.Environment) {
		problems = append(problems, "CFRAME_ENV must match "+environmentPattern.String())
	}
	if strings.TrimSpace(c.BackendVersion) == "" {
		problems = append(problems, "CFRAME_BACKEND_VERSION must not be empty")
	}
	if !oneOf(c.Maturity, "experimental", "verified", "stable") {
		problems = append(problems, "CFRAME_GO_MATURITY must be experimental, verified, or stable")
	}
	if !oneOf(c.Mode, "normal", "compare", "shadow", "sandbox") {
		problems = append(problems, "CFRAME_GO_MODE must be normal, compare, shadow, or sandbox")
	}
	if strings.TrimSpace(c.DatabaseURL) == "" {
		problems = append(problems, "DATABASE_URL must not be empty")
	}
	if c.SchemaMinCreatedAt <= 0 {
		problems = append(problems, "CFRAME_SCHEMA_MIN_CREATED_AT must be positive")
	}
	if c.RedisRequired && c.RedisURL == "" {
		problems = append(problems, "CFRAME_REDIS_URL is required when CFRAME_REDIS_REQUIRED=true")
	}
	if !cookieNamePattern.MatchString(c.SessionCookie) {
		problems = append(problems, "CFRAME_SESSION_COOKIE is not a valid Cookie name")
	}
	if !cookieNamePattern.MatchString(c.AccessCookie) {
		problems = append(problems, "CFRAME_ACCESS_COOKIE is not a valid Cookie name")
	}
	if !oneOf(c.DBMigrator, "none", "go") {
		problems = append(problems, "CFRAME_DB_MIGRATOR must be none or go for the Go process")
	}
	if c.MigrateOnly && c.DBMigrator != "go" {
		problems = append(problems, "CFRAME_GO_MIGRATE_ONLY=true requires CFRAME_DB_MIGRATOR=go")
	}
	if !oneOf(c.PipelineConsumer, "none", "go") {
		problems = append(problems, "CFRAME_PIPELINE_CONSUMER must be none or go for the Go process")
	}
	if !oneOf(c.BackupScheduler, "none", "go") {
		problems = append(problems, "CFRAME_BACKUP_SCHEDULER must be none or go for the Go process")
	}
	if c.BackupScheduleRefresh <= 0 {
		problems = append(problems, "CFRAME_GO_BACKUP_SCHEDULE_REFRESH_INTERVAL must be positive")
	}
	if c.PipelineWorkerCount < 1 || c.PipelineWorkerCount > 20 {
		problems = append(problems, "CFRAME_GO_PIPELINE_WORKER_COUNT must be between 1 and 20")
	}
	if c.PipelinePollInterval <= 0 {
		problems = append(problems, "CFRAME_GO_PIPELINE_POLL_INTERVAL must be positive")
	}
	if c.ReadHeaderTimeout <= 0 || c.ReadTimeout <= 0 || c.WriteTimeout <= 0 || c.IdleTimeout <= 0 || c.ShutdownTimeout <= 0 {
		problems = append(problems, "HTTP and shutdown timeouts must be positive")
	}
	return errors.Join(stringsToErrors(problems)...)
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func int64Or(name string, fallback int64) (int64, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer: %w", name, err)
	}
	return value, nil
}

func boolOr(name string, fallback bool) (bool, error) {
	raw, present := os.LookupEnv(name)
	if !present {
		return fallback, nil
	}
	switch raw {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, fmt.Errorf("%s must be exactly true or false", name)
	}
}

func durationOr(name string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := time.ParseDuration(raw)
	if err != nil {
		return 0
	}
	return value
}

func loadSecret(valueName, fileName string) (string, error) {
	value := os.Getenv(valueName)
	path := strings.TrimSpace(os.Getenv(fileName))
	if value != "" && path != "" {
		return "", fmt.Errorf("set only one of %s and %s", valueName, fileName)
	}
	if path == "" {
		return value, nil
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", fileName, err)
	}
	return strings.TrimSpace(string(contents)), nil
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func stringsToErrors(values []string) []error {
	result := make([]error, 0, len(values))
	for _, value := range values {
		result = append(result, errors.New(value))
	}
	return result
}
