# Backend workspace

ChronoFrame keeps every backend implementation and its cross-language contracts under this directory.

```text
backend/
├── contracts/          # Route, schema and fixture contracts shared by Node.js and Go
├── go/                 # Go module and production image
│   ├── cmd/api/        # API process entry point
│   └── internal/       # Private application, domain and platform packages
└── nodejs/             # Nuxt/Nitro serverDir
    ├── api/             # Nitro API routes
    ├── database/        # Drizzle schema and migrations
    ├── services/        # Node.js business services
    ├── tasks/           # Nitro tasks
    └── utils/           # Server-only helpers
```

## Boundary rules

- Add Node.js server code to `backend/nodejs`; do not recreate a root `server/` directory.
- Import Node.js server modules through Nuxt's `#server` alias. `nuxt.config.ts` maps `serverDir` to `backend/nodejs`.
- Keep language-neutral HTTP, database and value-format contracts in `backend/contracts`. A contract may be consumed by both implementations but must not import either implementation.
- `backend/go` is an independent Go module. Code outside `cmd` remains under `internal` until a real external consumer requires a public package.
- Node.js remains the migration owner in the default dual stack; Go validates the same schema and can run the explicitly selected one-shot migrator.
- Node.js and Go share SQLite, Redis and object keys. Background consumers and schedulers still require an explicit single runtime owner.

Run repository commands from the repository root:

```bash
pnpm test
pnpm test:go
pnpm build
```

The dual-stack runtime and verification commands live in `deploy/dual` and the root `package.json`.
