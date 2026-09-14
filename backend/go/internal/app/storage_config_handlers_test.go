package app

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestNormalizeStorageConfigForCreateMatchesNodeZodDefaultsAndStripsUnknown(t *testing.T) {
	tests := []struct {
		name     string
		provider string
		config   map[string]any
		expected map[string]any
	}{
		{
			name:     "local",
			provider: "local",
			config: map[string]any{
				"provider": "local",
				"basePath": "/app/data/storage",
				"baseUrl":  "/storage",
				"prefix":   "fixture/local",
				"unknown":  "drop-me",
			},
			expected: map[string]any{
				"provider": "local",
				"basePath": "/app/data/storage",
				"baseUrl":  "/storage",
				"prefix":   "fixture/local",
			},
		},
		{
			name:     "s3",
			provider: "s3",
			config: map[string]any{
				"provider":        "s3",
				"bucket":          "chronoframe",
				"endpoint":        "https://s3.example.test",
				"accessKeyId":     "access",
				"secretAccessKey": "secret",
				"forcePathStyle":  true,
				"maxKeys":         json.Number("100"),
				"unknown":         "drop-me",
			},
			expected: map[string]any{
				"provider":        "s3",
				"bucket":          "chronoframe",
				"region":          "auto",
				"endpoint":        "https://s3.example.test",
				"prefix":          "/photos",
				"accessKeyId":     "access",
				"secretAccessKey": "secret",
				"forcePathStyle":  true,
				"maxKeys":         json.Number("100"),
			},
		},
		{
			name:     "openlist",
			provider: "openlist",
			config: map[string]any{
				"provider": "openlist",
				"baseUrl":  "https://files.example.test",
				"rootPath": "/chronoframe",
				"token":    "secret-token",
				"unknown":  "drop-me",
			},
			expected: map[string]any{
				"provider":       "openlist",
				"baseUrl":        "https://files.example.test",
				"rootPath":       "/chronoframe",
				"token":          "secret-token",
				"uploadEndpoint": "/api/fs/put",
				"deleteEndpoint": "/api/fs/remove",
				"metaEndpoint":   "/api/fs/get",
				"pathField":      "path",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			actual, ok := normalizeStorageConfigForCreate(tt.provider, tt.config)
			if !ok {
				t.Fatal("expected config to be valid")
			}
			if !reflect.DeepEqual(actual, tt.expected) {
				t.Fatalf("normalized config mismatch\nactual:   %#v\nexpected: %#v", actual, tt.expected)
			}
		})
	}
}

func TestNormalizeStorageConfigForUpdateMatchesNodeZodPartialDefaults(t *testing.T) {
	tests := []struct {
		name     string
		provider string
		config   map[string]any
		expected map[string]any
	}{
		{
			name:     "local only keeps supplied optional fields",
			provider: "local",
			config: map[string]any{
				"provider": "local",
				"prefix":   "fixture/local-updated",
				"unknown":  "drop-me",
			},
			expected: map[string]any{
				"provider": "local",
				"prefix":   "fixture/local-updated",
			},
		},
		{
			name:     "s3 fills defaulted partial fields",
			provider: "s3",
			config: map[string]any{
				"bucket":  "chronoframe-updated",
				"unknown": "drop-me",
			},
			expected: map[string]any{
				"bucket": "chronoframe-updated",
				"region": "auto",
				"prefix": "/photos",
			},
		},
		{
			name:     "openlist empty partial still fills endpoint defaults",
			provider: "openlist",
			config:   map[string]any{},
			expected: map[string]any{
				"uploadEndpoint": "/api/fs/put",
				"deleteEndpoint": "/api/fs/remove",
				"metaEndpoint":   "/api/fs/get",
				"pathField":      "path",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			actual, ok := normalizeStorageConfigForUpdate(tt.provider, tt.config)
			if !ok {
				t.Fatal("expected config to be valid")
			}
			if !reflect.DeepEqual(actual, tt.expected) {
				t.Fatalf("normalized config mismatch\nactual:   %#v\nexpected: %#v", actual, tt.expected)
			}
		})
	}
}

func TestNormalizeStorageConfigRejectsNodeZodInvalidShapes(t *testing.T) {
	tests := []struct {
		name     string
		create   bool
		provider string
		config   map[string]any
	}{
		{
			name:     "create requires nested provider literal",
			create:   true,
			provider: "s3",
			config: map[string]any{
				"bucket":          "chronoframe",
				"endpoint":        "https://s3.example.test",
				"accessKeyId":     "access",
				"secretAccessKey": "secret",
			},
		},
		{
			name:     "create rejects mismatched nested provider",
			create:   true,
			provider: "s3",
			config: map[string]any{
				"provider":        "local",
				"bucket":          "chronoframe",
				"endpoint":        "https://s3.example.test",
				"accessKeyId":     "access",
				"secretAccessKey": "secret",
			},
		},
		{
			name:     "create rejects empty local basePath",
			create:   true,
			provider: "local",
			config: map[string]any{
				"provider": "local",
				"basePath": "",
			},
		},
		{
			name:     "create rejects empty openlist token",
			create:   true,
			provider: "openlist",
			config: map[string]any{
				"provider": "openlist",
				"baseUrl":  "https://files.example.test",
				"rootPath": "/chronoframe",
				"token":    "",
			},
		},
		{
			name:     "update rejects mismatched nested provider",
			provider: "openlist",
			config: map[string]any{
				"provider": "s3",
			},
		},
		{
			name:     "update rejects null optional string",
			provider: "s3",
			config: map[string]any{
				"prefix": nil,
			},
		},
		{
			name:     "update rejects non-number maxKeys",
			provider: "s3",
			config: map[string]any{
				"maxKeys": "100",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var ok bool
			if tt.create {
				_, ok = normalizeStorageConfigForCreate(tt.provider, tt.config)
			} else {
				_, ok = normalizeStorageConfigForUpdate(tt.provider, tt.config)
			}
			if ok {
				t.Fatal("expected config to be invalid")
			}
		})
	}
}

func TestDecodeStorageConfigNamePreservesNodeZodStringSemantics(t *testing.T) {
	tests := []struct {
		name            string
		raw             json.RawMessage
		expectedValue   string
		expectedPresent bool
		expectedOK      bool
	}{
		{name: "missing", raw: nil, expectedPresent: false, expectedOK: true},
		{name: "empty string is valid", raw: json.RawMessage(`""`), expectedPresent: true, expectedOK: true},
		{name: "whitespace is not trimmed", raw: json.RawMessage(`"  storage  "`), expectedValue: "  storage  ", expectedPresent: true, expectedOK: true},
		{name: "null is invalid", raw: json.RawMessage(`null`), expectedPresent: true, expectedOK: false},
		{name: "number is invalid", raw: json.RawMessage(`123`), expectedPresent: true, expectedOK: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			value, present, ok := decodeStorageConfigName(tt.raw)
			if value != tt.expectedValue || present != tt.expectedPresent || ok != tt.expectedOK {
				t.Fatalf(
					"decodeStorageConfigName() = (%q, %v, %v), want (%q, %v, %v)",
					value,
					present,
					ok,
					tt.expectedValue,
					tt.expectedPresent,
					tt.expectedOK,
				)
			}
		})
	}
}

func TestDecodeRawJSONStringRejectsJSONNull(t *testing.T) {
	if value, ok := decodeRawJSONString(json.RawMessage(`null`)); ok || value != "" {
		t.Fatalf("decodeRawJSONString(null) = %q, %v; want empty, false", value, ok)
	}
}
