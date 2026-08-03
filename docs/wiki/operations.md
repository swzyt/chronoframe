# Operations and Troubleshooting

## Backups

Configure scheduled database backups from the admin system settings page. ChronoFrame can create SQLite backups, compress them, optionally encrypt them, send them through SMTP, and retain local backup files for a configured number of days.

Recommended production practice:

- Back up daily.
- Keep at least 7–30 days.
- Use an SMTP app password or dedicated mail credential.
- Also back up the whole `/app/data` directory when using local storage.

## Upload failures

If `POST /api/photos` returns `500 Failed to prepare upload`, check:

- Active storage provider.
- S3/COS endpoint, bucket, region, and credentials.
- Write permissions.
- Docker volume mount for `/app/data`.
- Container logs.

## Broken images or thumbnails

If metadata appears but media fails to load:

- Log in as admin and retry, excluding anonymous preview restrictions.
- Check storage object existence.
- Check media proxy errors in logs.
- Retry failed queue jobs.
- Verify S3/COS read permissions.

## Video errors

Use the official image for FFmpeg/FFprobe support. If you see temporary-directory errors, ensure `/tmp` exists and is writable, and update to the latest image.

## GPS missing

Check whether the original file really contains GPS data, whether upload privacy settings erase location, whether queue jobs completed, and whether Live Photo pairs were uploaded together.

## Globe performance

The globe page can become expensive with many GPS points. Prefer thumbnail data, avoid loading full photo payloads, and test large libraries on desktop Chrome/Edge first.
