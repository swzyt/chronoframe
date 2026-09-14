package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodePhotoReactionBodyMatchesNodeRootValueSemantics(t *testing.T) {
	for _, testCase := range []struct {
		name       string
		body       string
		want       string
		ok         bool
		wantStatus int
	}{
		{name: "missing body", wantStatus: 500},
		{name: "null body", body: `null`, wantStatus: 500},
		{name: "number body", body: `1`, ok: true},
		{name: "string body", body: `"like"`, ok: true},
		{name: "array body", body: `[]`, ok: true},
		{name: "empty object", body: `{}`, ok: true},
		{name: "wrong field type", body: `{"reactionType":["like"]}`, ok: true},
		{name: "valid reaction", body: `{"reactionType":"love","unknown":true}`, want: "love", ok: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			got, ok := decodePhotoReactionBody(
				response,
				httptest.NewRequest(http.MethodPost, "/api/photos/photo-1/reactions", strings.NewReader(testCase.body)),
			)
			if ok != testCase.ok || got != testCase.want {
				t.Fatalf("decodePhotoReactionBody() = %q, %v; want %q, %v", got, ok, testCase.want, testCase.ok)
			}
			if !testCase.ok {
				if response.Code != testCase.wantStatus ||
					!strings.Contains(response.Body.String(), `"statusMessage":"Server Error"`) {
					t.Fatalf("response = %d %s", response.Code, response.Body.String())
				}
			}
		})
	}
}

func TestDecodePhotoReactionBodyKeepsMalformedJSONAsBadRequest(t *testing.T) {
	response := httptest.NewRecorder()
	_, ok := decodePhotoReactionBody(
		response,
		httptest.NewRequest(http.MethodPost, "/api/photos/photo-1/reactions", strings.NewReader(`{"reactionType":`)),
	)
	if ok {
		t.Fatal("decodePhotoReactionBody() ok = true, want false")
	}
	if response.Code != http.StatusBadRequest ||
		!strings.Contains(response.Body.String(), `"statusMessage":"Bad Request"`) ||
		!strings.Contains(response.Body.String(), `"message":"Invalid JSON body"`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}
