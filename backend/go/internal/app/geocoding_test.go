package app

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestMapboxGeocodingProviderParsesNodeCompatibleFields(t *testing.T) {
	provider := &mapboxGeocodingProvider{
		application: &Application{},
		accessToken: "pk.test",
		client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.URL.Path != "/search/geocode/v6/reverse" {
				t.Fatalf("path = %q", request.URL.Path)
			}
			query := request.URL.Query()
			if query.Get("access_token") != "pk.test" {
				t.Fatalf("access_token = %q", query.Get("access_token"))
			}
			if query.Get("latitude") != "31.2304" || query.Get("longitude") != "121.4737" {
				t.Fatalf("coordinates = %q,%q", query.Get("latitude"), query.Get("longitude"))
			}
			if query.Get("types") != "address,place,district,region,country" {
				t.Fatalf("types = %q", query.Get("types"))
			}
			if query.Get("language") != "zh-Hans" {
				t.Fatalf("language = %q", query.Get("language"))
			}
			return jsonHTTPResponse(`{
				"features": [
					{
						"properties": {
							"name": "Feature Name",
							"place_formatted": "Formatted Place",
							"context": {
								"country": {"name": "China"},
								"locality": {"name": "Pudong"},
								"place": {"name": "Shanghai"}
							}
						}
					}
				]
			}`), nil
		})},
	}

	location, err := provider.ReverseGeocode(t.Context(), 31.2304, 121.4737)
	if err != nil {
		t.Fatal(err)
	}
	if location == nil || location.Country != "China" || location.City != "Pudong" || location.LocationName != "Formatted Place" {
		t.Fatalf("location = %#v", location)
	}
}

func TestAMapGeocodingProviderParsesCityArrayAsProvince(t *testing.T) {
	provider := &amapGeocodingProvider{
		webServiceKey: "amap-key",
		client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.URL.Path != "/v3/geocode/regeo" {
				t.Fatalf("path = %q", request.URL.Path)
			}
			query := request.URL.Query()
			if query.Get("key") != "amap-key" {
				t.Fatalf("key = %q", query.Get("key"))
			}
			if query.Get("extensions") != "base" || query.Get("output") != "JSON" {
				t.Fatalf("query = %s", request.URL.RawQuery)
			}
			if query.Get("location") != "170.5028,-45.8788" {
				t.Fatalf("location = %q", query.Get("location"))
			}
			return jsonHTTPResponse(`{
				"status": "1",
				"regeocode": {
					"formatted_address": "Auckland Region Test",
					"addressComponent": {
						"country": "New Zealand",
						"province": "Auckland",
						"city": []
					}
				}
			}`), nil
		})},
	}

	location, err := provider.ReverseGeocode(t.Context(), -45.8788, 170.5028)
	if err != nil {
		t.Fatal(err)
	}
	if location == nil || location.Country != "New Zealand" || location.City != "Auckland" || location.LocationName != "Auckland Region Test" {
		t.Fatalf("location = %#v", location)
	}
}

func jsonHTTPResponse(body string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Status:     "200 OK",
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}
