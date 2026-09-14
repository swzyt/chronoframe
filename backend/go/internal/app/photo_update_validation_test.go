package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodePhotoUpdateBodyMatchesNodeUnhandledZodErrors(t *testing.T) {
	for _, testCase := range []struct {
		name string
		body *string
	}{
		{name: "missing body"},
		{name: "null body", body: stringPointer(`null`)},
		{
			name: "wrong field types",
			body: stringPointer(`{"title":null,"description":1,"tags":"x","location":true,"rating":"3"}`),
		},
		{
			name: "UTF-16 text bounds",
			body: stringPointer(`{"title":"` + strings.Repeat("😀", 257) + `"}`),
		},
		{
			name: "tag item bounds",
			body: stringPointer(`{"tags":[1,"` + strings.Repeat("😀", 65) + `"]}`),
		},
		{name: "missing location coordinates", body: stringPointer(`{"location":{}}`)},
		{name: "fractional rating", body: stringPointer(`{"rating":1.5}`)},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			reader := strings.NewReader("")
			if testCase.body != nil {
				reader = strings.NewReader(*testCase.body)
			}
			response := httptest.NewRecorder()
			_, ok := decodePhotoUpdateBody(
				response,
				httptest.NewRequest(http.MethodPut, "/api/photos/missing", reader),
			)
			if ok {
				t.Fatal("decodePhotoUpdateBody() ok = true, want false")
			}
			if response.Code != http.StatusInternalServerError ||
				!strings.Contains(response.Body.String(), `"statusMessage":"Server Error"`) ||
				!strings.Contains(response.Body.String(), `"message":"Server Error"`) {
				t.Fatalf("response = %d %s, want Node-compatible unhandled schema error", response.Code, response.Body.String())
			}
		})
	}
}

func TestDecodePhotoUpdateBodyKeepsMalformedJSONAsBadRequest(t *testing.T) {
	response := httptest.NewRecorder()
	_, ok := decodePhotoUpdateBody(
		response,
		httptest.NewRequest(http.MethodPut, "/api/photos/missing", strings.NewReader(`{"title":`)),
	)
	if ok {
		t.Fatal("decodePhotoUpdateBody() ok = true, want false")
	}
	if response.Code != http.StatusBadRequest ||
		!strings.Contains(response.Body.String(), `"statusMessage":"Bad Request"`) ||
		!strings.Contains(response.Body.String(), `"message":"Invalid JSON body"`) {
		t.Fatalf("response = %d %s, want invalid JSON body", response.Code, response.Body.String())
	}
}

func TestDecodePhotoUpdateBodyTransformsAndStripsLikeNode(t *testing.T) {
	response := httptest.NewRecorder()
	body, ok := decodePhotoUpdateBody(
		response,
		httptest.NewRequest(
			http.MethodPut,
			"/api/photos/photo-1",
			strings.NewReader(`{
				"title":"\ufeff  title \u3000",
				"description":"  description  ",
				"tags":[" First ","first","  ","Second"],
				"location":{"latitude":31.2,"longitude":121.5,"unknown":true},
				"rating":4,
				"unknown":"stripped"
			}`),
		),
	)
	if !ok {
		t.Fatalf("valid body rejected: %s", response.Body.String())
	}
	if body.Title == nil || *body.Title != "title" ||
		body.Description == nil || *body.Description != "description" {
		t.Fatalf("text fields = %#v / %#v, want trimmed values", body.Title, body.Description)
	}
	if body.Tags == nil {
		t.Fatal("tags = nil")
	}
	tags, normalized := normalizeTags(*body.Tags)
	if !normalized || len(tags) != 2 || tags[0] != "First" || tags[1] != "Second" {
		t.Fatalf("normalized tags = %#v, %v", tags, normalized)
	}
	if !body.Location.Present || body.Location.Value == nil ||
		body.Location.Value.Latitude != 31.2 || body.Location.Value.Longitude != 121.5 {
		t.Fatalf("location = %#v", body.Location)
	}
	if !body.Rating.Present || body.Rating.Value == nil || *body.Rating.Value != 4 {
		t.Fatalf("rating = %#v", body.Rating)
	}
}

func TestDecodePhotoUpdateBodyPreservesNullableAndNoChangeStates(t *testing.T) {
	response := httptest.NewRecorder()
	body, ok := decodePhotoUpdateBody(
		response,
		httptest.NewRequest(
			http.MethodPut,
			"/api/photos/photo-1",
			strings.NewReader(`{"location":null,"rating":null}`),
		),
	)
	if !ok {
		t.Fatalf("nullable body rejected: %s", response.Body.String())
	}
	if !body.Location.Present || body.Location.Value != nil ||
		!body.Rating.Present || body.Rating.Value != nil {
		t.Fatalf("nullable body = %#v", body)
	}

	response = httptest.NewRecorder()
	body, ok = decodePhotoUpdateBody(
		response,
		httptest.NewRequest(http.MethodPut, "/api/photos/photo-1", strings.NewReader(`{"unknown":true}`)),
	)
	if !ok {
		t.Fatalf("unknown-only body rejected: %s", response.Body.String())
	}
	if body.Title != nil || body.Description != nil || body.Tags != nil ||
		body.Location.Present || body.Rating.Present {
		t.Fatalf("unknown field was not stripped: %#v", body)
	}
}

func stringPointer(value string) *string {
	return &value
}
