package app

import (
	"bufio"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/platform/httpx"
)

const (
	defaultInitialLogLines = 400
	maxInitialLogLines     = 2000
	maxInitialLogReadBytes = 2 << 20
	systemLogsCacheControl = "private, no-cache, no-store, no-transform, must-revalidate, max-age=0"
)

// systemLogs mirrors the Node SSE log endpoint. The Go service owns its own
// log file, but uses the same path and event shape so the dashboard does not
// need a language-specific client.
func (a *Application) systemLogs(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Logging unavailable")
		return
	}
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}

	initial := parseInitialLogLines(r.URL.Query())
	logPath := a.config.LogFile
	if strings.TrimSpace(logPath) == "" {
		logPath = "./data/logs/app.log"
	}
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Unable to prepare log stream")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", systemLogsCacheControl)
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, ok := w.(http.Flusher)
	if !ok {
		httpx.Error(w, http.StatusInternalServerError, "Streaming is unavailable")
		return
	}

	offset, err := sendInitialLogLines(w, flusher, logPath, initial)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		a.logger.WarnContext(r.Context(), "initial log stream read failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
	}

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			next, err := sendNewLogLines(w, flusher, logPath, offset)
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					offset = 0
					continue
				}
				a.logger.WarnContext(r.Context(), "log stream read failed",
					"request_id", httpx.RequestID(r.Context()), "error", err)
				continue
			}
			offset = next
		}
	}
}

func parseInitialLogLines(query url.Values) int {
	if !nodeQueryHas(query, "initial") {
		return defaultInitialLogLines
	}
	raw := nodeQueryString(query, "initial")
	if !nodeQueryIsArray(query, "initial") && strings.EqualFold(raw, "all") {
		return -1
	}
	value, ok := parseJavaScriptNumber(raw)
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
		return defaultInitialLogLines
	}
	value = math.Floor(value)
	if value < 0 {
		return 0
	}
	if value > maxInitialLogLines {
		return maxInitialLogLines
	}
	return int(value)
}

func sendInitialLogLines(
	w http.ResponseWriter,
	flusher http.Flusher,
	path string,
	initial int,
) (int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	stat, err := file.Stat()
	if err != nil {
		return 0, err
	}
	offset := stat.Size()
	if initial == 0 || stat.Size() == 0 {
		flusher.Flush()
		return offset, nil
	}

	if initial < 0 {
		content, err := io.ReadAll(file)
		if err != nil {
			return 0, err
		}
		for _, line := range splitLogLines(string(content)) {
			if err := writeSSELine(w, line); err != nil {
				return 0, err
			}
		}
		flusher.Flush()
		return offset, nil
	}

	readStart := stat.Size() - maxInitialLogReadBytes
	if readStart < 0 {
		readStart = 0
	}
	if _, err := file.Seek(readStart, io.SeekStart); err != nil {
		return 0, err
	}
	content, err := io.ReadAll(file)
	if err != nil {
		return 0, err
	}
	lines := splitLogLines(string(content))
	if initial > 0 && len(lines) > initial {
		lines = lines[len(lines)-initial:]
	}
	for _, line := range lines {
		if err := writeSSELine(w, line); err != nil {
			return 0, err
		}
	}
	flusher.Flush()
	return offset, nil
}

func sendNewLogLines(
	w http.ResponseWriter,
	flusher http.Flusher,
	path string,
	offset int64,
) (int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return 0, err
	}
	if stat.Size() < offset {
		offset = 0
	}
	if stat.Size() == offset {
		return offset, nil
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return 0, err
	}

	reader := bufio.NewReader(file)
	for {
		line, readErr := reader.ReadString('\n')
		line = strings.TrimSpace(line)
		if line != "" {
			if err := writeSSELine(w, line); err != nil {
				return 0, err
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return 0, readErr
		}
	}
	flusher.Flush()
	return stat.Size(), nil
}

func splitLogLines(content string) []string {
	lines := strings.Split(content, "\n")
	result := make([]string, 0, len(lines))
	for _, line := range lines {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func writeSSELine(w http.ResponseWriter, line string) error {
	_, err := io.WriteString(w, "data: "+strings.ReplaceAll(line, "\n", " ")+"\n\n")
	return err
}
