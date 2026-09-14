package app

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	platformdb "github.com/swzyt/chronoframe/backend/go/internal/platform/db"
	settingspkg "github.com/swzyt/chronoframe/backend/go/internal/settings"
)

func TestUpdateAccessSecurityConfigurationMatchesNodeTransaction(t *testing.T) {
	ctx := context.Background()
	application, store := newAccessConfigTestApplication(t)
	setAccessSettingValue(t, store, "access.passwordHash", "existing-hash")

	first, err := application.updateAccessSecurityConfiguration(ctx, accessConfigWriteInput{
		Enabled:    true,
		PhotoLimit: 20,
		AlbumLimit: 2,
		UpdatedBy:  7,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Version != 2 || !first.HasPassword {
		t.Fatalf("first result = %#v, want version 2 with existing password", first)
	}
	if got := accessSettingValue(t, store, "access.enabled"); got != "true" {
		t.Fatalf("access.enabled = %q, want true", got)
	}
	if got := accessSettingValue(t, store, "access.passwordHash"); got != "existing-hash" {
		t.Fatalf("access.passwordHash = %q, want existing-hash", got)
	}
	if got := accessSettingValue(t, store, "access.previewPhotoLimit"); got != "20" {
		t.Fatalf("access.previewPhotoLimit = %q, want 20", got)
	}
	if got := accessSettingValue(t, store, "access.previewAlbumLimit"); got != "2" {
		t.Fatalf("access.previewAlbumLimit = %q, want 2", got)
	}

	nextHash := "next-hash"
	second, err := application.updateAccessSecurityConfiguration(ctx, accessConfigWriteInput{
		Enabled:      false,
		PasswordHash: &nextHash,
		PhotoLimit:   30,
		AlbumLimit:   3,
		UpdatedBy:    8,
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.Version != 3 || !second.HasPassword {
		t.Fatalf("second result = %#v, want version 3 with password", second)
	}
	if got := accessSettingValue(t, store, "access.version"); got != "3" {
		t.Fatalf("access.version = %q, want 3", got)
	}
	if got := accessSettingValue(t, store, "access.passwordHash"); got != "next-hash" {
		t.Fatalf("access.passwordHash = %q, want next-hash", got)
	}
}

func TestUpdateAccessSecurityConfigurationRejectsMissingPasswordLikeNode(t *testing.T) {
	ctx := context.Background()
	application, store := newAccessConfigTestApplication(t)
	setAccessSettingValue(t, store, "access.passwordHash", "")

	_, err := application.updateAccessSecurityConfiguration(ctx, accessConfigWriteInput{
		Enabled:    true,
		PhotoLimit: 20,
		AlbumLimit: 2,
		UpdatedBy:  7,
	})
	if !errors.Is(err, errAccessPasswordRequired) {
		t.Fatalf("error = %v, want errAccessPasswordRequired", err)
	}
	if got := accessSettingValue(t, store, "access.version"); got != "1" {
		t.Fatalf("access.version = %q, want unchanged 1", got)
	}
}

func TestUpdateAccessSecurityConfigurationRollsBackInvalidVersionLikeNode(t *testing.T) {
	ctx := context.Background()
	application, store := newAccessConfigTestApplication(t)
	setAccessSettingValue(t, store, "access.passwordHash", "existing-hash")
	setAccessSettingValue(t, store, "access.version", "not-a-number")
	nextHash := "next-hash"

	_, err := application.updateAccessSecurityConfiguration(ctx, accessConfigWriteInput{
		Enabled:      true,
		PasswordHash: &nextHash,
		PhotoLimit:   20,
		AlbumLimit:   2,
		UpdatedBy:    7,
	})
	if err == nil {
		t.Fatal("updateAccessSecurityConfiguration() error = nil, want invalid access.version error")
	}
	if got := accessSettingValue(t, store, "access.enabled"); got != "false" {
		t.Fatalf("access.enabled = %q, want rolled back false", got)
	}
	if got := accessSettingValue(t, store, "access.passwordHash"); got != "existing-hash" {
		t.Fatalf("access.passwordHash = %q, want rolled back existing-hash", got)
	}
	if got := accessSettingValue(t, store, "access.previewPhotoLimit"); got != "10" {
		t.Fatalf("access.previewPhotoLimit = %q, want rolled back 10", got)
	}
	if got := accessSettingValue(t, store, "access.version"); got != "not-a-number" {
		t.Fatalf("access.version = %q, want original invalid value", got)
	}
}

func TestUpdateAccessSecurityConfigurationDoesNotRequirePasswordRowWhenDisabled(t *testing.T) {
	ctx := context.Background()
	application, store := newAccessConfigTestApplication(t)
	if _, err := store.SQL().ExecContext(ctx, `
		DELETE FROM settings
		WHERE namespace = 'app' AND key = 'access.passwordHash'
	`); err != nil {
		t.Fatal(err)
	}

	result, err := application.updateAccessSecurityConfiguration(ctx, accessConfigWriteInput{
		Enabled:    false,
		PhotoLimit: 4,
		AlbumLimit: 1,
		UpdatedBy:  7,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Version != 2 || result.HasPassword {
		t.Fatalf("result = %#v, want version 2 without password", result)
	}
	var count int
	if err := store.SQL().QueryRowContext(ctx, `
		SELECT count(*)
		FROM settings
		WHERE namespace = 'app' AND key = 'access.passwordHash'
	`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("passwordHash row count = %d, want unchanged missing row", count)
	}
}

func newAccessConfigTestApplication(t *testing.T) (*Application, *platformdb.Store) {
	t.Helper()
	ctx := context.Background()
	store, err := platformdb.Open(ctx, filepath.Join(t.TempDir(), "access-config.sqlite3"), platformdb.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if _, err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	repository := settingspkg.NewSQLiteRepository(store.SQL())
	if err := repository.InitDefaults(ctx, settingspkg.DefaultSettings); err != nil {
		t.Fatalf("InitDefaults() error = %v", err)
	}
	if _, err := store.SQL().ExecContext(ctx, `
		INSERT INTO users (id, name, email, password, created_at, is_admin, is_active, auth_version)
		VALUES
			(7, 'Admin Seven', 'admin7@example.com', 'hash', 1788940800, 1, 1, 1),
			(8, 'Admin Eight', 'admin8@example.com', 'hash', 1788940801, 1, 1, 1)
	`); err != nil {
		t.Fatal(err)
	}
	return NewApplication(Dependencies{Database: store}), store
}

func setAccessSettingValue(t *testing.T, store *platformdb.Store, key string, value string) {
	t.Helper()
	if _, err := store.SQL().ExecContext(context.Background(), `
		UPDATE settings
		SET value = ?
		WHERE namespace = 'app' AND key = ?
	`, value, key); err != nil {
		t.Fatal(err)
	}
}

func accessSettingValue(t *testing.T, store *platformdb.Store, key string) string {
	t.Helper()
	var value string
	if err := store.SQL().QueryRowContext(context.Background(), `
		SELECT value
		FROM settings
		WHERE namespace = 'app' AND key = ?
	`, key).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}
