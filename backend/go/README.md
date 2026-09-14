# Go backend

This directory is a self-contained Go module for the ChronoFrame API and runtime workers.

```text
go/
├── cmd/
│   └── api/              # main package: dependency wiring and process lifecycle
├── internal/
│   ├── app/              # HTTP composition, handlers, workers and schedulers
│   ├── access/           # Access-control service
│   ├── albums/           # Album persistence
│   ├── auth/             # Authentication and password behavior
│   ├── media/            # Media storage/signing behavior
│   ├── photos/           # Photo persistence
│   ├── queue/            # Shared queue persistence
│   ├── settings/         # Settings contract and persistence
│   ├── storage/          # Storage-provider persistence
│   ├── uploads/          # Upload persistence
│   └── platform/         # Config, SQLite, Redis and HTTP infrastructure
├── Dockerfile
├── go.mod
└── go.sum
```

## Conventions

- `cmd/api/main.go` only owns process composition and lifecycle. Reusable behavior belongs in `internal`.
- `internal` intentionally prevents accidental imports from outside this module. There is no `pkg/` directory because the project does not currently publish reusable Go libraries.
- Domain packages own persistence and domain-specific behavior. Infrastructure adapters stay in `internal/platform`.
- Cross-language contracts live in `../contracts`; generated Go sources identify their Node.js or contract authority in the file header.
- Add a second directory under `cmd` only when it represents a separately built process. Do not place libraries under `cmd`.

`internal/app` is currently a modular-monolith composition package. Split it into packages such as `httpapi`, `worker` or `scheduler` only after those boundaries have stable dependencies; directory depth by itself is not an architecture goal.

Useful checks from the repository root:

```bash
pnpm test:go
pnpm contracts:check
docker build -f backend/go/Dockerfile .
```
