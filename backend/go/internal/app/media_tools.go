package app

import (
	"context"
	"os"
	"os/exec"
	"strings"
)

type defaultMediaToolChecker struct{}

func (defaultMediaToolChecker) Check(ctx context.Context) map[string]string {
	failures := map[string]string{}
	for _, tool := range requiredMediaTools() {
		select {
		case <-ctx.Done():
			failures[tool.name] = ctx.Err().Error()
			return failures
		default:
		}
		if _, err := exec.LookPath(tool.path); err != nil {
			failures[tool.name] = "missing: " + tool.path
		}
	}
	return failures
}

type mediaTool struct {
	name string
	path string
}

func requiredMediaTools() []mediaTool {
	return []mediaTool{
		{name: "exiftool", path: envMediaToolPath("EXIFTOOL_PATH", "exiftool")},
		{name: "magick", path: envMediaToolPath("MAGICK_PATH", "magick")},
		{name: "vips", path: envMediaToolPath("VIPS_PATH", "vips")},
		{name: "ffmpeg", path: envMediaToolPath("FFMPEG_PATH", "/usr/bin/ffmpeg")},
		{name: "ffprobe", path: envMediaToolPath("FFPROBE_PATH", "/usr/bin/ffprobe")},
	}
}

func envMediaToolPath(name string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
