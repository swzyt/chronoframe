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

type photoUpdateLocation struct {
	Latitude  float64
	Longitude float64
}

type photoUpdateOptionalLocation struct {
	Value   *photoUpdateLocation
	Present bool
}

type photoUpdateOptionalRating struct {
	Value   *int64
	Present bool
}

type photoUpdateBody struct {
	Title       *string
	Description *string
	Tags        *[]string
	Location    photoUpdateOptionalLocation
	Rating      photoUpdateOptionalRating
}

func decodePhotoUpdateBody(w http.ResponseWriter, r *http.Request) (photoUpdateBody, bool) {
	var raw json.RawMessage
	decoder := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	decoder.UseNumber()
	if err := decodeSingleJSONValue(decoder, &raw); err != nil {
		if errors.Is(err, io.EOF) {
			writeUnhandledRequestError(w)
		} else {
			writeInvalidJSONBody(w)
		}
		return photoUpdateBody{}, false
	}
	if zodReceivedType(raw) != "object" {
		writeUnhandledRequestError(w)
		return photoUpdateBody{}, false
	}

	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		writeUnhandledRequestError(w)
		return photoUpdateBody{}, false
	}
	body := photoUpdateBody{}
	valid := true
	body.Title, valid = decodePhotoUpdateText(object, "title", 512, valid)
	body.Description, valid = decodePhotoUpdateText(object, "description", 2000, valid)
	body.Tags, valid = decodePhotoUpdateTags(object, valid)
	body.Location, valid = decodePhotoUpdateLocation(object, valid)
	body.Rating, valid = decodePhotoUpdateRating(object, valid)
	if !valid {
		writeUnhandledRequestError(w)
		return photoUpdateBody{}, false
	}
	return body, true
}

func decodePhotoUpdateText(
	object map[string]json.RawMessage,
	field string,
	maximum int,
	valid bool,
) (*string, bool) {
	raw, exists := object[field]
	if !exists {
		return nil, valid
	}
	if zodReceivedType(raw) != "string" {
		return nil, false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false
	}
	value = jsTrimSpace(value)
	if jsStringLength(value) > maximum {
		return nil, false
	}
	return &value, valid
}

func decodePhotoUpdateTags(
	object map[string]json.RawMessage,
	valid bool,
) (*[]string, bool) {
	raw, exists := object["tags"]
	if !exists {
		return nil, valid
	}
	if zodReceivedType(raw) != "array" {
		return nil, false
	}
	var rawTags []json.RawMessage
	if err := json.Unmarshal(raw, &rawTags); err != nil || len(rawTags) > 64 {
		return nil, false
	}
	tags := make([]string, 0, len(rawTags))
	for _, rawTag := range rawTags {
		if zodReceivedType(rawTag) != "string" {
			valid = false
			continue
		}
		var tag string
		if err := json.Unmarshal(rawTag, &tag); err != nil {
			valid = false
			continue
		}
		tag = jsTrimSpace(tag)
		if jsStringLength(tag) > 128 {
			valid = false
		}
		tags = append(tags, tag)
	}
	return &tags, valid
}

func decodePhotoUpdateLocation(
	object map[string]json.RawMessage,
	valid bool,
) (photoUpdateOptionalLocation, bool) {
	raw, exists := object["location"]
	if !exists {
		return photoUpdateOptionalLocation{}, valid
	}
	result := photoUpdateOptionalLocation{Present: true}
	if rawJSONIsNull(raw) {
		return result, valid
	}
	if zodReceivedType(raw) != "object" {
		return result, false
	}
	var location map[string]json.RawMessage
	if err := json.Unmarshal(raw, &location); err != nil {
		return result, false
	}
	latitude, latitudeOK := decodePhotoUpdateNumber(location["latitude"], -90, 90)
	longitude, longitudeOK := decodePhotoUpdateNumber(location["longitude"], -180, 180)
	if !latitudeOK || !longitudeOK {
		return result, false
	}
	result.Value = &photoUpdateLocation{Latitude: latitude, Longitude: longitude}
	return result, valid
}

func decodePhotoUpdateNumber(raw json.RawMessage, minimum float64, maximum float64) (float64, bool) {
	if zodReceivedType(raw) != "number" {
		return 0, false
	}
	value, err := strconv.ParseFloat(string(raw), 64)
	if err != nil || math.IsInf(value, 0) || math.IsNaN(value) || value < minimum || value > maximum {
		return 0, false
	}
	return value, true
}

func decodePhotoUpdateRating(
	object map[string]json.RawMessage,
	valid bool,
) (photoUpdateOptionalRating, bool) {
	raw, exists := object["rating"]
	if !exists {
		return photoUpdateOptionalRating{}, valid
	}
	result := photoUpdateOptionalRating{Present: true}
	if rawJSONIsNull(raw) {
		return result, valid
	}
	if zodReceivedType(raw) != "number" {
		return result, false
	}
	value, err := strconv.ParseFloat(string(raw), 64)
	if err != nil || math.IsInf(value, 0) || math.IsNaN(value) ||
		math.Trunc(value) != value || math.Abs(value) > float64(maxSafeInteger) ||
		value < 0 || value > 5 {
		return result, false
	}
	rating := int64(value)
	result.Value = &rating
	return result, valid
}

func writeUnhandledRequestError(w http.ResponseWriter) {
	httpx.Error(w, http.StatusInternalServerError, "Server Error")
}
