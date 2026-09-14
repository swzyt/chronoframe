package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodePhotoCreateBodyMirrorsLegacyJavaScriptSemantics(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		ok         bool
		status     int
		fileName   string
		content    string
		hash       string
		skip       bool
		statusText string
	}{
		{name: "missing body", body: "", ok: true},
		{name: "null body", body: "null", ok: true},
		{name: "array body", body: "[]", ok: true},
		{name: "false body", body: "false", ok: true},
		{name: "valid", body: `{"fileName":"clip.MOV","contentType":"video/quicktime","contentHash":" ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789 ","skipDuplicateCheck":[]}`, ok: true, fileName: "clip.MOV", content: "video/quicktime", hash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", skip: true},
		{name: "numeric filename", body: `{"fileName":1}`, status: http.StatusInternalServerError, statusText: "Server Error"},
		{name: "numeric content type", body: `{"fileName":"x.jpg","contentType":1}`, status: http.StatusInternalServerError, statusText: "Server Error"},
		{name: "numeric content hash", body: `{"contentHash":1}`, status: http.StatusInternalServerError, statusText: "Server Error"},
		{name: "malformed", body: `{`, status: http.StatusBadRequest, statusText: "Invalid JSON body"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/api/photos", strings.NewReader(test.body))
			got, ok := decodePhotoCreateBody(response, request)
			if ok != test.ok {
				t.Fatalf("ok = %t, want %t; body=%s", ok, test.ok, response.Body.String())
			}
			if !test.ok {
				if response.Code != test.status || !strings.Contains(response.Body.String(), test.statusText) {
					t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
				}
				return
			}
			if got.FileName != test.fileName || got.ContentType != test.content || got.ContentHash != test.hash || got.SkipDuplicateCheck != test.skip {
				t.Fatalf("decoded = %#v", got)
			}
		})
	}
}
