package app

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

func decodePhotoReactionBody(w http.ResponseWriter, r *http.Request) (string, bool) {
	var raw json.RawMessage
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	decoder.UseNumber()
	if err := decodeSingleJSONValue(decoder, &raw); err != nil {
		if errors.Is(err, io.EOF) {
			writeUnhandledRequestError(w)
		} else {
			writeInvalidJSONBody(w)
		}
		return "", false
	}
	if rawJSONIsNull(raw) {
		writeUnhandledRequestError(w)
		return "", false
	}
	if zodReceivedType(raw) != "object" {
		return "", true
	}

	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		writeInvalidJSONBody(w)
		return "", false
	}
	reactionType, exists, valid := decodeJSONStringField(object, "reactionType")
	if !exists || !valid {
		return "", true
	}
	return reactionType, true
}
