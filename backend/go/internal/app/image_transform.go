package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"html"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf16"
)

const (
	shareOGWidth  = 1200
	shareOGHeight = 600
)

func generateDisplayImage(ctx context.Context, key string, source []byte) ([]byte, error) {
	return runImageMagick(ctx, key, source, ".webp",
		"-auto-orient",
		"-resize", "2560x2560>",
		"-quality", "82",
		"-define", "webp:method=4",
	)
}

func generateJPEGThumbnail(ctx context.Context, key string, source []byte) ([]byte, error) {
	return runVipsJPEG(ctx, key, source, "85")
}

func generateWebPThumbnail(ctx context.Context, source []byte, quality string) ([]byte, error) {
	if strings.TrimSpace(quality) == "" {
		quality = "100"
	}
	return runImageMagickWithInputExt(ctx, ".webp", source, ".webp",
		"-auto-orient",
		"-resize", "600x>",
		"-quality", quality,
	)
}

func generateShareMedia(ctx context.Context, key string, source []byte) ([]byte, error) {
	if len(source) == 0 {
		return nil, errors.New("empty source image")
	}
	tempDir, err := os.MkdirTemp("", "chronoframe-share-media-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tempDir)

	inputExt := filepath.Ext(key)
	if inputExt == "" {
		inputExt = ".bin"
	}
	input := filepath.Join(tempDir, "source"+inputExt)
	output := filepath.Join(tempDir, "media.png")
	if err := os.WriteFile(input, source, 0o600); err != nil {
		return nil, err
	}
	if err := runVips(ctx,
		"thumbnail", input, output, strconv.Itoa(shareOGWidth),
		"--height", strconv.Itoa(shareOGHeight),
		"--size", "both",
		"--crop", "centre",
	); err != nil {
		return nil, err
	}
	return os.ReadFile(output)
}

func runImageMagick(
	ctx context.Context,
	key string,
	source []byte,
	outputExt string,
	args ...string,
) ([]byte, error) {
	inputExt := filepath.Ext(key)
	if inputExt == "" {
		inputExt = ".bin"
	}
	return runImageMagickWithInputExt(ctx, inputExt, source, outputExt, args...)
}

func runImageMagickWithInputExt(
	ctx context.Context,
	inputExt string,
	source []byte,
	outputExt string,
	args ...string,
) ([]byte, error) {
	if len(source) == 0 {
		return nil, errors.New("empty source image")
	}
	tempDir, err := os.MkdirTemp("", "chronoframe-image-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tempDir)

	if strings.TrimSpace(inputExt) == "" {
		inputExt = ".bin"
	}
	input := filepath.Join(tempDir, "source"+inputExt)
	output := filepath.Join(tempDir, "output"+outputExt)
	if err := os.WriteFile(input, source, 0o600); err != nil {
		return nil, err
	}

	commandArgs := make([]string, 0, 2+len(args))
	commandArgs = append(commandArgs, input)
	commandArgs = append(commandArgs, args...)
	commandArgs = append(commandArgs, output)
	if err := runMagick(ctx, commandArgs...); err != nil {
		return nil, err
	}
	return os.ReadFile(output)
}

func runVipsJPEG(ctx context.Context, key string, source []byte, quality string) ([]byte, error) {
	if len(source) == 0 {
		return nil, errors.New("empty source image")
	}
	if strings.TrimSpace(quality) == "" {
		quality = "85"
	}
	tempDir, err := os.MkdirTemp("", "chronoframe-vips-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tempDir)

	inputExt := filepath.Ext(key)
	if inputExt == "" {
		inputExt = ".bin"
	}
	input := filepath.Join(tempDir, "source"+inputExt)
	output := filepath.Join(tempDir, "output.jpg")
	if err := os.WriteFile(input, source, 0o600); err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, "vips", "jpegsave", input, output,
		"--Q", quality,
		"--strip",
		"--optimize-coding",
	)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message != "" {
			return nil, fmt.Errorf("vips: %w: %s", err, message)
		}
		return nil, fmt.Errorf("vips: %w", err)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, errors.New("vips produced empty output")
	}
	return data, nil
}

func runImageMagickCommand(
	ctx context.Context,
	input string,
	source []byte,
	args ...string,
) ([]byte, error) {
	if len(source) == 0 {
		return nil, errors.New("empty source image")
	}
	if err := os.WriteFile(input, source, 0o600); err != nil {
		return nil, err
	}
	commandArgs := make([]string, 0, 1+len(args))
	commandArgs = append(commandArgs, input)
	commandArgs = append(commandArgs, args...)
	command := exec.CommandContext(ctx, "magick", commandArgs...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message != "" {
			return nil, fmt.Errorf("imagemagick: %w: %s", err, message)
		}
		return nil, fmt.Errorf("imagemagick: %w", err)
	}
	return stdout.Bytes(), nil
}

func composeShareOGImage(ctx context.Context, mediaPNG []byte, overlaySVG string) ([]byte, error) {
	tempDir, err := os.MkdirTemp("", "chronoframe-og-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tempDir)

	mediaPath := filepath.Join(tempDir, "media.png")
	backgroundPath := filepath.Join(tempDir, "background.svg")
	overlayPath := filepath.Join(tempDir, "overlay.svg")
	basePath := filepath.Join(tempDir, "base.v")
	outputPath := filepath.Join(tempDir, "share.png")
	if err := os.WriteFile(mediaPath, mediaPNG, 0o600); err != nil {
		return nil, err
	}
	if err := os.WriteFile(overlayPath, []byte(overlaySVG), 0o600); err != nil {
		return nil, err
	}
	backgroundSVG := fmt.Sprintf(
		`<svg width="%d" height="%d" xmlns="http://www.w3.org/2000/svg"><rect width="100%%" height="100%%" fill="#09090b"/></svg>`,
		shareOGWidth,
		shareOGHeight,
	)
	if err := os.WriteFile(backgroundPath, []byte(backgroundSVG), 0o600); err != nil {
		return nil, err
	}
	if err := runVips(ctx, "composite2", backgroundPath, mediaPath, basePath, "over"); err != nil {
		return nil, err
	}
	if err := runVips(ctx, "composite2", basePath, overlayPath, outputPath, "over"); err != nil {
		return nil, err
	}
	return os.ReadFile(outputPath)
}

func svgToPNG(ctx context.Context, svg string) ([]byte, error) {
	tempDir, err := os.MkdirTemp("", "chronoframe-svg-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tempDir)

	input := filepath.Join(tempDir, "source.svg")
	output := filepath.Join(tempDir, "output.png")
	if err := os.WriteFile(input, []byte(svg), 0o600); err != nil {
		return nil, err
	}
	if err := runVips(ctx, "copy", input, output); err != nil {
		return nil, err
	}
	return os.ReadFile(output)
}

func runVips(ctx context.Context, args ...string) error {
	command := exec.CommandContext(ctx, "vips", args...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message != "" {
			return fmt.Errorf("vips: %w: %s", err, message)
		}
		return fmt.Errorf("vips: %w", err)
	}
	return nil
}

func runMagick(ctx context.Context, args ...string) error {
	command := exec.CommandContext(ctx, "magick", args...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message != "" {
			return fmt.Errorf("imagemagick: %w: %s", err, message)
		}
		return fmt.Errorf("imagemagick: %w", err)
	}
	return nil
}

func escapeSVG(value any) string {
	return html.EscapeString(fmt.Sprint(value))
}

func truncateText(value any, max int) string {
	text := jsTrimSpace(fmt.Sprint(value))
	units := utf16.Encode([]rune(text))
	if max <= 0 || len(units) <= max {
		return text
	}
	return string(utf16.Decode(append(units[:max-1], uint16('…'))))
}
