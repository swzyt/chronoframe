# Media, Storage, and Maps

ChronoFrame stores files in a configured backend, metadata in SQLite, and serves media through the application proxy. Clients should not rely on direct S3/OpenList/local storage links.

## Media pipeline

```mermaid
flowchart LR
  A["Upload request"] --> B["Create owner-bound job"]
  B --> C["Store original file"]
  C --> D["Process queue"]
  D --> E["Extract EXIF/GPS/video metadata"]
  E --> F["Generate thumbnails/playback assets"]
  F --> G["Serve through protected media proxy"]
```

## Storage providers

| Provider              | Best for                                     |
| --------------------- | -------------------------------------------- |
| Local filesystem      | Simple single-server deployments             |
| S3-compatible storage | Cloud object storage, Tencent COS, MinIO, R2 |
| OpenList              | Existing remote-drive integrations           |

For Tencent COS, use an endpoint like `https://cos.ap-guangzhou.myqcloud.com`, a bucket name including the AppID suffix, region such as `ap-guangzhou`, and keep path-style access disabled.

## Video and Live Photo

MP4/MOV files are supported. HEVC/H.265 inputs are processed into browser-friendly H.264 playback assets. Live Photos should be uploaded with both the image and paired MOV file preserved.

## Maps and reverse geocoding

Map rendering and reverse geocoding are separate settings.

| Capability        | Providers                     |
| ----------------- | ----------------------------- |
| Map rendering     | Mapbox, MapLibre, AMap        |
| Reverse geocoding | Auto, AMap, Mapbox, Nominatim |

For mainland China deployments, AMap is usually the most practical choice.
