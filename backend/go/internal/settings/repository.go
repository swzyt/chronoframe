package settings

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

type SQLiteRepository struct {
	db *sql.DB
}

func (r *SQLiteRepository) InitDefaults(
	ctx context.Context,
	configs []DefaultSetting,
) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin settings defaults transaction: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	for _, config := range configs {
		if config.Namespace == "" || config.Key == "" || config.Type == "" {
			return fmt.Errorf("default setting has empty namespace, key, or type")
		}
		var id int64
		err := tx.QueryRowContext(ctx, `
			SELECT id
			FROM settings
			WHERE namespace = ? AND key = ?
		`, config.Namespace, config.Key).Scan(&id)
		if err == sql.ErrNoRows {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO settings (
					namespace, key, type, value, default_value, label, description,
					is_public, is_readonly, is_secret, enum
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
				config.Namespace, config.Key, config.Type, nullableString(config.Value),
				nullableString(config.DefaultValue), nullableString(config.Label), nullableString(config.Description),
				boolToSQLite(config.IsPublic), boolToSQLite(config.IsReadonly),
				boolToSQLite(config.IsSecret), nullableString(config.Enum),
			); err != nil {
				return fmt.Errorf("insert default setting %s:%s: %w", config.Namespace, config.Key, err)
			}
			continue
		}
		if err != nil {
			return fmt.Errorf("read default setting %s:%s: %w", config.Namespace, config.Key, err)
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE settings
			SET type = ?,
			    default_value = ?,
			    label = ?,
			    description = ?,
			    is_public = ?,
			    is_readonly = ?,
			    is_secret = ?,
			    enum = ?
			WHERE id = ?
		`,
			config.Type, nullableString(config.DefaultValue), nullableString(config.Label), nullableString(config.Description),
			boolToSQLite(config.IsPublic), boolToSQLite(config.IsReadonly),
			boolToSQLite(config.IsSecret), nullableString(config.Enum), id,
		); err != nil {
			return fmt.Errorf("update default setting metadata %s:%s: %w", config.Namespace, config.Key, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit settings defaults transaction: %w", err)
	}
	committed = true
	return nil
}

func boolToSQLite(value bool) int {
	if value {
		return 1
	}
	return 0
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func (r *SQLiteRepository) Set(
	ctx context.Context,
	namespace string,
	key string,
	value any,
	updatedBy *int64,
) error {
	result, err := r.db.ExecContext(ctx, `
		UPDATE settings
		SET value = ?, updated_at = unixepoch(), updated_by = ?
		WHERE namespace = ? AND key = ?
	`, value, updatedBy, namespace, key)
	if err != nil {
		return fmt.Errorf("update setting %s:%s: %w", namespace, key, err)
	}
	if count, err := result.RowsAffected(); err != nil {
		return err
	} else if count == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func NewSQLiteRepository(database *sql.DB) *SQLiteRepository {
	return &SQLiteRepository{db: database}
}

func (r *SQLiteRepository) Get(
	ctx context.Context,
	namespace string,
	key string,
) (Setting, error) {
	var (
		setting  Setting
		readonly int64
		enumRaw  sql.NullString
	)
	err := r.db.QueryRowContext(ctx, `
		SELECT namespace, key, type, value, is_readonly, enum
		FROM settings
		WHERE namespace = ? AND key = ?
	`, namespace, key).Scan(
		&setting.Namespace,
		&setting.Key,
		&setting.Type,
		&setting.Value,
		&readonly,
		&enumRaw,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return Setting{}, sql.ErrNoRows
		}
		return Setting{}, fmt.Errorf("read setting %s:%s: %w", namespace, key, err)
	}
	setting.IsReadonly = readonly != 0
	if enumRaw.Valid && strings.TrimSpace(enumRaw.String) != "" {
		_ = json.Unmarshal([]byte(enumRaw.String), &setting.Enum)
	}
	return setting, nil
}

func (r *SQLiteRepository) ListPublic(ctx context.Context) ([]Setting, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT namespace, key, type, value
		FROM settings
		WHERE is_public = 1 OR (namespace = 'system' AND key = 'firstLaunch')
		ORDER BY id ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("list public settings: %w", err)
	}
	defer rows.Close()

	settings := make([]Setting, 0)
	for rows.Next() {
		var setting Setting
		if err := rows.Scan(&setting.Namespace, &setting.Key, &setting.Type, &setting.Value); err != nil {
			return nil, fmt.Errorf("scan public setting: %w", err)
		}
		settings = append(settings, setting)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate public settings: %w", err)
	}
	return settings, nil
}

type SchemaSetting struct {
	Namespace    string
	Key          string
	Type         string
	Value        any
	DefaultValue any
	DefaultValid bool
	Label        *string
	Description  *string
	IsReadonly   bool
	IsSecret     bool
	Enum         []string
}

func (r *SQLiteRepository) ListSchema(ctx context.Context) ([]SchemaSetting, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT namespace, key, type, value, default_value, label, description,
		       is_readonly, is_secret, enum
		FROM settings
		ORDER BY id ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("list settings schema: %w", err)
	}
	defer rows.Close()

	result := make([]SchemaSetting, 0)
	for rows.Next() {
		var (
			setting      SchemaSetting
			value        sql.NullString
			defaultValue sql.NullString
			readonly     int64
			secret       int64
			enumValue    sql.NullString
		)
		if err := rows.Scan(
			&setting.Namespace,
			&setting.Key,
			&setting.Type,
			&value,
			&defaultValue,
			&setting.Label,
			&setting.Description,
			&readonly,
			&secret,
			&enumValue,
		); err != nil {
			return nil, fmt.Errorf("scan settings schema: %w", err)
		}
		setting.Value = parseValue(setting.Type, value)
		if defaultValue.Valid {
			setting.DefaultValid = true
			setting.DefaultValue = parseValue(setting.Type, defaultValue)
		}
		setting.IsReadonly = readonly != 0
		setting.IsSecret = secret != 0
		if enumValue.Valid && strings.TrimSpace(enumValue.String) != "" {
			_ = json.Unmarshal([]byte(enumValue.String), &setting.Enum)
		}
		result = append(result, setting)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate settings schema: %w", err)
	}
	return result, nil
}

func (r *SQLiteRepository) ListNamespace(
	ctx context.Context,
	namespace string,
) (map[string]any, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT key, type, value
		FROM settings
		WHERE namespace = ?
		ORDER BY id ASC
	`, namespace)
	if err != nil {
		return nil, fmt.Errorf("list settings namespace %s: %w", namespace, err)
	}
	defer rows.Close()

	result := make(map[string]any)
	for rows.Next() {
		var (
			key       string
			valueType string
			value     sql.NullString
		)
		if err := rows.Scan(&key, &valueType, &value); err != nil {
			return nil, fmt.Errorf("scan setting %s: %w", namespace, err)
		}
		result[key] = parseValue(valueType, value)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate settings namespace %s: %w", namespace, err)
	}
	return result, nil
}
