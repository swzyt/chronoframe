package app

import (
	"net/url"
	"testing"
)

func TestNodeQueryStringMatchesH3ScalarAndArrayCoercion(t *testing.T) {
	query := url.Values{
		"single":   {"value"},
		"repeated": {"first", "second"},
		"empty":    {},
	}
	for _, test := range []struct {
		key  string
		want string
	}{
		{key: "single", want: "value"},
		{key: "repeated", want: "first,second"},
		{key: "empty", want: ""},
		{key: "missing", want: ""},
	} {
		if got := nodeQueryString(query, test.key); got != test.want {
			t.Fatalf("nodeQueryString(%q) = %q, want %q", test.key, got, test.want)
		}
	}
}

func TestNodeQueryHasDistinguishesMissingAndEmptyKeys(t *testing.T) {
	query := url.Values{"empty": {""}}
	if !nodeQueryHas(query, "empty") {
		t.Fatal("present empty query key should be detected")
	}
	if nodeQueryHas(query, "missing") {
		t.Fatal("missing query key should not be detected")
	}
}

func TestNodeQueryTruthyMatchesH3ScalarAndArrayValues(t *testing.T) {
	query := url.Values{
		"value":         {"0"},
		"empty":         {""},
		"repeated":      {"", ""},
		"repeatedMixed": {"", "value"},
		"emptySlice":    {},
	}
	for _, key := range []string{"value", "repeated", "repeatedMixed"} {
		if !nodeQueryTruthy(query, key) {
			t.Fatalf("nodeQueryTruthy(%q) = false, want true", key)
		}
	}
	for _, key := range []string{"empty", "emptySlice", "missing"} {
		if nodeQueryTruthy(query, key) {
			t.Fatalf("nodeQueryTruthy(%q) = true, want false", key)
		}
	}
}

func TestNodeQueryIsArrayMatchesH3RepeatedKeyRepresentation(t *testing.T) {
	query := url.Values{
		"single":   {"value"},
		"repeated": {"first", "second"},
		"empty":    {},
	}
	if nodeQueryIsArray(query, "single") {
		t.Fatal("single query value should remain a scalar")
	}
	if !nodeQueryIsArray(query, "repeated") {
		t.Fatal("repeated query values should be represented as an array")
	}
	if nodeQueryIsArray(query, "empty") || nodeQueryIsArray(query, "missing") {
		t.Fatal("empty or missing query values should not be represented as arrays")
	}
}

func TestRepeatedInitialLogLinesFallsBackLikeNodeNumberCoercion(t *testing.T) {
	query := url.Values{"initial": {"0", "all"}}
	if got := parseInitialLogLines(query); got != defaultInitialLogLines {
		t.Fatalf("repeated initial lines = %d, want default %d", got, defaultInitialLogLines)
	}
}

func TestInitialLogLinesMatchesNodeNumberCoercion(t *testing.T) {
	for _, test := range []struct {
		name  string
		query url.Values
		want  int
	}{
		{name: "missing", query: url.Values{}, want: defaultInitialLogLines},
		{name: "empty", query: url.Values{"initial": {""}}, want: 0},
		{name: "all", query: url.Values{"initial": {"ALL"}}, want: -1},
		{name: "spaced all", query: url.Values{"initial": {" all "}}, want: defaultInitialLogLines},
		{name: "hex", query: url.Values{"initial": {"0x10"}}, want: 16},
		{name: "decimal floor", query: url.Values{"initial": {"2.9"}}, want: 2},
		{name: "exponent", query: url.Values{"initial": {"1e2"}}, want: 100},
		{name: "negative", query: url.Values{"initial": {"-2"}}, want: 0},
		{name: "maximum", query: url.Values{"initial": {"3000"}}, want: maxInitialLogLines},
		{name: "infinity", query: url.Values{"initial": {"Infinity"}}, want: defaultInitialLogLines},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := parseInitialLogLines(test.query); got != test.want {
				t.Fatalf("parseInitialLogLines(%v) = %d, want %d", test.query, got, test.want)
			}
		})
	}
}
