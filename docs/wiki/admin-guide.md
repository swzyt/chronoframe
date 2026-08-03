# Admin Guide

Admins can manage users, photos, albums, settings, queue jobs, logs, and all user-owned content.

## Users

Admin-only page: `/dashboard/users`

Admins can:

- Create regular users.
- Reset passwords.
- Enable or disable users.
- Promote regular users to admins.
- Demote admins to regular users.
- Delete regular users.

Safety rules:

- Admins cannot demote, disable, or delete themselves.
- The last enabled admin cannot be demoted, disabled, or deleted.
- Admin users must be demoted before deletion.
- Deleting a regular user transfers their photos, albums, and unfinished jobs to the acting admin.

## Photos

Admin page: `/dashboard/photos`

The photo list shows ownership and album membership. Admins can edit photos, delete photos, assign one photo to albums, or bulk-assign selected photos to albums.

Regular users only see and manage their own photos.

## Albums

Admin page: `/dashboard/albums`

Albums can be created, edited, hidden, deleted, and populated with photos. Album edit supports filtering photos that do not belong to any album.

Hidden albums are not shown in the public album list and are visible only to their owner and admins.

## Access password

Admin page: settings → general/basic settings.

When public access protection is enabled:

- Anonymous visitors can preview the configured number of photos and albums.
- Visitors must enter the access password to view more.
- Successful verification creates a signed, HttpOnly, SameSite=Lax cookie valid for 30 days.
- Logged-in users bypass the public access password.
- Changing the password invalidates old access cookies.

## Queue and logs

Uploads create queue jobs for EXIF extraction, thumbnail generation, reverse geocoding, Live Photo matching, and video processing. If media appears broken, check `/dashboard/queue` and `/dashboard/logs` first.
