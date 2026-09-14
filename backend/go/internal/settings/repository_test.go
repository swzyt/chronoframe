package settings

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"

	platformdb "github.com/swzyt/chronoframe/backend/go/internal/platform/db"
)

func TestSQLiteRepositoryListsOnlyPublicAndFirstLaunch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.sqlite3")
	dsn, err := platformdb.SQLiteDSN(path, false)
	if err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open(platformdb.DriverName, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if _, err := database.Exec(`
		CREATE TABLE settings (
			id INTEGER PRIMARY KEY,
			namespace TEXT NOT NULL,
			key TEXT NOT NULL,
			type TEXT NOT NULL,
			value TEXT,
			is_public INTEGER NOT NULL
		);
		INSERT INTO settings VALUES
			(1, 'app', 'title', 'string', 'ChronoFrame', 1),
			(2, 'system', 'firstLaunch', 'boolean', 'false', 0),
			(3, 'system', 'privateSecret', 'string', 'never-return-this', 0);
	`); err != nil {
		t.Fatal(err)
	}

	rows, err := NewSQLiteRepository(database).ListPublic(context.Background())
	if err != nil {
		t.Fatalf("ListPublic() error = %v", err)
	}
	if len(rows) != 2 || rows[0].Key != "title" || rows[1].Key != "firstLaunch" {
		t.Fatalf("rows = %#v", rows)
	}
}

func TestServiceSetMatchesNodeReadonlyEnumTypeAndMissingErrors(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "settings-write-contract.sqlite3")
	store, err := platformdb.Open(ctx, path, platformdb.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if _, err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	repository := NewSQLiteRepository(store.SQL())
	if err := repository.InitDefaults(ctx, DefaultSettings); err != nil {
		t.Fatalf("InitDefaults() error = %v", err)
	}
	service := NewService(repository)

	for _, testCase := range []struct {
		name      string
		namespace string
		key       string
		value     any
		want      string
	}{
		{
			name: "readonly", namespace: "system", key: "firstLaunch", value: false,
			want: "Setting system:firstLaunch is readonly",
		},
		{
			name: "enum", namespace: "app", key: "appearance.theme", value: "bogus",
			want: "Invalid value for setting app:appearance.theme. Allowed values: light, dark, system",
		},
		{
			name: "enum null", namespace: "app", key: "appearance.theme", value: nil,
			want: "Invalid value for setting app:appearance.theme. Allowed values: light, dark, system",
		},
		{
			name: "type", namespace: "app", key: "title", value: float64(1),
			want: "Invalid value for setting app:title: Expected a JSON string or null",
		},
		{
			name: "missing pair", namespace: "system", key: "title", value: "x",
			want: "Setting system:title does not exist",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := service.Set(ctx, testCase.namespace, testCase.key, testCase.value, nil); err == nil || err.Error() != testCase.want {
				t.Fatalf("Set() error = %v, want %q", err, testCase.want)
			}
		})
	}

	if value, err := service.Set(ctx, "app", "appearance.theme", "dark", nil); err != nil || value != "dark" {
		t.Fatalf("Set(valid enum) = (%#v, %v), want (dark, nil)", value, err)
	}
	if value, err := service.Set(ctx, "app", "access.previewPhotoLimit", json.Number("12.5"), nil); err != nil || value != float64(12.5) {
		t.Fatalf("Set(valid number) = (%#v, %v), want (12.5, nil)", value, err)
	}
}

func TestSQLiteRepositoryInitializesDefaultSettings(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "settings-defaults.sqlite3")
	store, err := platformdb.Open(ctx, path, platformdb.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if _, err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	repository := NewSQLiteRepository(store.SQL())
	if err := repository.InitDefaults(ctx, DefaultSettings); err != nil {
		t.Fatalf("InitDefaults() error = %v", err)
	}

	var count int
	if err := store.SQL().QueryRowContext(ctx, `SELECT count(*) FROM settings`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != len(DefaultSettings) {
		t.Fatalf("settings count = %d, want %d", count, len(DefaultSettings))
	}

	row, err := repository.Get(ctx, "system", "backend.readProvider")
	if err != nil {
		t.Fatalf("backend.readProvider missing: %v", err)
	}
	if got := parseValue(row.Type, row.Value); got != "node" {
		t.Fatalf("backend.readProvider = %#v, want node", got)
	}

	var enumRaw string
	if err := store.SQL().QueryRowContext(ctx, `
		SELECT enum
		FROM settings
		WHERE namespace = 'system' AND key = 'backend.readProvider'
	`).Scan(&enumRaw); err != nil {
		t.Fatal(err)
	}
	var enumValues []string
	if err := json.Unmarshal([]byte(enumRaw), &enumValues); err != nil {
		t.Fatalf("decode enum: %v", err)
	}
	if len(enumValues) != 2 || enumValues[0] != "node" || enumValues[1] != "go" {
		t.Fatalf("backend enum = %#v, want [node go]", enumValues)
	}

	if err := repository.Set(ctx, "app", "title", "Custom Title", nil); err != nil {
		t.Fatalf("Set(custom title) error = %v", err)
	}
	if err := repository.InitDefaults(ctx, DefaultSettings); err != nil {
		t.Fatalf("second InitDefaults() error = %v", err)
	}
	title, err := repository.Get(ctx, "app", "title")
	if err != nil {
		t.Fatalf("title missing: %v", err)
	}
	if got := parseValue(title.Type, title.Value); got != "Custom Title" {
		t.Fatalf("title after InitDefaults = %#v, want preserved custom value", got)
	}
}
