# Current technical and business architecture

> Baseline: current `main` branch during the Node.js + Go dual-backend phase.  
> Interactive diagram: [/architecture/chronoframe-current.html](/architecture/chronoframe-current.html)

ChronoFrame currently runs as a single repository with a stable Nuxt/Node entry point and an independently built Go backend. Node remains the public gateway and default owner; Go can take over explicitly registered routes after readiness checks pass. Both implementations share SQLite, Redis and object storage, while side-effectful actors such as database migration, queue consumers and backup schedulers must have exactly one owner at a time.

```text
Browser
  Nuxt 4 UI / SSR
    Node.js / Nitro gateway
      ├─ handles stable API, SSR, media fallback and control plane
      └─ proxies GO_API_ROUTES to Go when provider=go
            Go API / Workers
              ├─ migrated HTTP APIs
              ├─ optional pipeline consumer
              └─ optional backup scheduler

Shared state
  SQLite + WAL      # source of truth
  Redis             # session, entitlement, rate limits, settings version, runtime lease
  Object storage    # Local / S3-compatible / OpenList media bytes
```

## Code boundaries

```text
chronoframe/
├── app/                         # Nuxt pages, components, composables and stores
├── backend/
│   ├── contracts/               # route, OpenAPI, schema and settings contracts
│   ├── nodejs/                  # Nitro serverDir, gateway and Node services
│   └── go/                      # independent Go module, API, workers and schedulers
├── deploy/dual/                 # local dual-stack Compose and owner overrides
├── docs/                        # VitePress docs and wiki
├── packages/webgl-image/        # local image viewer package
└── scripts/                     # contract generation and dual-backend verification
```

## Runtime routing

```text
request
  backend-dispatch middleware
    match method + path in GO_API_ROUTES
      no  -> Node handles request
      yes -> read system.backend.readProvider
        node -> Node handles request
        go   -> proxy to CFRAME_GO_UPSTREAM
```

Switching `system.backend.readProvider` to `go` is protected by a readiness gate. Node calls Go `/health/ready` and requires `database`, `mediaTools` and `redis` checks to be `ok` before persisting the setting. The same guard is applied to both the single-setting route and the batch settings route.

## Business architecture

| Actor | Capabilities |
| --- | --- |
| Anonymous visitor | Browse public content, limited by preview quotas before access-password verification |
| Normal user | Manage own photos and albums from the dashboard |
| Admin | Manage all content, users, settings, queue, logs and backups |
| Upload-share visitor | Upload through a tokenized page without receiving a dashboard session |

Core domains:

- Photos: ownership, EXIF/GPS, storage keys, derived media, reactions and album membership.
- Albums: ownership, hidden/public state, cover photo and ordered photo membership.
- Access control: access password, signed HttpOnly entitlement cookie and preview quotas.
- Upload shares: tokenized upload links, quota enforcement and owner inheritance.
- Settings: app, privacy, analytics, map, storage, backup and backend-provider configuration.
- Operations: queue management, logs, backups, Docker images and dual-backend verification.

## Migration status

The Go backend covers the registered API surface for access control, identity, users, photos, albums, reactions, upload shares, settings, storage config, queue control, system stats/logs/backups, wizard initialization and media routes. The pipeline consumer supports image, video, Live Photo, Motion Photo, reverse geocoding and location-erasure tasks when explicitly selected as owner.

Node remains the stable fallback. Further hardening should continue around larger real-media corpora, managed cloud S3/COS/CDN behavior, real OpenList networks, large-file failure modes, Redis partition scenarios and deeper business-error parity.

## Verification reference

The interactive architecture diagram was generated with `archify` and passed showcase validation, delivery and automated browser visual checks at 1440×900, 1600×1000, 1920×1080 and 2048×1320.
