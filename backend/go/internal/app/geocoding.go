package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const defaultLocationLanguage = "zh-Hans"

type locationInfo struct {
	Latitude     float64
	Longitude    float64
	Country      string
	City         string
	LocationName string
}

type geocodingProvider interface {
	ReverseGeocode(context.Context, float64, float64) (*locationInfo, error)
}

type nominatimGeocodingProvider struct {
	application *Application
	baseURL     string
	client      *http.Client
}

type mapboxGeocodingProvider struct {
	application *Application
	accessToken string
	client      *http.Client
}

type amapGeocodingProvider struct {
	webServiceKey string
	client        *http.Client
}

func (a *Application) extractLocationFromGPS(ctx context.Context, latitude float64, longitude float64) *locationInfo {
	if latitude == 0 || longitude == 0 {
		return nil
	}
	if math.Abs(latitude) > 90 || math.Abs(longitude) > 180 {
		if a.logger != nil {
			a.logger.WarnContext(ctx, "Invalid GPS coordinates", "latitude", latitude, "longitude", longitude)
		}
		return nil
	}

	provider, err := a.createGeocodingProvider(ctx)
	if err != nil {
		if a.logger != nil {
			a.logger.ErrorContext(ctx, "Location geocoding provider unavailable", "error", err)
		}
		return nil
	}
	location, err := provider.ReverseGeocode(ctx, latitude, longitude)
	if err != nil {
		if a.logger != nil {
			a.logger.ErrorContext(ctx, "Location extraction failed", "error", err)
		}
		return nil
	}
	return location
}

func (a *Application) createGeocodingProvider(ctx context.Context) (geocodingProvider, error) {
	provider := strings.ToLower(strings.TrimSpace(a.settingString(ctx, "location", "provider")))
	if provider == "" {
		provider = "auto"
	}
	mapboxToken := a.settingString(ctx, "location", "mapbox.token")
	amapKey := a.settingString(ctx, "location", "amap.webServiceKey")
	nominatimBaseURL := a.settingString(ctx, "location", "nominatim.baseUrl")

	client := &http.Client{}
	switch provider {
	case "amap":
		if strings.TrimSpace(amapKey) == "" {
			return nil, errors.New("AMap Web Service key is required")
		}
		return &amapGeocodingProvider{webServiceKey: amapKey, client: client}, nil
	case "mapbox":
		if strings.TrimSpace(mapboxToken) == "" {
			return nil, errors.New("Mapbox token is required")
		}
		return &mapboxGeocodingProvider{application: a, accessToken: mapboxToken, client: client}, nil
	case "nominatim":
		return &nominatimGeocodingProvider{application: a, baseURL: nominatimBaseURL, client: client}, nil
	default:
		if strings.TrimSpace(mapboxToken) != "" {
			return &mapboxGeocodingProvider{application: a, accessToken: mapboxToken, client: client}, nil
		}
		return &nominatimGeocodingProvider{application: a, baseURL: nominatimBaseURL, client: client}, nil
	}
}

func (provider *nominatimGeocodingProvider) ReverseGeocode(
	ctx context.Context,
	latitude float64,
	longitude float64,
) (*locationInfo, error) {
	baseURL := strings.TrimSpace(provider.baseURL)
	if baseURL == "" {
		baseURL = "https://nominatim.openstreetmap.org"
	}
	parsedBaseURL, err := url.Parse(baseURL)
	if err != nil {
		return nil, err
	}
	requestURL := parsedBaseURL.ResolveReference(&url.URL{Path: "/reverse"})
	language := normalizeLocationLanguage(provider.application.settingString(ctx, "location", "language"))
	query := requestURL.Query()
	query.Set("lat", formatGeocodingFloat(latitude))
	query.Set("lon", formatGeocodingFloat(longitude))
	query.Set("format", "json")
	query.Set("addressdetails", "1")
	query.Set("accept-language", language+",zh-CN,en")
	requestURL.RawQuery = query.Encode()

	var response struct {
		Error       string         `json:"error"`
		DisplayName string         `json:"display_name"`
		Address     map[string]any `json:"address"`
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "chronoframe/1.0")
	if err := geocodingJSON(provider.client, request, 15*time.Second, &response); err != nil {
		return nil, err
	}
	if strings.TrimSpace(response.Error) != "" {
		return nil, fmt.Errorf("Nominatim API returned error: %s", response.Error)
	}
	address := response.Address
	country := firstStringFromMap(address, "country")
	if country == "" {
		country = strings.ToUpper(firstStringFromMap(address, "country_code"))
	}
	city := firstStringFromMap(address, "district", "city", "town", "county", "state", "village", "hamlet")
	return &locationInfo{
		Latitude:     latitude,
		Longitude:    longitude,
		Country:      country,
		City:         city,
		LocationName: strings.TrimSpace(response.DisplayName),
	}, nil
}

func (provider *mapboxGeocodingProvider) ReverseGeocode(
	ctx context.Context,
	latitude float64,
	longitude float64,
) (*locationInfo, error) {
	requestURL, err := url.Parse("https://api.mapbox.com/search/geocode/v6/reverse")
	if err != nil {
		return nil, err
	}
	language := toMapboxLanguage(provider.application.settingString(ctx, "location", "language"))
	query := requestURL.Query()
	query.Set("access_token", provider.accessToken)
	query.Set("longitude", formatGeocodingFloat(longitude))
	query.Set("latitude", formatGeocodingFloat(latitude))
	query.Set("types", "address,place,district,region,country")
	query.Set("language", language)
	requestURL.RawQuery = query.Encode()

	var response struct {
		Features []struct {
			Properties struct {
				Name           string `json:"name"`
				PlaceFormatted string `json:"place_formatted"`
				Context        map[string]struct {
					Name string `json:"name"`
				} `json:"context"`
			} `json:"properties"`
		} `json:"features"`
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return nil, err
	}
	if err := geocodingJSON(provider.client, request, 10*time.Second, &response); err != nil {
		return nil, err
	}
	if len(response.Features) == 0 {
		return nil, nil
	}
	properties := response.Features[0].Properties
	contextValue := properties.Context
	country := geocodingContextName(contextValue, "country")
	city := geocodingContextName(contextValue, "locality", "place", "district", "region")
	locationName := strings.TrimSpace(properties.PlaceFormatted)
	if locationName == "" {
		locationName = strings.TrimSpace(properties.Name)
	}
	return &locationInfo{
		Latitude:     latitude,
		Longitude:    longitude,
		Country:      country,
		City:         city,
		LocationName: locationName,
	}, nil
}

func (provider *amapGeocodingProvider) ReverseGeocode(
	ctx context.Context,
	latitude float64,
	longitude float64,
) (*locationInfo, error) {
	gcjLongitude, gcjLatitude := wgs84ToGCJ02(longitude, latitude)
	requestURL, err := url.Parse("https://restapi.amap.com/v3/geocode/regeo")
	if err != nil {
		return nil, err
	}
	query := requestURL.Query()
	query.Set("key", provider.webServiceKey)
	query.Set("location", formatGeocodingFloat(gcjLongitude)+","+formatGeocodingFloat(gcjLatitude))
	query.Set("extensions", "base")
	query.Set("output", "JSON")
	requestURL.RawQuery = query.Encode()

	var response struct {
		Status    string `json:"status"`
		InfoCode  string `json:"infocode"`
		Info      string `json:"info"`
		Regeocode *struct {
			FormattedAddress string         `json:"formatted_address"`
			AddressComponent map[string]any `json:"addressComponent"`
		} `json:"regeocode"`
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return nil, err
	}
	if err := geocodingJSON(provider.client, request, 10*time.Second, &response); err != nil {
		return nil, err
	}
	if response.Status != "1" || response.Regeocode == nil {
		if response.InfoCode == "" {
			response.InfoCode = "unknown"
		}
		return nil, fmt.Errorf("AMap API error: %s %s", response.InfoCode, response.Info)
	}
	address := response.Regeocode.AddressComponent
	city := ""
	if _, cityIsArray := address["city"].([]any); cityIsArray {
		city = firstStringFromMap(address, "province")
	} else {
		city = firstStringFromMap(address, "city")
	}
	if city == "" {
		city = firstStringFromMap(address, "district", "province")
	}
	return &locationInfo{
		Latitude:     latitude,
		Longitude:    longitude,
		Country:      firstStringFromMap(address, "country"),
		City:         city,
		LocationName: strings.TrimSpace(response.Regeocode.FormattedAddress),
	}, nil
}

func geocodingJSON(client *http.Client, request *http.Request, timeout time.Duration, target any) error {
	if client == nil {
		client = http.DefaultClient
	}
	ctx, cancel := context.WithTimeout(request.Context(), timeout)
	defer cancel()
	response, err := client.Do(request.WithContext(ctx))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("geocoding API error: %d %s", response.StatusCode, response.Status)
	}
	decoder := json.NewDecoder(response.Body)
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return nil
}

func normalizeLocationLanguage(language string) string {
	switch strings.TrimSpace(language) {
	case "zh", "zh-CN":
		return "zh-Hans"
	case "zh-TW":
		return "zh-Hant-TW"
	case "zh-HK":
		return "zh-Hant-HK"
	case "":
		return defaultLocationLanguage
	default:
		return strings.TrimSpace(language)
	}
}

func toMapboxLanguage(language string) string {
	normalized := normalizeLocationLanguage(language)
	switch normalized {
	case "zh-Hant-TW", "zh-Hant-HK":
		return "zh-Hant"
	default:
		return normalized
	}
}

func geocodingContextName(contextValue map[string]struct {
	Name string `json:"name"`
}, keys ...string) string {
	for _, key := range keys {
		value, ok := contextValue[key]
		if ok && strings.TrimSpace(value.Name) != "" {
			return strings.TrimSpace(value.Name)
		}
	}
	return ""
}

func firstStringFromMap(values map[string]any, keys ...string) string {
	for _, key := range keys {
		switch value := values[key].(type) {
		case string:
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				return trimmed
			}
		case []any:
			for _, item := range value {
				if trimmed := strings.TrimSpace(fmt.Sprint(item)); trimmed != "" {
					return trimmed
				}
			}
		case json.Number:
			if trimmed := strings.TrimSpace(value.String()); trimmed != "" {
				return trimmed
			}
		default:
			if value != nil {
				if trimmed := strings.TrimSpace(fmt.Sprint(value)); trimmed != "" {
					return trimmed
				}
			}
		}
	}
	return ""
}

func formatGeocodingFloat(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func wgs84ToGCJ02(longitude float64, latitude float64) (float64, float64) {
	if longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271 {
		return longitude, latitude
	}
	const earthRadius = 6378245.0
	const eccentricity = 0.006693421622965943
	deltaLatitude := transformGCJLatitude(longitude-105, latitude-35)
	deltaLongitude := transformGCJLongitude(longitude-105, latitude-35)
	radianLatitude := latitude / 180 * math.Pi
	magic := math.Sin(radianLatitude)
	magic = 1 - eccentricity*magic*magic
	sqrtMagic := math.Sqrt(magic)
	deltaLatitude = (deltaLatitude * 180) / (((earthRadius * (1 - eccentricity)) / (magic * sqrtMagic)) * math.Pi)
	deltaLongitude = (deltaLongitude * 180) / ((earthRadius / sqrtMagic) * math.Cos(radianLatitude) * math.Pi)
	return longitude + deltaLongitude, latitude + deltaLatitude
}

func transformGCJLatitude(x float64, y float64) float64 {
	value := -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*math.Sqrt(math.Abs(x))
	value += (20*math.Sin(6*x*math.Pi) + 20*math.Sin(2*x*math.Pi)) * 2 / 3
	value += (20*math.Sin(y*math.Pi) + 40*math.Sin((y/3)*math.Pi)) * 2 / 3
	value += (160*math.Sin((y/12)*math.Pi) + 320*math.Sin((y*math.Pi)/30)) * 2 / 3
	return value
}

func transformGCJLongitude(x float64, y float64) float64 {
	value := 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*math.Sqrt(math.Abs(x))
	value += (20*math.Sin(6*x*math.Pi) + 20*math.Sin(2*x*math.Pi)) * 2 / 3
	value += (20*math.Sin(x*math.Pi) + 40*math.Sin((x/3)*math.Pi)) * 2 / 3
	value += (150*math.Sin((x/12)*math.Pi) + 300*math.Sin((x/30)*math.Pi)) * 2 / 3
	return value
}
