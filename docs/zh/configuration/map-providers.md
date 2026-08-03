# 地图提供器

ChronoFrame 支持三种地图提供器，您可以根据需求选择合适的提供器。

| 提供器                | 支持 | 额外配置          | 特性                     |
| --------------------- | :--: | ----------------- | ------------------------ |
| [MapLibre](#maplibre) |  ✅  | MapTiler 访问令牌 | 免费开源，支持自定义样式 |
| [Mapbox](#mapbox)     |  ✅  | MapBox 访问令牌   | 免费用量，更好的渲染器   |
| [高德地图](#高德地图) |  ✅  | JS API Key 与安全密钥 | 适合中国大陆访问      |

地图提供器可在「后台 → 设置 → 地图与位置」中配置。

## 高德地图

访问者主要位于中国大陆时，推荐使用高德地图。

1. 在[高德开放平台](https://lbs.amap.com/)完成开发者认证。
2. 创建应用，并添加服务平台为「Web 端（JS API）」的 Key。
3. 为 Key 配置网站域名白名单。
4. 将 JS API Key 和对应安全密钥填写到 ChronoFrame。

ChronoFrame 始终以 WGS-84 保存照片原始坐标，仅在高德地图展示边界转换为 GCJ-02。因此切换地图提供器不会改写数据库坐标，也不会产生多次转换造成的累计偏移。

地球仪、照片小地图和位置选择器使用 JS API Key 与安全密钥。照片位置解析需要另外创建 Web 服务 Key，详见[位置提供器](./location-providers.md)。

## MapLibre

要使用 MapLibre 作为地图提供器，您需要一个 [MapTiler 访问令牌](https://cloud.maptiler.com/account/keys/)。

```bash
NUXT_PUBLIC_MAP_PROVIDER=maplibre
NUXT_PUBLIC_MAP_MAPLIBRE_TOKEN=your_maplibre_access_token
```

### 自定义样式

```bash
# ChronoFrame 已经内置了自动切换的浅色和深色两种样式
# 如果配置自定义样式，将会覆盖默认样式
# 示例: https://demotiles.maplibre.org/globe.json
NUXT_PUBLIC_MAP_MAPLIBRE_STYLE=
```

## MapBox

要使用 Mapbox 作为地图提供器，您需要一个 [Mapbox 访问令牌](https://console.mapbox.com/account/access-tokens/)。

```bash
NUXT_PUBLIC_MAP_PROVIDER=mapbox
NUXT_PUBLIC_MAPBOX_ACCESS_TOKEN=your_mapbox_access_token
```

### 自定义样式

```bash
# 如果配置自定义样式，将会覆盖默认样式
# 示例: mapbox://styles/mapbox/streets-v11
NUXT_PUBLIC_MAP_MAPBOX_STYLE=
```
