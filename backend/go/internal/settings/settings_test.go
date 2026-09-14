package settings

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type fakeRepository struct {
	rows []Setting
	err  error
}

func (r fakeRepository) ListPublic(context.Context) ([]Setting, error) {
	return r.rows, r.err
}

func TestPublicGroupsAndParsesNodeCompatibleValues(t *testing.T) {
	service := NewService(fakeRepository{rows: []Setting{
		{Namespace: "app", Key: "title", Type: "string", Value: sql.NullString{String: "ChronoFrame", Valid: true}},
		{Namespace: "app", Key: "count", Type: "number", Value: sql.NullString{String: "12.5", Valid: true}},
		{Namespace: "app", Key: "enabled", Type: "boolean", Value: sql.NullString{String: "true", Valid: true}},
		{Namespace: "app", Key: "disabled", Type: "boolean", Value: sql.NullString{String: "yes", Valid: true}},
		{Namespace: "map", Key: "options", Type: "json", Value: sql.NullString{String: `{"zoom":3,"layers":["photos"]}`, Valid: true}},
		{Namespace: "system", Key: "firstLaunch", Type: "boolean", Value: sql.NullString{}},
	}})

	got, err := service.Public(context.Background())
	if err != nil {
		t.Fatalf("Public() error = %v", err)
	}
	want := map[string]map[string]any{
		"app": {
			"title": "ChronoFrame", "count": 12.5, "enabled": true, "disabled": nil,
		},
		"map": {
			"options": map[string]any{"zoom": float64(3), "layers": []any{"photos"}},
		},
		"system": {"firstLaunch": nil},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Public() = %#v, want %#v", got, want)
	}
}

func TestParseValueRejectsMalformedTypedStorage(t *testing.T) {
	value := sql.NullString{String: "{broken", Valid: true}
	if got := parseValue("json", value); got != nil {
		t.Fatalf("parseValue() = %#v, want nil", got)
	}
	if got := parseValue("number", sql.NullString{String: "not-a-number", Valid: true}); got != nil {
		t.Fatalf("parseValue(number) = %#v, want nil", got)
	}
}

func TestTypedValueHelpersUseStrictPersistedGrammar(t *testing.T) {
	if got, ok := NumberValue(sql.NullString{String: "1e3", Valid: true}); !ok || got != 1000 {
		t.Fatalf("NumberValue(exponent) = (%v, %v), want (1000, true)", got, ok)
	}
	if _, ok := NumberValue(sql.NullString{String: " 1000 ", Valid: true}); ok {
		t.Fatal("NumberValue accepted surrounding whitespace")
	}
	if got, ok := BooleanValue(sql.NullString{String: "false", Valid: true}); !ok || got {
		t.Fatalf("BooleanValue(false) = (%v, %v), want (false, true)", got, ok)
	}
	if _, ok := BooleanValue(sql.NullString{String: "1", Valid: true}); ok {
		t.Fatal("BooleanValue accepted numeric coercion")
	}
}

type numberFixtureFile struct {
	Cases []struct {
		Name      string   `json:"name"`
		Stored    string   `json:"stored"`
		Valid     bool     `json:"valid"`
		Decoded   *float64 `json:"decoded"`
		Canonical *string  `json:"canonical"`
	} `json:"cases"`
}

func TestNumberReadsConformToSharedCrossLanguageFixtures(t *testing.T) {
	fixturePath := filepath.Join("..", "..", "..", "contracts", "settings-number-fixtures.json")
	contents, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}

	var fixtures numberFixtureFile
	if err := json.Unmarshal(contents, &fixtures); err != nil {
		t.Fatalf("decode fixtures: %v", err)
	}
	for _, fixture := range fixtures.Cases {
		t.Run(fixture.Name, func(t *testing.T) {
			got := parseValue("number", sql.NullString{String: fixture.Stored, Valid: true})
			if !fixture.Valid {
				if got != nil {
					t.Fatalf("parseValue(number, %q) = %#v, want nil", fixture.Stored, got)
				}
				return
			}
			parsed, ok := got.(float64)
			if !ok || fixture.Decoded == nil || parsed != *fixture.Decoded {
				t.Fatalf("parseValue(number, %q) = %#v, want %v", fixture.Stored, got, fixture.Decoded)
			}
		})
	}
}
