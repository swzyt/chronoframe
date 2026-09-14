package app

import (
	"encoding/json"
	"math"
	"math/big"
	"net/http"
	"strconv"
	"strings"
)

type uploadShareOptionalString struct {
	Value   *string
	Present bool
}

type uploadShareOptionalInt struct {
	Value   *int64
	Present bool
}

type uploadShareCreateBody struct {
	Label         uploadShareOptionalString
	ExpiresInDays int64
	MaxUploads    uploadShareOptionalInt
}

type uploadShareUpdateBody struct {
	Label      uploadShareOptionalString
	IsActive   *bool
	MaxUploads uploadShareOptionalInt
}

func decodeUploadShareCreateBody(w http.ResponseWriter, r *http.Request) (uploadShareCreateBody, bool) {
	object, ok := decodeRequiredJSONObjectBody(w, r)
	if !ok {
		return uploadShareCreateBody{}, false
	}

	issues := make([]zodValidationIssue, 0)
	label, labelIssues := decodeUploadShareLabel(object, false)
	issues = append(issues, labelIssues...)
	expiresInDays, expiresPresent, expiresIssues := decodeUploadShareBoundedInt(
		object,
		"expiresInDays",
		1,
		365,
		false,
	)
	issues = append(issues, expiresIssues...)
	maxUploads, maxUploadsPresent, maxUploadsIssues := decodeUploadShareBoundedInt(
		object,
		"maxUploads",
		1,
		10000,
		true,
	)
	issues = append(issues, maxUploadsIssues...)
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return uploadShareCreateBody{}, false
	}

	days := int64(30)
	if expiresPresent {
		days = *expiresInDays
	}
	return uploadShareCreateBody{
		Label:         label,
		ExpiresInDays: days,
		MaxUploads: uploadShareOptionalInt{
			Value:   maxUploads,
			Present: maxUploadsPresent,
		},
	}, true
}

func decodeUploadShareUpdateBody(w http.ResponseWriter, r *http.Request) (uploadShareUpdateBody, bool) {
	object, ok := decodeRequiredJSONObjectBody(w, r)
	if !ok {
		return uploadShareUpdateBody{}, false
	}

	issues := make([]zodValidationIssue, 0)
	label, labelIssues := decodeUploadShareLabel(object, true)
	issues = append(issues, labelIssues...)

	var isActive *bool
	if raw, exists := object["isActive"]; exists {
		if zodReceivedType(raw) != "boolean" {
			issues = append(issues, zodInvalidTypeIssue([]any{"isActive"}, "boolean", zodReceivedType(raw)))
		} else {
			var value bool
			if err := json.Unmarshal(raw, &value); err != nil {
				issues = append(issues, zodInvalidTypeIssue([]any{"isActive"}, "boolean", zodReceivedType(raw)))
			} else {
				isActive = &value
			}
		}
	}

	maxUploads, maxUploadsPresent, maxUploadsIssues := decodeUploadShareBoundedInt(
		object,
		"maxUploads",
		1,
		10000,
		true,
	)
	issues = append(issues, maxUploadsIssues...)
	if len(issues) > 0 {
		writeSettingZodValidationError(w, issues...)
		return uploadShareUpdateBody{}, false
	}

	return uploadShareUpdateBody{
		Label:    label,
		IsActive: isActive,
		MaxUploads: uploadShareOptionalInt{
			Value:   maxUploads,
			Present: maxUploadsPresent,
		},
	}, true
}

func decodeUploadShareLabel(
	object map[string]json.RawMessage,
	nullable bool,
) (uploadShareOptionalString, []zodValidationIssue) {
	raw, exists := object["label"]
	if !exists {
		return uploadShareOptionalString{}, nil
	}
	if rawJSONIsNull(raw) {
		if nullable {
			return uploadShareOptionalString{Present: true}, nil
		}
		return uploadShareOptionalString{Present: true}, []zodValidationIssue{
			zodInvalidTypeIssue([]any{"label"}, "string", "null"),
		}
	}
	if zodReceivedType(raw) != "string" {
		return uploadShareOptionalString{Present: true}, []zodValidationIssue{
			zodInvalidTypeIssue([]any{"label"}, "string", zodReceivedType(raw)),
		}
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return uploadShareOptionalString{Present: true}, []zodValidationIssue{
			zodInvalidTypeIssue([]any{"label"}, "string", zodReceivedType(raw)),
		}
	}
	value = jsTrimSpace(value)
	if jsStringLength(value) > 80 {
		return uploadShareOptionalString{Present: true}, []zodValidationIssue{
			zodTooBigStringIssue([]any{"label"}, 80),
		}
	}
	return uploadShareOptionalString{Value: &value, Present: true}, nil
}

func decodeUploadShareBoundedInt(
	object map[string]json.RawMessage,
	field string,
	minimum int64,
	maximum int64,
	nullable bool,
) (*int64, bool, []zodValidationIssue) {
	raw, exists := object[field]
	if !exists {
		return nil, false, nil
	}
	if rawJSONIsNull(raw) && nullable {
		return nil, true, nil
	}
	if zodReceivedType(raw) != "number" {
		return nil, true, []zodValidationIssue{
			zodInvalidTypeIssue([]any{field}, "number", zodReceivedType(raw)),
		}
	}
	parsed, err := strconv.ParseFloat(string(raw), 64)
	if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) ||
		math.Trunc(parsed) != parsed || math.Abs(parsed) > float64(maxSafeInteger) {
		return nil, true, []zodValidationIssue{zodInvalidIntIssue([]any{field})}
	}
	if parsed < float64(minimum) {
		return nil, true, []zodValidationIssue{zodTooSmallNumberIssue([]any{field}, int(minimum))}
	}
	if parsed > float64(maximum) {
		return nil, true, []zodValidationIssue{zodTooBigNumberIssue([]any{field}, int(maximum))}
	}
	value := int64(parsed)
	return &value, true, nil
}

func rawJSONIsNull(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "null"
}

func uploadShareNullableStringValue(field uploadShareOptionalString) any {
	if field.Value == nil || *field.Value == "" {
		return nil
	}
	return *field.Value
}

func uploadShareNullableIntValue(field uploadShareOptionalInt) any {
	if field.Value == nil {
		return nil
	}
	return *field.Value
}

// jsTrimSpace implements the ECMAScript WhiteSpace and LineTerminator set used
// by String.prototype.trim(). Go's unicode.IsSpace additionally treats U+0085
// as whitespace, which JavaScript intentionally preserves.
func jsTrimSpace(value string) string {
	return strings.TrimFunc(value, func(character rune) bool {
		switch character {
		case '\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020',
			'\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f',
			'\u3000', '\ufeff':
			return true
		default:
			return character >= '\u2000' && character <= '\u200a'
		}
	})
}

// uploadSharePathID mirrors Number(value) followed by Number.isInteger(value)
// and value > 0. IDs outside SQLite's signed-integer range are valid numbers
// to Node but can never identify a row, so queryable is false for that case.
func uploadSharePathID(value string) (id int64, valid bool, queryable bool) {
	parsed, ok := parseJavaScriptNumber(value)
	if !ok || math.IsInf(parsed, 0) || math.IsNaN(parsed) ||
		math.Trunc(parsed) != parsed || parsed <= 0 {
		return 0, false, false
	}
	if parsed >= 9223372036854775808.0 {
		return 0, true, false
	}
	return int64(parsed), true, true
}

func parseJavaScriptNumber(value string) (float64, bool) {
	trimmed := jsTrimSpace(value)
	if trimmed == "" {
		return 0, true
	}
	lower := strings.ToLower(trimmed)
	base := 0
	switch {
	case strings.HasPrefix(lower, "0x"):
		base = 16
	case strings.HasPrefix(lower, "0b"):
		base = 2
	case strings.HasPrefix(lower, "0o"):
		base = 8
	}
	if base != 0 {
		integer, ok := new(big.Int).SetString(trimmed[2:], base)
		if !ok {
			return 0, false
		}
		parsed, _ := new(big.Float).SetInt(integer).Float64()
		return parsed, true
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	return parsed, err == nil
}
