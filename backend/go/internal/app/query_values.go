package app

import (
	"net/url"
	"strings"
)

// nodeQueryString mirrors h3 getQuery values when handlers coerce them with
// String(...). A repeated query key is represented as an array by h3, and a
// JavaScript array stringifies by joining its entries with commas.
func nodeQueryString(query url.Values, key string) string {
	values, exists := query[key]
	if !exists || len(values) == 0 {
		return ""
	}
	return strings.Join(values, ",")
}

func nodeQueryHas(query url.Values, key string) bool {
	_, exists := query[key]
	return exists
}

// nodeQueryTruthy mirrors JavaScript truthiness for the scalar-or-array values
// returned by h3 getQuery. A repeated key is always a truthy array, including
// when every entry is an empty string.
func nodeQueryTruthy(query url.Values, key string) bool {
	values, exists := query[key]
	if !exists || len(values) == 0 {
		return false
	}
	if len(values) > 1 {
		return true
	}
	return values[0] != ""
}

// nodeQueryIsArray reports whether h3 getQuery would expose the value as an
// array. Zod string schemas reject that representation instead of coercing it.
func nodeQueryIsArray(query url.Values, key string) bool {
	return len(query[key]) > 1
}
