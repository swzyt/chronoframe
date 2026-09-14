package app

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
)

type exifReindexBody struct {
	Action   any
	PhotoID  any
	PhotoIDs any
}

func decodeExifReindexBody(w http.ResponseWriter, r *http.Request) (exifReindexBody, bool) {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	decoder.UseNumber()
	var root any
	if err := decodeSingleJSONValue(decoder, &root); err != nil {
		if errors.Is(err, io.EOF) {
			writeUnhandledRequestError(w)
		} else {
			writeInvalidJSONBody(w)
		}
		return exifReindexBody{}, false
	}
	if root == nil {
		writeUnhandledRequestError(w)
		return exifReindexBody{}, false
	}
	object, ok := root.(map[string]any)
	if !ok {
		return exifReindexBody{}, true
	}
	return exifReindexBody{
		Action: object["action"], PhotoID: object["photoId"], PhotoIDs: object["photoIds"],
	}, true
}

// sqliteBindingValue mirrors the values better-sqlite3 accepts as query
// bindings for JSON input. Booleans, arrays, and objects throw in Node.
func sqliteBindingValue(value any) (any, bool) {
	switch typed := value.(type) {
	case nil, string:
		return typed, true
	case json.Number:
		parsed, err := strconv.ParseFloat(string(typed), 64)
		if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) {
			return nil, false
		}
		return parsed, true
	default:
		return nil, false
	}
}

func exifReindexCandidateIDs(value any) ([]any, bool, bool) {
	values, ok := value.([]any)
	if !ok || len(values) == 0 {
		return nil, false, true
	}
	result := make([]any, 0, len(values))
	for _, value := range values {
		binding, valid := sqliteBindingValue(value)
		if !valid {
			return nil, true, false
		}
		result = append(result, binding)
	}
	return result, true, true
}
