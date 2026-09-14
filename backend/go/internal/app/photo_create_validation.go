package app

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// photoCreateBody intentionally keeps the JSON values dynamic. The Node route
// predates schema validation and therefore exposes JavaScript truthiness and
// type-error behaviour as part of its HTTP contract.
type photoCreateBody struct {
	FileName           string
	ContentType        string
	ContentHash        string
	SkipDuplicateCheck bool
}

func decodePhotoCreateBody(w http.ResponseWriter, r *http.Request) (photoCreateBody, bool) {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	decoder.UseNumber()
	var root any
	if err := decodeSingleJSONValue(decoder, &root); err != nil {
		if !errors.Is(err, io.EOF) {
			writeInvalidJSONBody(w)
			return photoCreateBody{}, false
		}
		root = map[string]any{}
	}

	// `(await readBody(event)) || {}` replaces every falsey JSON root with an
	// empty object. Non-null primitives and arrays are boxed by JS destructuring
	// and simply have no matching named properties.
	if !jsonJavaScriptTruthy(root) {
		root = map[string]any{}
	}
	object, _ := root.(map[string]any)
	var fileNameValue, contentTypeValue, contentHashValue, skipDuplicateValue any
	if object != nil {
		fileNameValue = object["fileName"]
		contentTypeValue = object["contentType"]
		contentHashValue = object["contentHash"]
		skipDuplicateValue = object["skipDuplicateCheck"]
	}

	// normalizeContentHash calls String.prototype.trim through optional
	// chaining. null/undefined are accepted, but every other non-string value
	// throws before the route's try/catch.
	contentHash := ""
	if contentHashValue != nil {
		value, ok := contentHashValue.(string)
		if !ok {
			writeUnhandledRequestError(w)
			return photoCreateBody{}, false
		}
		contentHash = normalizeContentHash(value)
	}

	if !jsonJavaScriptTruthy(fileNameValue) {
		return photoCreateBody{ContentHash: contentHash}, true
	}
	fileName, ok := fileNameValue.(string)
	if !ok {
		writeUnhandledRequestError(w)
		return photoCreateBody{}, false
	}

	contentType := ""
	if contentTypeValue != nil {
		value, ok := contentTypeValue.(string)
		if !ok {
			// isVideoFile invokes contentType.toLowerCase() before entering the
			// route's error-mapping try block.
			writeUnhandledRequestError(w)
			return photoCreateBody{}, false
		}
		contentType = value
	}

	return photoCreateBody{
		FileName:           fileName,
		ContentType:        contentType,
		ContentHash:        contentHash,
		SkipDuplicateCheck: jsonJavaScriptTruthy(skipDuplicateValue),
	}, true
}
