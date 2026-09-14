package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestDecodeLivePhotoManageBodyMatchesNodeRootValueSemantics(t *testing.T) {
	for _, test := range []struct {
		name       string
		body       string
		missing    bool
		wantOK     bool
		wantStatus int
	}{
		{name: "missing", missing: true, wantStatus: http.StatusInternalServerError},
		{name: "null", body: "null", wantStatus: http.StatusInternalServerError},
		{name: "number", body: "1", wantOK: true},
		{name: "string", body: `"scan"`, wantOK: true},
		{name: "array", body: "[]", wantOK: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var request *http.Request
			if test.missing {
				request = httptest.NewRequest(http.MethodPost, "/api/photos/livephoto/manage", nil)
			} else {
				request = httptest.NewRequest(http.MethodPost, "/api/photos/livephoto/manage", strings.NewReader(test.body))
			}
			response := httptest.NewRecorder()
			body, ok := decodeLivePhotoManageBody(response, request)
			if ok != test.wantOK {
				t.Fatalf("ok = %t, want %t; status=%d body=%s", ok, test.wantOK, response.Code, response.Body.String())
			}
			if test.wantStatus != 0 && response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, test.wantStatus, response.Body.String())
			}
			if test.wantOK && body != (livePhotoManageBody{}) {
				t.Fatalf("body = %#v, want boxed root with undefined fields", body)
			}
		})
	}
}

func TestDecodeLivePhotoManageBodyPreservesDynamicFields(t *testing.T) {
	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/photos/livephoto/manage",
		strings.NewReader(`{"action":1,"videoKey":[],"photoId":{},"photoIds":"all"}`),
	)
	body, ok := decodeLivePhotoManageBody(response, request)
	if !ok {
		t.Fatalf("decode failed: status=%d body=%s", response.Code, response.Body.String())
	}
	if got, want := body.Action, json.Number("1"); got != want {
		t.Fatalf("action = %#v, want %#v", got, want)
	}
	if _, ok := body.VideoKey.([]any); !ok {
		t.Fatalf("videoKey type = %T, want []any", body.VideoKey)
	}
	if _, ok := body.PhotoID.(map[string]any); !ok {
		t.Fatalf("photoId type = %T, want map[string]any", body.PhotoID)
	}
	if got, want := body.PhotoIDs, "all"; got != want {
		t.Fatalf("photoIds = %#v, want %#v", got, want)
	}
}

func TestDecodeLivePhotoManageBodyRejectsMalformedAndTrailingJSON(t *testing.T) {
	for _, payload := range []string{`{"action":`, `{"action":"scan"} {}`} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/photos/livephoto/manage", strings.NewReader(payload))
		if _, ok := decodeLivePhotoManageBody(response, request); ok {
			t.Fatalf("decode(%q) = true, want false", payload)
		}
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"message":"Invalid JSON body"`) {
			t.Fatalf("decode(%q): status=%d body=%s", payload, response.Code, response.Body.String())
		}
	}
}

func TestJSONJavaScriptTruthy(t *testing.T) {
	for _, test := range []struct {
		value any
		want  bool
	}{
		{nil, false}, {false, false}, {true, true},
		{"", false}, {" ", true},
		{json.Number("0"), false}, {json.Number("-0"), false}, {json.Number("1"), true},
		{[]any{}, true}, {map[string]any{}, true},
	} {
		if got := jsonJavaScriptTruthy(test.value); got != test.want {
			t.Fatalf("jsonJavaScriptTruthy(%#v) = %t, want %t", test.value, got, test.want)
		}
	}
}

func TestLivePhotoCandidateIDsMatchesNodeArrayGateAndBindings(t *testing.T) {
	for _, value := range []any{nil, "all", []any{}} {
		ids, ok := livePhotoCandidateIDs(value)
		if !ok || ids != nil {
			t.Fatalf("livePhotoCandidateIDs(%#v) = (%#v,%t), want (nil,true)", value, ids, ok)
		}
	}
	got, ok := livePhotoCandidateIDs([]any{"photo-1", json.Number("2"), nil})
	if !ok || !reflect.DeepEqual(got, []any{"photo-1", float64(2), nil}) {
		t.Fatalf("ids = %#v, ok=%t", got, ok)
	}
	for _, value := range []any{true, []any{}, map[string]any{}} {
		if ids, ok := livePhotoCandidateIDs([]any{value}); ok || ids != nil {
			t.Fatalf("invalid binding %#v = (%#v,%t), want (nil,false)", value, ids, ok)
		}
	}
}
