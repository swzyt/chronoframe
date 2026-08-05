# Differences from Upstream

This repository is a fork of [HoshinoSuzumi/chronoframe](https://github.com/HoshinoSuzumi/chronoframe). It keeps the upstream self-hosted gallery experience, but the maintained fork at [swzyt/chronoframe](https://github.com/swzyt/chronoframe) has moved toward a multi-user, permission-aware, lower-cost deployment model.

The comparison below documents the current fork behavior. Upstream can evolve independently, so treat this page as a fork-specific reference rather than a permanent statement about upstream.

## Executive Summary

Compared with upstream, this fork mainly adds:

- Multi-user administration with administrator and regular-user roles.
- Per-user ownership for photos, albums, and processing jobs.
- Visitor preview limits plus an unlock password for public content.
- Application-level media authorization instead of exposing raw storage links.
- MP4/MOV video support, including browser-playable H.264 assets for HEVC/H.265 inputs.
- Mainland-China friendly map support through AMap/Gaode.
- Lower-cost media browsing through generated display images.
- Large-gallery performance optimizations for public queries, albums, globe, and dashboard photo management.
- Scheduled SQLite database backup by email.
- Production Docker image publishing to GHCR for both amd64 and arm64.

## Feature Comparison

| Area                    | Upstream                                              | This fork                                                                                                                                 |
| ----------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| User model              | Primarily a single-administrator gallery              | Multiple local users with administrator and regular-user roles                                                                            |
| User provisioning       | No complete administrator-managed local-user workflow | Administrators can create users, reset passwords, enable/disable accounts, promote/demote administrators, and delete users                |
| Public registration     | No public registration                                | Still no public registration; accounts are created by administrators                                                                      |
| Role updates            | Single-owner model                                    | Role and active-state changes are checked from the database during server authorization and take effect without requiring a new login     |
| Content ownership       | Content is effectively instance-wide                  | Photos, albums, and pipeline tasks have `ownerUserId`                                                                                     |
| Regular-user dashboard  | Not a main upstream flow                              | Regular users can access only dashboard, own photos, and own albums                                                                       |
| Admin dashboard         | Administrator-oriented                                | Administrators manage all users, all media, queues, logs, storage, and settings                                                           |
| Public gallery          | Public pages show public content                      | Public pages aggregate every user's non-hidden content                                                                                    |
| Hidden albums           | Upstream album visibility behavior                    | Hidden albums are visible only to owners and administrators                                                                               |
| Visitor access          | Password-gated public access flow                     | Visitors can preview configurable numbers of photos/albums before entering the access password                                            |
| Visitor credential      | Password validation                                   | Signed HttpOnly SameSite=Lax cookie valid for 30 days and invalidated by password-version changes                                         |
| Media delivery          | Storage URLs can be part of the normal flow           | Originals, thumbnails, display images, videos, Live Photos, downloads, and share previews go through ChronoFrame authorization routes     |
| Original image cost     | Detail pages can rely on originals                    | Detail/fullscreen flows prefer generated 2560px WebP display images; originals are preserved for explicit downloads                       |
| Storage backends        | Local/S3/OpenList support from upstream               | Hardened local/S3/OpenList behavior, Tencent COS-compatible S3 guidance, stream-based S3/local media reads, safer protected media routing |
| Video                   | Image and Live Photo focused                          | MP4/MOV uploads, metadata extraction, poster generation, H.264 playback generation for HEVC/H.265 inputs                                  |
| Photo ownership display | Not central                                           | Photo and album views expose owner information where useful                                                                               |
| Album assignment        | Album membership editing                              | Photo management shows all containing albums, supports per-photo album assignment and bulk album assignment                               |
| Public display modes    | Home, albums, photo details, globe                    | Adds `/album-flow`, an animated wall of currently visible public photos                                                                   |
| Photo detail viewer     | Upstream viewer behavior                              | Adds autoplay, rotation, fullscreen viewing, improved zoom/pan handling, and video-aware detail display                                   |
| Maps                    | Mapbox-oriented flow                                  | Adds MapLibre/AMap display options and AMap/Mapbox/Nominatim reverse-geocoding choices                                                    |
| Globe                   | Loads photo-location data in the normal public flow   | Uses lightweight map marker payloads, viewport filtering, and server-side low-zoom clustering                                             |
| Backups                 | Manual file/volume backup expected                    | Scheduled SQLite backup to email with compression, retention, and optional stream-encrypted attachment                                    |
| Docker image            | Upstream image/release flow                           | Fork publishes public `ghcr.io/swzyt/chronoframe:latest` multi-arch images automatically                                                  |
| Languages               | Upstream translations                                 | Fork-specific UI is localized in Simplified Chinese, Traditional Chinese (Taiwan/Hong Kong), English, Japanese, and Russian               |

## User and Permission Changes

The fork keeps `isAdmin` as the role flag and adds account enablement. User management is administrator-only.

Administrators can:

- Create local users.
- Reset passwords.
- Enable or disable accounts.
- Promote a regular user to administrator.
- Demote an administrator to a regular user.
- Delete regular users.
- View and manage every user's photos and albums.
- Access queue management, system logs, user management, storage settings, and system settings.

Regular users can:

- Sign in with email and password.
- View the dashboard.
- Upload and manage their own photos.
- Create and manage their own albums.
- See only their own data in dashboard photo and album lists.

Safety rules:

- An administrator cannot demote, disable, or delete their own account.
- The last enabled administrator cannot be demoted, disabled, or deleted.
- Administrator accounts must be demoted before deletion.
- Deleting a regular user transfers their photos, albums, and unfinished tasks to the administrator performing the deletion.
- Cross-user resource access by regular users returns `404` to reduce resource-existence disclosure.

## Data Ownership and Isolation

This fork adds `ownerUserId` to photos, albums, and asynchronous processing tasks.

- Historical content is assigned to the earliest administrator during migration.
- New uploads use user-scoped storage keys such as `users/<userId>/...`.
- Upload and processing jobs preserve the uploader's ownership.
- Regular users can only use their own photos in their own albums.
- Administrators can inspect and operate across users.
- Public pages still aggregate all users' non-hidden content.
- Owner metadata is returned in appropriate API responses and displayed in dashboard lists and content information areas.

## Visitor Preview and Access Password

When public access protection is enabled, anonymous visitors are not blocked immediately. They can preview:

- A configurable number of public photos, defaulting to 10.
- A configurable number of public albums, defaulting to 1.

If more content exists, public pages expose an unlock action. After a correct password:

- The server verifies the password and issues a signed HttpOnly cookie.
- The cookie is valid for 30 days.
- The cookie carries the access-password version, so password/config changes can invalidate old credentials.
- Signed-in users bypass the visitor access password.
- Failed verification is rate-limited to five attempts per source within 15 minutes.

The preview limit is enforced across public pages, public photo/album APIs, globe markers, album details, thumbnails, originals, Live Photo assets, and downloads.

## Media, Video, and Cost Optimizations

The fork routes media through ChronoFrame instead of relying on raw object URLs. This allows one access model for local storage, S3-compatible storage, Tencent COS, and OpenList.

Major media changes:

- Thumbnails and display images are generated during processing.
- Image detail, fullscreen viewing, and nearby preloading use the generated display image by default.
- Original images are preserved but protected more strictly and intended for explicit download/original workflows.
- S3 and local providers support stream and range-stream reads where possible, reducing memory pressure for large media.
- Media responses use caching, conditional requests, and range handling where appropriate.
- Share previews use application-owned Open Graph media routes rather than exposing raw storage keys.
- Histogram loading no longer adds a timestamp cache-buster, allowing thumbnail caching.

Video changes:

- MP4 uploads are accepted.
- MOV/Live Photo assets are supported.
- HEVC/H.265 video inputs can be processed into browser-friendly H.264 playback assets.
- Video metadata, duration, codecs, poster thumbnail, and playback key are stored.
- Video playback uses the same protected media layer as photos.

## Public Display and Viewer Changes

This fork adds and adjusts several public-facing experiences:

- `/album-flow` renders the currently visible public photo set as an animated flowing wall.
- Anonymous visitors only see the configured preview count until unlocked.
- Album detail pages also apply the preview photo limit before unlock.
- Photo detail supports autoplay-style navigation, fullscreen, rotation, improved zoom/pan behavior, and video-aware rendering.
- Album and photo information surfaces owner data where it helps understand content origin.

The standalone slideshow page was removed; automatic playback behavior is now part of the photo detail experience.

## Map and Location Changes

In addition to upstream map behavior, this fork adds mainland-China friendly map/location support:

- AMap/Gaode map display provider.
- AMap reverse-geocoding provider.
- Mapbox and Nominatim reverse-geocoding remain available.
- Map provider settings are available in onboarding and the admin settings UI.
- Location extraction still depends on GPS metadata being present in the uploaded source file.

The globe page was optimized for larger libraries:

- It uses `/api/photos/map` instead of loading full public photo payloads.
- The map API returns only marker fields needed by the globe.
- The API supports viewport bounds.
- Low zoom levels can return server-side grid clusters.
- Frontend clustering remains as a fallback/refinement.

## Performance Optimizations

The fork includes several optimizations aimed at larger galleries and cheaper object-storage usage.

### Query and API Optimizations

- Public photo queries exclude hidden-album photos using SQL `NOT EXISTS` instead of loading hidden IDs into Node.js memory.
- Public album preview limits are pushed into SQL instead of slicing after fetching all albums.
- Public access summary uses `COUNT(*)` for album/photo totals.
- Album list API avoids N+1 queries by fetching album-photo relations and preview photos in batches.
- Dashboard photo management supports server-side pagination, search, media-type filtering, and metadata-only pagination counts.
- Database indexes were added for storage keys, owner IDs, timestamps, album visibility, album-photo ordering, and GPS coordinates.

### Globe Optimizations

- Globe data loading uses lightweight markers.
- Viewport-aware requests reduce marker payload size after the map is loaded.
- Low-zoom server-side clustering avoids rendering and clustering too many points in the browser.
- EXIF sent to the globe is reduced to fields needed for map annotations.

### Media and Cost Optimizations

- Display images reduce repeated large-original delivery from COS/S3/CDN.
- Original media reads use stream/range APIs where possible.
- Thumbnail histogram requests can be cached.
- Protected media delivery avoids client exposure of private storage URLs.

### Docker/CI Optimizations

- GHCR image publishing is automated for pushes, tags, and manual runs.
- Images are built for `linux/amd64` and `linux/arm64`.
- The publish workflow was adjusted to make fork image delivery faster and reproducible.

## Bug Fixes and Hardening

This fork also contains a number of practical fixes discovered during local and container testing:

- Fixed untranslated authentication and settings strings introduced by fork-specific UI.
- Fixed access-password redirect cases, including returning from sign-in/home flows.
- Fixed anonymous preview state refresh issues where photos/albums could disappear or require a page refresh.
- Fixed album preview behavior so locked visitors only see the allowed number of album photos.
- Fixed owner display layout issues in album/photo lists.
- Fixed AMap provider label/localization and location-provider UI text.
- Fixed iPhone/Live Photo and GPS-related processing paths, including location display edge cases.
- Fixed protected image/share-preview issues so preview images use application-owned routes.
- Fixed image-original failures and histogram loading errors caused by cache and media-route behavior.
- Fixed temporary-directory assumptions in containers for video processing.
- Hardened container database/session/temp paths for production Docker runs.
- Hardened S3/Tencent COS media access and upload preparation paths.
- Fixed image detail fullscreen/zoom/rotation regressions in the local WebGL viewer package.
- Removed unused slideshow page and related entrance after moving playback behavior into photo detail.

## Backups and Operations

The fork adds scheduled database backup support:

- Configured from admin system settings.
- Creates a safe SQLite backup.
- Compresses the database.
- Optionally encrypts the backup attachment.
- Sends the backup by SMTP email.
- Applies local retention cleanup.

Recent backup hardening changed encrypted backup generation to a stream format (`CFDBENC2`) so large backups do not require reading the whole compressed database into memory.

For production, still back up the entire `/app/data` directory if using local media storage.

## Docker Deployment Differences

The fork publishes a public image:

```text
ghcr.io/swzyt/chronoframe:latest
```

The image includes runtime capabilities needed by the fork, including FFmpeg/FFprobe and ExifTool paths used by video and metadata processing.

Recommended Docker settings:

- Keep `NUXT_SESSION_PASSWORD` stable across restarts.
- Use `DATABASE_URL=/app/data/app.sqlite3`.
- Mount `/app/data` persistently.
- Keep `/tmp` writable for media processing.
- Keep external storage buckets private when relying on ChronoFrame authorization.

## Database and Upgrade Notes

This fork includes migrations that upstream does not know about, including ownership fields, media fields, video fields, display images, access-password settings, backup settings, and performance indexes.

Before upgrading:

1. Back up `data`, `.env`, Docker Compose files, and external storage configuration.
2. Verify at least one enabled administrator exists.
3. Start the new image and wait for migrations to finish.
4. Verify historical photos/albums have the expected owner.
5. Test administrator, regular-user, anonymous preview, unlock, upload, media, album, and globe flows.

Do not downgrade to upstream or to an older fork build without restoring a compatible backup.

## Syncing with Upstream

Upstream changes should be reviewed carefully when they touch:

- Authentication, sessions, middleware, or route guards.
- Photo, album, queue, storage, settings, or map APIs.
- Database schema or migrations.
- Media URL generation or storage object paths.
- Public gallery data loading.
- Viewer behavior.
- Video, Live Photo, EXIF, GPS, or reverse-geocoding pipelines.
- i18n files.
- Docker image or CI workflows.

After merging upstream changes, run at minimum:

```bash
pnpm lint
pnpm db:check
pnpm docs:build
pnpm build
```

Then validate in a production-like container with:

- Administrator login and full dashboard access.
- Regular-user login and ownership isolation.
- Anonymous preview before unlock.
- Password unlock and old-cookie invalidation after password change.
- Photo/video upload and queue processing.
- S3/COS/OpenList/local media loading.
- Album list/detail permissions.
- Globe and map provider behavior.
