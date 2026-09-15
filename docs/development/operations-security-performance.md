# Operations, security and performance

## Production boundaries

Node/Nuxt is the only public application entry and the Go API and Redis remain on an internal network or loopback. Node and Go share `DATABASE_URL`, `NUXT_SESSION_PASSWORD`, `NUXT_OG_IMAGE_SECRET`, Redis configuration and storage configuration. Database migrator, pipeline consumer and backup scheduler each have exactly one owner.

## Release and rollback

Run `pnpm lint`, `pnpm contracts:check`, `pnpm test:go`, `pnpm build` and `pnpm docs:build`. Dual-backend changes should also pass the container suite. Before deployment, record the current image digest and back up SQLite. Deploy immutable SHA tags first, reuse the existing environment and data volume, then verify Node, Go readiness, Redis, login, public pages and media.

API regressions can be contained by switching `backend.readProvider` back to `node`. Despite its legacy name, this setting currently controls all registered read and write routes. Image rollback uses the recorded digest. Do not run an older binary against an unknown newer schema unless compatibility has been established.

## Security controls

- Database-confirmed active user, role, `auth_version` and resource ownership.
- Signed HttpOnly site-access cookie with password-version revocation and attempt limiting.
- Hashed, expiring, quota-limited visitor upload tokens.
- Private storage with authenticated media proxy; no permanent object links in client data.
- One runtime owner plus Redis lease and SQLite claim fencing for side-effect actors.
- MIME/magic/size validation, media-tool timeouts and isolated temporary files.
- Secrets excluded from `NUXT_PUBLIC_*`, API output and logs.

## Performance and cost

Lists use thumbnails, details use display derivatives and originals are loaded only for zoom/download/full quality. Video playback uses browser-compatible derivatives and Range requests. CDN and browser cache hit rate should be measured alongside object-store request and egress cost. Queue concurrency starts conservatively because SQLite writes, transcoding CPU, memory and temporary disk are shared bottlenecks. Redis uses `noeviction` so memory pressure fails visibly instead of silently deleting sessions or leases.

Known architectural limits include the Node public/SSR dependency, SQLite write scalability, incomplete coverage of real-world media variants and provider-specific COS/S3/OpenList behavior, Redis availability, and database-only email backups. The Chinese [operations, security and performance handbook](/zh/development/operations-security-performance) contains the detailed configuration, troubleshooting, risk and drill matrices.
