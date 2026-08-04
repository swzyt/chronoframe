# Differences from Upstream

This repository is a fork of [HoshinoSuzumi/chronoframe](https://github.com/HoshinoSuzumi/chronoframe). It preserves the upstream gallery experience while adding multi-user operation, stricter authorization, and controlled public access.

The comparison below describes the fork-specific behavior currently maintained in [swzyt/chronoframe](https://github.com/swzyt/chronoframe). Upstream may evolve independently, so always review both repositories before upgrading or merging upstream changes.

## Feature Comparison

| Area                    | Upstream                                                | This fork                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User model              | Primarily a single administrator                        | Multiple local users with administrator and regular-user roles                                                                                                                          |
| User provisioning       | No administrator-managed local-user workflow            | Administrators can create users, reset passwords, enable or disable accounts, change roles, and delete users                                                                            |
| Registration            | No public registration                                  | No public registration; accounts are created by administrators                                                                                                                          |
| Content ownership       | Gallery content is managed as instance-wide data        | Photos, albums, and asynchronous tasks have an owner                                                                                                                                    |
| Dashboard permissions   | Administrator-oriented dashboard                        | Regular users only access the dashboard, their photos, and their albums                                                                                                                 |
| Cross-user access       | Not applicable to the single-owner model                | Regular users can only query or modify their own content; administrators can manage all content                                                                                         |
| Public gallery          | Public content is directly available                    | Public non-hidden content from all users is aggregated                                                                                                                                  |
| Public display modes    | Home gallery, albums, and globe                         | Adds a photo-flow wall for the currently visible public photos                                                                                                                          |
| Visitor protection      | Site-wide password gate                                 | Visitors can preview a configurable number of photos and albums, then enter a password to unlock all public content                                                                     |
| Protected media         | Storage URLs may be exposed by the normal upstream flow | Original images, thumbnails, Live Photos, and downloads are checked by the application before being returned                                                                            |
| Low-cost media browsing | Detail pages may browse original images directly        | Image uploads generate a 2560px WebP display asset; detail, fullscreen, and nearby preload flows use the display asset by default while originals stay available for explicit downloads |
| Video media             | Image and Live Photo oriented                           | Adds MP4 upload, processing, thumbnail/metadata extraction, and browser-playable video handling                                                                                         |
| Map providers           | Mapbox-oriented map flow                                | Adds Amap/Gaode map display and Amap reverse-geocoding support for mainland-China friendly deployments                                                                                  |
| Share previews          | Standard route preview behavior                         | Adds authenticated media-backed Open Graph preview routes for photos and videos                                                                                                         |
| Languages               | Existing upstream translations                          | Fork-specific UI is translated into Simplified Chinese, Traditional Chinese (Taiwan and Hong Kong), English, Japanese, and Russian                                                      |

## Users and Roles

The fork keeps `isAdmin` as the role flag and adds account enablement.

Administrators can:

- Create local users.
- Reset user passwords.
- Enable and disable accounts.
- Promote a regular user to administrator.
- Demote an administrator to a regular user.
- Delete regular users.
- View and manage all users' photos and albums.
- Access users, queues, logs, storage, and system settings.

Regular users can:

- Sign in with email and password.
- View the dashboard.
- Upload and manage their own photos.
- Create and manage their own albums.
- See only their own photos and albums in dashboard lists.

The server reloads the current user and role from the database during authorization, so role and account-status changes take effect without requiring the affected user to sign in again.

### Administrator Safety Rules

- An administrator cannot demote, disable, or delete their own account.
- The last enabled administrator cannot be demoted, disabled, or deleted.
- An administrator must be demoted before the account can be deleted.
- When a regular user is deleted, their photos, albums, and unfinished tasks are transferred to the administrator performing the deletion.

## Data Ownership and Isolation

Photos, albums, and asynchronous queue tasks include `ownerUserId`.

- Existing data is assigned to the earliest administrator during migration.
- New storage objects use a user-specific path such as `users/<userId>/...`.
- Regular users receive `404` for resources owned by other users, reducing resource-existence disclosure.
- A regular user can only add their own photos to their own albums.
- Upload and background-processing tasks retain the uploader's ownership.
- Hidden albums are visible only to their owner and administrators.

The public gallery still aggregates every user's non-hidden public content. Ownership isolation applies to management operations, not to content intentionally published in the public gallery.

Photo and album responses include owner metadata where it helps administrators and viewers understand who uploaded or owns an item. Dashboard photo and album lists surface this information while still respecting the regular-user isolation rules above.

## Visitor Preview and Access Password

When access protection is enabled, anonymous visitors are not blocked on first entry. Instead, they can preview:

- The newest 10 public photos by default.
- The newest 1 public album by default.

Both limits are configurable under **Dashboard → General Settings → Site access protection**.

If more public content exists, the home page, albums page, and globe display an unlock action. After the visitor enters the correct password:

- The backend issues a signed, HttpOnly, SameSite=Lax cookie.
- Access remains valid for 30 days.
- Pages, public APIs, images, thumbnails, Live Photos, and downloads can return all authorized public content.
- Signed-in users bypass the visitor password.

The cookie includes the access-password version. Changing the password, or changing the protection configuration in a way that increments the version, invalidates older visitor credentials.

Password verification is rate-limited to five failed attempts per source within 15 minutes.

## Media Access

This fork routes media access through ChronoFrame authorization rather than trusting a client-visible storage URL.

Anonymous visitors without an unlock credential can only retrieve media belonging to the configured preview set. Directly requesting a later photo, album, thumbnail, original image, or Live Photo does not bypass the preview limit.

For S3 or OpenList deployments, the underlying bucket or storage service should remain private. Making the bucket independently public bypasses application-level access control.

## Public Display Modes

The fork adds a public, gallery-style display route:

- `/album-flow` renders the currently visible public photo set as an animated flowing wall. It does not display album cards.

This page uses the same visitor-preview entitlement as the home page. Anonymous visitors who have not unlocked the site only see the configured preview photo count; signed-in users and visitors with a valid access cookie can see the full authorized public set. The page only links back to the home page, with an unlock action shown only when more photos are available.

## MP4 Video Support and Share Previews

The fork accepts MP4 uploads in addition to images and Live Photos. Video processing extracts metadata and poster imagery, stores video ownership, and exposes browser-playable media through the same application authorization layer as other protected media.

Photo and video share previews use application-owned Open Graph media routes instead of exposing raw storage objects. This keeps preview images aligned with the media-protection model and avoids leaking storage keys or private object URLs to the client.

## Map and Location Providers

In addition to the upstream map behavior, this fork adds Amap/Gaode support for deployments where Mapbox registration or usage is inconvenient. Administrators can configure map display and reverse-geocoding providers in the dashboard settings and onboarding flow.

Amap support requires the appropriate browser-side map key and, for reverse geocoding, a valid web-service key. Location extraction still depends on GPS metadata being present in the uploaded image or video source.

## Database and Upgrade Notes

This fork contains migrations that add and enforce content ownership. Before upgrading:

1. Back up the entire `data` directory and external storage configuration.
2. Verify that at least one enabled administrator exists.
3. Start the new version and allow the automatic migrations to complete.
4. Confirm historical photos and albums are assigned to the expected administrator.
5. Test one administrator, one regular user, and one anonymous visitor.

Do not downgrade to an upstream build that is unaware of these migrations without restoring a compatible database backup.

## Syncing with Upstream

Upstream changes should be reviewed rather than merged blindly, especially when they touch:

- Authentication and session handling.
- Photo, album, queue, or settings APIs.
- Database schema and migrations.
- Storage paths and public media URLs.
- Global route middleware.
- Map or gallery data-loading behavior.
- Public preview entitlements and protected media routes.
- MP4 processing and Open Graph preview generation.

After merging upstream changes, run at minimum:

```bash
pnpm lint
pnpm db:check
pnpm build
```

Then validate administrator, regular-user, anonymous-preview, password-unlock, media, album, and globe flows in a production-like environment.
