# ChronoFrame Wiki Overview

This Wiki documents the current ChronoFrame fork, including features that are not available in the original upstream project: multi-user permissions, public access password preview limits, protected media delivery, MP4/MOV support, AMap integration, album ownership, and scheduled database backups.

## What ChronoFrame is

ChronoFrame is a self-hosted photo gallery for personal, family, or small community use. It provides:

- Web-based photo, video, Live Photo, and album management.
- Public gallery pages with optional access-password protection.
- Admin and regular-user roles with per-user content ownership.
- Local, S3-compatible, and OpenList storage backends.
- EXIF/GPS extraction, reverse geocoding, map, and globe views.
- SQLite-based deployment with Docker and scheduled backup emails.

## Main additions in this fork

| Area             | Capability                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| Users            | Admin-created users, password reset, enable/disable, promote/demote admins, user deletion with content transfer |
| Permissions      | Regular users only manage their own photos and albums; admins manage all data                                   |
| Public access    | Anonymous visitors can preview a limited number of photos and albums before entering an access password         |
| Media protection | Originals, thumbnails, videos, Live Photos, and downloads are served through the ChronoFrame auth proxy         |
| Video            | MP4/MOV upload with H.264 playback generation for HEVC/H.265 inputs                                             |
| Maps             | Mapbox, MapLibre, and AMap support; AMap/Mapbox/Nominatim reverse geocoding                                     |
| Albums           | Photo list shows album ownership; photos can be assigned to albums individually or in bulk                      |
| Backups          | Scheduled SQLite backup delivery through SMTP email                                                             |

## Access model

| Actor             | Allowed                                     | Restricted                                                  |
| ----------------- | ------------------------------------------- | ----------------------------------------------------------- |
| Anonymous visitor | Public pages and configured preview content | Admin dashboard, uploads, content beyond preview limit      |
| Regular user      | Dashboard, own photos, own albums           | Other users' data, settings, queue, logs, user management   |
| Admin             | Full site management                        | Cannot demote/disable/delete self or the last enabled admin |

Public gallery pages aggregate non-hidden content from all users. Hidden albums are only visible to their owner and admins.

## Important pages

| Page                    | Purpose                      |
| ----------------------- | ---------------------------- |
| `/`                     | Public gallery home          |
| `/albums`               | Public album list            |
| `/albums/:albumId`      | Public album detail          |
| `/:slug`                | Photo or video detail        |
| `/globe`                | Globe view                   |
| `/album-flow`           | Animated public photo wall   |
| `/access`               | Access password verification |
| `/signin`               | Login                        |
| `/dashboard`            | Dashboard                    |
| `/dashboard/photos`     | Photo management             |
| `/dashboard/albums`     | Album management             |
| `/dashboard/users`      | Admin-only user management   |
| `/dashboard/queue`      | Admin-only queue management  |
| `/dashboard/logs`       | Admin-only logs              |
| `/dashboard/settings/*` | Admin-only settings          |

## Recommended reading

1. [Deployment and upgrades](./deployment.md)
2. [Admin guide](./admin-guide.md)
3. [Visitor and user guide](./user-guide.md)
4. [Media, storage, and maps](./media-storage-map.md)
5. [Operations and troubleshooting](./operations.md)
6. [Developer reference](./development.md)
