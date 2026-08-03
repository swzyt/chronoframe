# Map Providers

ChronoFrame supports three map providers. You can choose the one that best fits your needs.

| Provider              | Supported | Extra Configuration   | Features                                     |
| --------------------- | :-------: | --------------------- | -------------------------------------------- |
| [MapLibre](#maplibre) |    ✅     | MapTiler Access Token | Free and open-source, supports custom styles |
| [Mapbox](#mapbox)     |    ✅     | Mapbox Access Token   | Free tier, better renderer performance       |
| [AMap](#amap)         |    ✅     | JS API Key + security code | Optimized for mainland China             |

Map providers are configured in **Dashboard → Settings → Map & Location**.

## AMap

AMap is recommended for deployments whose users are primarily in mainland China.

1. Complete developer verification in the [AMap Open Platform](https://lbs.amap.com/).
2. Create an application and add a **Web (JS API)** key.
3. Configure the key's domain allowlist.
4. Copy both the JS API Key and its security code into ChronoFrame.

ChronoFrame keeps photo coordinates as WGS-84 and converts them to GCJ-02 only at the AMap display boundary. Switching providers therefore does not rewrite or repeatedly offset stored GPS data.

The browser key and security code are required for the globe, photo mini maps, and location picker. Reverse geocoding uses a separate Web Service key described in [Location Providers](./location-providers.md).

## MapLibre

To use MapLibre as the map provider, you need a [MapTiler Access Token](https://cloud.maptiler.com/account/keys/).

```bash
NUXT_PUBLIC_MAP_PROVIDER=maplibre
NUXT_PUBLIC_MAP_MAPLIBRE_TOKEN=your_maplibre_access_token
```

### Custom Styles

```bash
# ChronoFrame comes with built-in light and dark styles that switch automatically.
# If you configure a custom style, it will override the default styles.
# Example: https://demotiles.maplibre.org/globe.json
NUXT_PUBLIC_MAP_MAPLIBRE_STYLE=
```

## Mapbox

To use Mapbox as the map provider, you will need a [Mapbox Access Token](https://console.mapbox.com/account/access-tokens/).

```bash
NUXT_PUBLIC_MAP_PROVIDER=mapbox
NUXT_PUBLIC_MAPBOX_ACCESS_TOKEN=your_mapbox_access_token
```

### Custom Styles

```bash
# If you configure a custom style, it will override the default styles.
# Example: mapbox://styles/mapbox/streets-v11
NUXT_PUBLIC_MAP_MAPBOX_STYLE=
```
