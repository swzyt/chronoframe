package app

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type pamImage struct {
	Width  int
	Height int
	RGBA   []byte
}

func generateThumbHashHex(ctx context.Context, source []byte) (string, error) {
	image, err := imageToThumbHashPAM(ctx, source)
	if err != nil {
		return "", err
	}
	hash, err := rgbaToThumbHash(image.Width, image.Height, image.RGBA)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(hash), nil
}

func imageToThumbHashPAM(ctx context.Context, source []byte) (pamImage, error) {
	if len(source) == 0 {
		return pamImage{}, errors.New("empty thumbhash source")
	}
	tempDir, err := os.MkdirTemp("", "chronoframe-thumbhash-*")
	if err != nil {
		return pamImage{}, err
	}
	defer os.RemoveAll(tempDir)

	input := filepath.Join(tempDir, "source.webp")
	stdout, err := runImageMagickCommand(
		ctx,
		input,
		source,
		"-auto-orient",
		"-resize", "100x100>",
		"-alpha", "on",
		"-depth", "8",
		"pam:-",
	)
	if err != nil {
		return pamImage{}, err
	}
	return parsePAMRGBA(stdout)
}

func parsePAMRGBA(data []byte) (pamImage, error) {
	const endHeader = "ENDHDR\n"
	headerEnd := strings.Index(string(data), endHeader)
	if headerEnd < 0 {
		return pamImage{}, errors.New("PAM output is missing ENDHDR")
	}
	header := string(data[:headerEnd])
	body := data[headerEnd+len(endHeader):]
	var width, height, depth int
	maxVal := 255
	tupleType := ""
	for _, line := range strings.Split(header, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "WIDTH":
			width, _ = strconv.Atoi(fields[1])
		case "HEIGHT":
			height, _ = strconv.Atoi(fields[1])
		case "DEPTH":
			depth, _ = strconv.Atoi(fields[1])
		case "MAXVAL":
			maxVal, _ = strconv.Atoi(fields[1])
		case "TUPLTYPE":
			tupleType = strings.Join(fields[1:], " ")
		}
	}
	if width <= 0 || height <= 0 {
		return pamImage{}, fmt.Errorf("invalid PAM dimensions %dx%d", width, height)
	}
	if width > 100 || height > 100 {
		return pamImage{}, fmt.Errorf("%dx%d doesn't fit in 100x100", width, height)
	}
	if depth != 4 || maxVal != 255 || !strings.EqualFold(tupleType, "RGB_ALPHA") {
		return pamImage{}, fmt.Errorf("unsupported PAM format depth=%d maxval=%d tuple=%q", depth, maxVal, tupleType)
	}
	expected := width * height * depth
	if len(body) < expected {
		return pamImage{}, fmt.Errorf("PAM RGBA body is too short: got %d want %d", len(body), expected)
	}
	return pamImage{Width: width, Height: height, RGBA: body[:expected]}, nil
}

func rgbaToThumbHash(width int, height int, rgba []byte) ([]byte, error) {
	if width <= 0 || height <= 0 {
		return nil, errors.New("thumbhash dimensions must be positive")
	}
	if width > 100 || height > 100 {
		return nil, fmt.Errorf("%dx%d doesn't fit in 100x100", width, height)
	}
	if len(rgba) < width*height*4 {
		return nil, fmt.Errorf("thumbhash RGBA buffer is too short: got %d want %d", len(rgba), width*height*4)
	}

	pixels := width * height
	var avgR, avgG, avgB, avgA float64
	for i, j := 0, 0; i < pixels; i, j = i+1, j+4 {
		alpha := float64(rgba[j+3]) / 255
		avgR += alpha / 255 * float64(rgba[j])
		avgG += alpha / 255 * float64(rgba[j+1])
		avgB += alpha / 255 * float64(rgba[j+2])
		avgA += alpha
	}
	if avgA != 0 {
		avgR /= avgA
		avgG /= avgA
		avgB /= avgA
	}

	hasAlpha := avgA < float64(pixels)
	lLimit := 7.0
	if hasAlpha {
		lLimit = 5
	}
	maxDimension := float64(max(width, height))
	lx := max(1, roundThumbHashInt(lLimit*float64(width)/maxDimension))
	ly := max(1, roundThumbHashInt(lLimit*float64(height)/maxDimension))

	luma := make([]float64, pixels)
	yellowBlue := make([]float64, pixels)
	redGreen := make([]float64, pixels)
	alphaChannel := make([]float64, pixels)
	for i, j := 0, 0; i < pixels; i, j = i+1, j+4 {
		alpha := float64(rgba[j+3]) / 255
		r := avgR*(1-alpha) + alpha/255*float64(rgba[j])
		g := avgG*(1-alpha) + alpha/255*float64(rgba[j+1])
		b := avgB*(1-alpha) + alpha/255*float64(rgba[j+2])
		luma[i] = (r + g + b) / 3
		yellowBlue[i] = (r+g)/2 - b
		redGreen[i] = r - g
		alphaChannel[i] = alpha
	}

	lDC, lAC, lScale := encodeThumbHashChannel(luma, width, height, max(3, lx), max(3, ly))
	pDC, pAC, pScale := encodeThumbHashChannel(yellowBlue, width, height, 3, 3)
	qDC, qAC, qScale := encodeThumbHashChannel(redGreen, width, height, 3, 3)
	var aDC, aScale float64
	var aAC []float64
	if hasAlpha {
		aDC, aAC, aScale = encodeThumbHashChannel(alphaChannel, width, height, 5, 5)
	}

	isLandscape := width > height
	header24 := roundThumbHashInt(63*lDC) |
		(roundThumbHashInt(31.5+31.5*pDC) << 6) |
		(roundThumbHashInt(31.5+31.5*qDC) << 12) |
		(roundThumbHashInt(31*lScale) << 18)
	if hasAlpha {
		header24 |= 1 << 23
	}
	header16 := lx
	if isLandscape {
		header16 = ly
	}
	header16 |= roundThumbHashInt(63*pScale) << 3
	header16 |= roundThumbHashInt(63*qScale) << 9
	if isLandscape {
		header16 |= 1 << 15
	}

	hash := []byte{
		byte(header24 & 255),
		byte((header24 >> 8) & 255),
		byte((header24 >> 16) & 255),
		byte(header16 & 255),
		byte((header16 >> 8) & 255),
	}
	acStart := 5
	if hasAlpha {
		hash = append(hash, byte(roundThumbHashInt(15*aDC)|(roundThumbHashInt(15*aScale)<<4)))
		acStart = 6
	}

	acIndex := 0
	channels := [][]float64{lAC, pAC, qAC}
	if hasAlpha {
		channels = append(channels, aAC)
	}
	for _, channel := range channels {
		for _, factor := range channel {
			index := acStart + acIndex/2
			for index >= len(hash) {
				hash = append(hash, 0)
			}
			shift := uint((acIndex & 1) << 2)
			hash[index] |= byte(roundThumbHashInt(15*factor) << shift)
			acIndex++
		}
	}
	return hash, nil
}

func encodeThumbHashChannel(channel []float64, width int, height int, nx int, ny int) (float64, []float64, float64) {
	var dc float64
	ac := make([]float64, 0)
	var scale float64
	fx := make([]float64, width)
	for cy := 0; cy < ny; cy++ {
		for cx := 0; cx*ny < nx*(ny-cy); cx++ {
			var f float64
			for x := 0; x < width; x++ {
				fx[x] = math.Cos(math.Pi / float64(width) * float64(cx) * (float64(x) + 0.5))
			}
			for y := 0; y < height; y++ {
				fy := math.Cos(math.Pi / float64(height) * float64(cy) * (float64(y) + 0.5))
				for x := 0; x < width; x++ {
					f += channel[x+y*width] * fx[x] * fy
				}
			}
			f /= float64(width * height)
			if cx != 0 || cy != 0 {
				ac = append(ac, f)
				scale = math.Max(scale, math.Abs(f))
			} else {
				dc = f
			}
		}
	}
	if scale != 0 {
		for index := range ac {
			ac[index] = 0.5 + 0.5/scale*ac[index]
		}
	}
	return dc, ac, scale
}

func roundThumbHashInt(value float64) int {
	return int(math.Floor(value + 0.5))
}
