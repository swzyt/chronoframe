# Location Providers

Location providers convert photo GPS coordinates (latitude and longitude) into human-readable city or country names during photo processing. This process is called Reverse Geocoding.

By default, no configuration is required. ChronoFrame uses OpenStreetMap Nominatim as the default location provider.

However, you may need to configure a custom location provider in the following cases:

- Your server is located in mainland China
- The connection between your server and Nominatim is blocked

ChronoFrame supports Nominatim, Mapbox, and AMap. Select the provider in **Dashboard → Settings → Map & Location**.

## AMap Web Service

AMap reverse geocoding is recommended for mainland-China deployments.

1. Create a separate key in the AMap console.
2. Select **Web Service** as its platform.
3. Select AMap as the location provider in ChronoFrame.
4. Enter the Web Service key.

The Web Service key is stored as a server-side secret and is not returned to public clients. ChronoFrame converts the original WGS-84 EXIF coordinate to GCJ-02 only for the AMap request and stores the original coordinate unchanged.

## Nominatim

Nominatim is a free reverse geocoding service provided by OpenStreetMap. By default, ChronoFrame uses Nominatim as the location provider.

If your server cannot connect to the official Nominatim service, you can set up your own reverse proxy and use it through the following configuration:

```bash
NUXT_NOMINATIM_BASE_URL=http://your-nominatim-proxy-url/
```

## Mapbox Search API

Mapbox Search API provides powerful reverse geocoding capabilities. To use Mapbox as your location provider, you need a [Mapbox access token](https://console.mapbox.com/account/access-tokens/).

```bash
NUXT_MAPBOX_ACCESS_TOKEN=your-mapbox-access-token
```

When you configure the `NUXT_MAPBOX_ACCESS_TOKEN` environment variable, ChronoFrame will automatically use Mapbox Search API as the location provider.
