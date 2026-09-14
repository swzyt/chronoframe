package app

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/swzyt/chronoframe/backend/go/internal/platform/httpx"
)

type uploadBody struct {
	reader io.Reader
	size   int64
}

func (a *Application) checkedUploadBody(w http.ResponseWriter, r *http.Request, contentType string) (uploadBody, bool) {
	if a.config.UploadMIMEWhitelistEnabled {
		allowed := parseUploadMIMEWhitelist(a.config.UploadMIMEWhitelist)
		if len(allowed) > 0 && !allowed[contentType] {
			httpx.Error(w, http.StatusUnsupportedMediaType, "Unsupported File Type")
			return uploadBody{}, false
		}
	}

	maxBytes := a.maxUploadBytes(r.Context())
	if r.ContentLength > maxBytes {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "File too large")
		return uploadBody{}, false
	}

	body := uploadBody{reader: r.Body, size: r.ContentLength}
	if r.ContentLength < 0 {
		body.reader = http.MaxBytesReader(w, r.Body, maxBytes+1)
		body.size = -1
	}
	return body, true
}

func (a *Application) maxUploadBytes(ctx context.Context) int64 {
	const bytesPerMiB = int64(1024 * 1024)
	return a.settingInt(ctx, "system", "upload.maxFileSize", 256) * bytesPerMiB
}

func uploadContentType(r *http.Request) string {
	contentType := r.Header.Get("Content-Type")
	if contentType == "" {
		return "application/octet-stream"
	}
	return contentType
}

func parseUploadMIMEWhitelist(value string) map[string]bool {
	allowed := map[string]bool{}
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item != "" {
			allowed[item] = true
		}
	}
	return allowed
}

func isUploadTooLargeError(err error) bool {
	var maxBytesError *http.MaxBytesError
	return errors.As(err, &maxBytesError)
}
