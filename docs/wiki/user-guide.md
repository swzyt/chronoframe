# Visitor and User Guide

## Anonymous visitors

Anonymous visitors can browse public pages:

- `/`
- `/albums`
- `/albums/:albumId`
- `/:slug`
- `/globe`
- `/album-flow`

If access protection is enabled, visitors can only preview the configured number of public photos and albums before entering the access password.

## Regular users

Regular users are created by admins. Public registration is not supported.

After login, regular users can:

- View the dashboard.
- Upload photos, videos, and Live Photos.
- Manage their own photos.
- Create and manage their own albums.
- Browse public pages without entering the access password.

Regular users cannot access system settings, queue management, logs, user management, or other users' private dashboard data.

## Uploads

Supported files include JPEG, PNG, WebP, GIF, BMP, TIFF, HEIC, HEIF, MP4, and MOV. ChronoFrame extracts EXIF/GPS metadata, generates thumbnails, processes Live Photos, and creates H.264 playback assets for HEVC/H.265 videos when needed.

Large video uploads can take longer to finish. If thumbnails or GPS data are not visible immediately, wait for queue processing or ask an admin to check failed jobs.
