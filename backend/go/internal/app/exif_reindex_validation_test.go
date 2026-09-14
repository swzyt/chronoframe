package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestDecodeExifReindexBodyMirrorsLegacyJavaScriptSemantics(t *testing.T) {
	for _, test := range []struct {
		name   string
		body   string
		ok     bool
		status int
		text   string
		action any
	}{
		{name: "missing", body: "", status: http.StatusInternalServerError, text: "Server Error"},
		{name: "null", body: "null", status: http.StatusInternalServerError, text: "Server Error"},
		{name: "primitive", body: "1", ok: true},
		{name: "array", body: "[]", ok: true},
		{name: "object", body: `{"action":"batch-reindex"}`, ok: true, action: "batch-reindex"},
		{name: "malformed", body: `{`, status: http.StatusBadRequest, text: "Invalid JSON body"},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/api/photos/exif/reindex", strings.NewReader(test.body))
			got, ok := decodeExifReindexBody(response, request)
			if ok != test.ok {
				t.Fatalf("ok = %t, want %t; body=%s", ok, test.ok, response.Body.String())
			}
			if !ok {
				if response.Code != test.status || !strings.Contains(response.Body.String(), test.text) {
					t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
				}
				return
			}
			if !reflect.DeepEqual(got.Action, test.action) {
				t.Fatalf("action = %#v, want %#v", got.Action, test.action)
			}
		})
	}
}

func TestExifReindexCandidateIDsUseSQLiteBindingSemantics(t *testing.T) {
	values := []any{"photo", json.Number("42"), nil}
	got, filtered, ok := exifReindexCandidateIDs(values)
	if !ok || !filtered || !reflect.DeepEqual(got, []any{"photo", float64(42), nil}) {
		t.Fatalf("got=%#v filtered=%t ok=%t", got, filtered, ok)
	}
	if got, filtered, ok := exifReindexCandidateIDs([]any{}); !ok || filtered || got != nil {
		t.Fatalf("empty got=%#v filtered=%t ok=%t", got, filtered, ok)
	}
	if _, filtered, ok := exifReindexCandidateIDs([]any{true}); ok || !filtered {
		t.Fatalf("boolean filtered=%t ok=%t", filtered, ok)
	}
}
