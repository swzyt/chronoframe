package settings

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

var jsonNumberPattern = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`)

type Setting struct {
	Namespace  string
	Key        string
	Type       string
	Value      sql.NullString
	IsReadonly bool
	Enum       []string
}

type Repository interface {
	ListPublic(context.Context) ([]Setting, error)
}

type ValueRepository interface {
	Get(context.Context, string, string) (Setting, error)
}

type SchemaRepository interface {
	ListSchema(context.Context) ([]SchemaSetting, error)
	ListNamespace(context.Context, string) (map[string]any, error)
}

type Service struct {
	repository Repository
}

func NewService(repository Repository) *Service {
	return &Service{repository: repository}
}

func (s *Service) Value(ctx context.Context, namespace, key string) (Setting, error) {
	repository, ok := s.repository.(ValueRepository)
	if !ok {
		return Setting{}, fmt.Errorf("settings repository does not support value reads")
	}
	return repository.Get(ctx, namespace, key)
}

func (s *Service) Set(
	ctx context.Context,
	namespace string,
	key string,
	input any,
	updatedBy *int64,
	sudo ...bool,
) (any, error) {
	repository, ok := s.repository.(*SQLiteRepository)
	if !ok {
		return nil, fmt.Errorf("settings repository does not support writes")
	}
	current, err := s.Value(ctx, namespace, key)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("Setting %s:%s does not exist", namespace, key)
		}
		return nil, err
	}
	if current.IsReadonly && (len(sudo) == 0 || !sudo[0]) {
		return nil, fmt.Errorf("Setting %s:%s is readonly", namespace, key)
	}
	encoded, value, err := encodeValue(current.Type, input)
	if err != nil {
		return nil, fmt.Errorf("Invalid value for setting %s:%s: %w", namespace, key, err)
	}
	if !validEnumValue(value, current.Enum) {
		return nil, fmt.Errorf(
			"Invalid value for setting %s:%s. Allowed values: %s",
			namespace,
			key,
			strings.Join(current.Enum, ", "),
		)
	}
	if err := repository.Set(ctx, namespace, key, encoded, updatedBy); err != nil {
		return nil, err
	}
	return value, nil
}

func validEnumValue(value any, values []string) bool {
	if value == nil {
		return len(values) == 0
	}
	if len(values) == 0 {
		return true
	}
	return slicesContains(values, fmt.Sprint(value))
}

func slicesContains(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

func encodeValue(valueType string, input any) (any, any, error) {
	if input == nil {
		return "", nil, nil
	}
	switch valueType {
	case "string":
		value, ok := input.(string)
		if !ok {
			return "", nil, fmt.Errorf("Expected a JSON string or null")
		}
		return value, value, nil
	case "number":
		value, ok := input.(float64)
		if !ok {
			switch typed := input.(type) {
			case int:
				value = float64(typed)
			case int64:
				value = float64(typed)
			case json.Number:
				parsed, err := typed.Float64()
				if err != nil {
					return "", nil, fmt.Errorf("Expected a finite JSON number or null")
				}
				value = parsed
			default:
				return "", nil, fmt.Errorf("Expected a finite JSON number or null")
			}
		}
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return "", nil, fmt.Errorf("Expected a finite JSON number or null")
		}
		if value == 0 {
			value = 0
		}
		bytes, err := json.Marshal(value)
		if err != nil {
			return "", nil, err
		}
		return string(bytes), value, nil
	case "boolean":
		value, ok := input.(bool)
		if !ok {
			return "", nil, fmt.Errorf("Expected a JSON boolean or null")
		}
		if value {
			return "true", true, nil
		}
		return "false", false, nil
	case "json":
		object, ok := input.(map[string]any)
		if !ok {
			return "", nil, fmt.Errorf("Expected a JSON-compatible object or null")
		}
		bytes, err := json.Marshal(object)
		if err != nil {
			return "", nil, err
		}
		return string(bytes), object, nil
	default:
		return "", nil, fmt.Errorf("unsupported setting type %s", valueType)
	}
}

func (s *Service) Schema(ctx context.Context) ([]SchemaSetting, error) {
	repository, ok := s.repository.(SchemaRepository)
	if !ok {
		return nil, fmt.Errorf("settings repository does not support schema reads")
	}
	return repository.ListSchema(ctx)
}

func (s *Service) Namespace(
	ctx context.Context,
	namespace string,
) (map[string]any, error) {
	repository, ok := s.repository.(SchemaRepository)
	if !ok {
		return nil, fmt.Errorf("settings repository does not support namespace reads")
	}
	return repository.ListNamespace(ctx, namespace)
}

func DecodeValue(valueType string, value sql.NullString) any {
	return parseValue(valueType, value)
}

func (s *Service) Public(ctx context.Context) (map[string]map[string]any, error) {
	rows, err := s.repository.ListPublic(ctx)
	if err != nil {
		return nil, err
	}
	grouped := make(map[string]map[string]any)
	for _, row := range rows {
		namespace := grouped[row.Namespace]
		if namespace == nil {
			namespace = make(map[string]any)
			grouped[row.Namespace] = namespace
		}
		namespace[row.Key] = parseValue(row.Type, row.Value)
	}
	return grouped, nil
}

// NumberValue decodes a persisted JSON number using the same strict grammar
// used by the public settings response. Callers that need an integer must
// apply their own range/integrality rule after this decode.
func NumberValue(value sql.NullString) (float64, bool) {
	parsed := parseValue("number", value)
	number, ok := parsed.(float64)
	return number, ok
}

// BooleanValue decodes a persisted JSON boolean without accepting permissive
// string coercions such as "1" or "yes".
func BooleanValue(value sql.NullString) (bool, bool) {
	parsed := parseValue("boolean", value)
	boolean, ok := parsed.(bool)
	return boolean, ok
}

func parseValue(valueType string, value sql.NullString) any {
	if !value.Valid {
		return nil
	}
	switch valueType {
	case "json":
		if value.String == "" {
			return nil
		}
		var parsed any
		if err := json.Unmarshal([]byte(value.String), &parsed); err == nil && isJSONObject(parsed) {
			return parsed
		}
		return nil
	case "number":
		if !jsonNumberPattern.MatchString(value.String) {
			return nil
		}
		parsed, err := strconv.ParseFloat(value.String, 64)
		if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) {
			return nil
		}
		if parsed == 0 {
			return float64(0)
		}
		return parsed
	case "boolean":
		if value.String == "true" {
			return true
		}
		if value.String == "false" {
			return false
		}
		return nil
	case "string":
		return value.String
	default:
		return nil
	}
}

func isJSONObject(value any) bool {
	_, ok := value.(map[string]any)
	return ok
}
