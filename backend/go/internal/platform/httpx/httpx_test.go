package httpx

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMiddlewareAddsBackendMetadataAndRequestID(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := Middleware(logger, Metadata{BackendVersion: "test", Maturity: "experimental", Mode: "normal"}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if RequestID(r.Context()) != "from-gateway" {
			t.Fatalf("RequestID() = %q", RequestID(r.Context()))
		}
		JSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Request-Id", "from-gateway")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	for name, want := range map[string]string{
		"X-Request-Id": "from-gateway", "X-ChronoFrame-Backend": "go",
		"X-ChronoFrame-Backend-Version": "test", "X-ChronoFrame-Maturity": "experimental",
		"X-ChronoFrame-Mode": "normal",
	} {
		if got := response.Header().Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}

func TestMiddlewareReplacesInvalidRequestID(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := Middleware(logger, Metadata{}, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Request-Id", "contains spaces")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if got := response.Header().Get("X-Request-Id"); got == "" || got == "contains spaces" {
		t.Fatalf("generated X-Request-Id = %q", got)
	}
}

func TestErrorMatchesH3ShapeAndKeepsForwardedURL(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := Middleware(logger, Metadata{}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		Error(w, http.StatusUnauthorized, "Site access required to view more albums")
	}))
	request := httptest.NewRequest(http.MethodGet, "/api/albums/10", nil)
	request.Header.Set(
		"X-ChronoFrame-Original-URL",
		"http://127.0.0.1:33110/api/albums/10",
	)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if got, want := response.Body.String(),
		`{"error":true,"url":"http://127.0.0.1:33110/api/albums/10","statusCode":401,"statusMessage":"Site access required to view more albums","message":"Site access required to view more albums"}
`; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("Cache-Control = %q, want no-cache", got)
	}
}

func TestErrorWithDataKeepsH3ValidationEnvelope(t *testing.T) {
	const validationMessage = `[
  {
    "origin": "string",
    "code": "invalid_format",
    "format": "regex",
    "pattern": "/^\d+$/",
    "path": [
      "albumId"
    ],
    "message": "Invalid string: must match pattern /^\d+$/"
  }
]`
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := Middleware(logger, Metadata{}, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		ErrorWithMessageData(w, http.StatusBadRequest, "Validation Error", validationMessage, struct {
			Name    string `json:"name"`
			Message string `json:"message"`
		}{
			Name:    "ZodError",
			Message: validationMessage,
		})
	}))
	request := httptest.NewRequest(http.MethodGet, "/api/albums/foo", nil)
	request.Header.Set(
		"X-ChronoFrame-Original-URL",
		"http://127.0.0.1:33110/api/albums/foo",
	)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if got, want := response.Body.String(),
		`{"error":true,"url":"http://127.0.0.1:33110/api/albums/foo","statusCode":400,"statusMessage":"Validation Error","message":"[\n  {\n    \"origin\": \"string\",\n    \"code\": \"invalid_format\",\n    \"format\": \"regex\",\n    \"pattern\": \"/^\\d+$/\",\n    \"path\": [\n      \"albumId\"\n    ],\n    \"message\": \"Invalid string: must match pattern /^\\d+$/\"\n  }\n]","data":{"name":"ZodError","message":"[\n  {\n    \"origin\": \"string\",\n    \"code\": \"invalid_format\",\n    \"format\": \"regex\",\n    \"pattern\": \"/^\\d+$/\",\n    \"path\": [\n      \"albumId\"\n    ],\n    \"message\": \"Invalid string: must match pattern /^\\d+$/\"\n  }\n]"}}
`; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}

func TestErrorWithMessageDataCanSeparateStatusMessageAndMessage(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := Middleware(logger, Metadata{}, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		ErrorWithMessageData(w, http.StatusNotFound, "Server Error", "Reaction not found", nil)
	}))
	request := httptest.NewRequest(http.MethodDelete, "/api/photos/p1/reactions", nil)
	request.Header.Set(
		"X-ChronoFrame-Original-URL",
		"http://127.0.0.1:33110/api/photos/p1/reactions",
	)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if got, want := response.Body.String(),
		`{"error":true,"url":"http://127.0.0.1:33110/api/photos/p1/reactions","statusCode":404,"statusMessage":"Server Error","message":"Reaction not found"}
`; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}
