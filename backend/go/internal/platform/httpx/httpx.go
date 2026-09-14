package httpx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"
)

type contextKey string

const requestIDKey contextKey = "request-id"

type Metadata struct {
	BackendVersion string
	Maturity       string
	Mode           string
}

type ErrorResponse struct {
	Error         bool   `json:"error"`
	URL           string `json:"url,omitempty"`
	StatusCode    int    `json:"statusCode"`
	StatusMessage string `json:"statusMessage"`
	Message       string `json:"message"`
	Data          any    `json:"data,omitempty"`
}

func JSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func Error(w http.ResponseWriter, status int, message string) {
	ErrorWithData(w, status, message, nil)
}

func ErrorWithData(w http.ResponseWriter, status int, message string, data any) {
	ErrorWithMessageData(w, status, message, message, data)
}

func ErrorWithMessageData(
	w http.ResponseWriter,
	status int,
	statusMessage string,
	message string,
	data any,
) {
	if w.Header().Get("Cache-Control") == "" {
		w.Header().Set("Cache-Control", "no-cache")
	}
	requestURL := ""
	if aware, ok := w.(interface{ RequestURL() string }); ok {
		requestURL = aware.RequestURL()
	}
	JSON(w, status, ErrorResponse{
		Error:         true,
		URL:           requestURL,
		StatusCode:    status,
		StatusMessage: statusMessage,
		Message:       message,
		Data:          data,
	})
}

func RequestID(ctx context.Context) string {
	value, _ := ctx.Value(requestIDKey).(string)
	return value
}

func Middleware(logger *slog.Logger, metadata Metadata, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		requestID := acceptedRequestID(r.Header.Get("X-Request-Id"))
		if requestID == "" {
			requestID = newRequestID()
		}
		ctx := context.WithValue(r.Context(), requestIDKey, requestID)
		r = r.WithContext(ctx)

		w.Header().Set("X-Request-Id", requestID)
		w.Header().Set("X-ChronoFrame-Backend", "go")
		w.Header().Set("X-ChronoFrame-Backend-Version", metadata.BackendVersion)
		w.Header().Set("X-ChronoFrame-Maturity", metadata.Maturity)
		w.Header().Set("X-ChronoFrame-Mode", metadata.Mode)
		w.Header().Set("X-Content-Type-Options", "nosniff")

		response := &statusWriter{
			ResponseWriter: w,
			status:         http.StatusOK,
			requestURL:     requestURL(r),
		}
		defer func() {
			if recovered := recover(); recovered != nil {
				logger.ErrorContext(ctx, "panic recovered", "request_id", requestID, "panic", recovered, "stack", string(debug.Stack()))
				if !response.wroteHeader {
					Error(response, http.StatusInternalServerError, "Internal Server Error")
				}
			}
			logger.InfoContext(ctx, "request complete",
				"request_id", requestID,
				"method", r.Method,
				"path", r.URL.Path,
				"status", response.status,
				"duration_ms", time.Since(started).Milliseconds(),
			)
		}()
		next.ServeHTTP(response, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
	requestURL  string
}

// Flush keeps streaming handlers (SSE and media) working through the status
// writer used by the request middleware. Without forwarding Flusher, the
// handler would silently buffer the entire response until it closes.
func (w *statusWriter) Flush() {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *statusWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *statusWriter) RequestURL() string {
	return w.requestURL
}

func (w *statusWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.status = status
	w.wroteHeader = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(body []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}

func requestURL(r *http.Request) string {
	if forwarded := strings.TrimSpace(r.Header.Get("X-ChronoFrame-Original-URL")); forwarded != "" {
		return forwarded
	}
	scheme := "http"
	if strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") || r.TLS != nil {
		scheme = "https"
	}
	if r.Host == "" {
		return r.URL.RequestURI()
	}
	return scheme + "://" + r.Host + r.URL.RequestURI()
}

func acceptedRequestID(value string) string {
	value = strings.TrimSpace(value)
	if len(value) == 0 || len(value) > 128 {
		return ""
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || strings.ContainsRune("-_.:/", character) {
			continue
		}
		return ""
	}
	return value
}

func newRequestID() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(value)
}
