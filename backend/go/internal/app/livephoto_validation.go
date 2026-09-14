package app

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"

	"github.com/swzyt/chronoframe/backend/go/internal/platform/httpx"
)

type livePhotoManageBody struct {
	Action   any
	PhotoID  any
	VideoKey any
	PhotoIDs any
}

func decodeLivePhotoManageBody(w http.ResponseWriter, r *http.Request) (livePhotoManageBody, bool) {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	decoder.UseNumber()
	var root any
	if err := decodeSingleJSONValue(decoder, &root); err != nil {
		if errors.Is(err, io.EOF) {
			writeUnhandledRequestError(w)
		} else {
			writeInvalidJSONBody(w)
		}
		return livePhotoManageBody{}, false
	}
	if root == nil {
		writeUnhandledRequestError(w)
		return livePhotoManageBody{}, false
	}
	object, ok := root.(map[string]any)
	if !ok {
		// JavaScript object destructuring boxes non-null primitive/array roots;
		// every named property is therefore undefined rather than a parse error.
		return livePhotoManageBody{}, true
	}
	return livePhotoManageBody{
		Action: object["action"], PhotoID: object["photoId"],
		VideoKey: object["videoKey"], PhotoIDs: object["photoIds"],
	}, true
}

func jsonJavaScriptTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case json.Number:
		parsed, err := strconv.ParseFloat(string(typed), 64)
		return err != nil || math.IsInf(parsed, 0) || parsed != 0
	case float64:
		return !math.IsNaN(typed) && typed != 0
	default:
		// Arrays and objects are truthy in JavaScript even when empty.
		return true
	}
}

func livePhotoCandidateIDs(value any) ([]any, bool) {
	values, ok := value.([]any)
	if !ok || len(values) == 0 {
		return nil, true
	}
	result := make([]any, 0, len(values))
	for _, value := range values {
		switch typed := value.(type) {
		case nil, string:
			result = append(result, typed)
		case json.Number:
			parsed, err := strconv.ParseFloat(string(typed), 64)
			if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) {
				return nil, false
			}
			result = append(result, parsed)
		default:
			// better-sqlite3 rejects booleans, arrays, and objects as bindings;
			// the Node route maps that failure to its outer 500 response.
			return nil, false
		}
	}
	return result, true
}

func writeLivePhotoInvalidAction(w http.ResponseWriter) {
	httpx.Error(w, http.StatusBadRequest, `Invalid action. Use "scan", "detect", "process", or "update-photo"`)
}

func writeLivePhotoManagementError(w http.ResponseWriter) {
	httpx.Error(w, http.StatusInternalServerError, "Failed to process LivePhoto management request")
}
