package app

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeJSONBodyRejectsMalformedAndTrailingDocumentsLikeH3(t *testing.T) {
	for _, payload := range []string{
		`{`,
		`{"value":1}{"value":2}`,
		`{"value":1} trailing`,
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest("PUT", "/api/example", strings.NewReader(payload))
		var body map[string]any
		if decodeJSONBody(response, request, &body) {
			t.Fatalf("decodeJSONBody(%q) = true, want false", payload)
		}
		if response.Code != 400 {
			t.Fatalf("decodeJSONBody(%q) status = %d, want 400", payload, response.Code)
		}
		for _, field := range []string{
			`"statusMessage":"Bad Request"`,
			`"message":"Invalid JSON body"`,
		} {
			if !strings.Contains(response.Body.String(), field) {
				t.Fatalf("decodeJSONBody(%q) body = %s, want %s", payload, response.Body.String(), field)
			}
		}
	}
}

func TestDecodeJSONBodyAllowsOneValueWithTrailingWhitespace(t *testing.T) {
	response := httptest.NewRecorder()
	request := httptest.NewRequest("PUT", "/api/example", strings.NewReader("{\"value\":1}\n\t "))
	var body map[string]any
	if !decodeJSONBody(response, request, &body) {
		t.Fatalf("decodeJSONBody() = false, status = %d body = %s", response.Code, response.Body.String())
	}
	if body["value"] == nil {
		t.Fatalf("decoded body = %#v, want value", body)
	}
}

func TestRequiredJSONObjectBodyRejectsNullAtTheRoot(t *testing.T) {
	response := httptest.NewRecorder()
	request := httptest.NewRequest("PUT", "/api/example", strings.NewReader("null"))
	if _, ok := decodeRequiredJSONObjectBody(response, request); ok {
		t.Fatal("decodeRequiredJSONObjectBody(null) = true, want false")
	}
	var errorBody struct {
		StatusMessage string `json:"statusMessage"`
		Message       string `json:"message"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &errorBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errorBody.StatusMessage != "Validation Error" {
		t.Fatalf("statusMessage = %q, want Validation Error", errorBody.StatusMessage)
	}
	var issues []map[string]any
	if err := json.Unmarshal([]byte(errorBody.Message), &issues); err != nil {
		t.Fatalf("decode Zod issues: %v", err)
	}
	if len(issues) != 1 || issues[0]["expected"] != "object" ||
		issues[0]["message"] != "Invalid input: expected object, received null" {
		t.Fatalf("Zod issues = %#v", issues)
	}
}
