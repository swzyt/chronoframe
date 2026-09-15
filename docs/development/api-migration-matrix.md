# API migration matrix

`backend/contracts/routes.yaml` is the executable authority for route ownership. The current registry contains 89 operations: 88 have a verified Go implementation and are present in runtime `GO_API_ROUTES`, 27 read-only operations additionally carry selectable/comparable/shadowable metadata, and `/api/system/backend/status` intentionally remains a Node control-plane endpoint.

| Capability                        | Operations |     Go coverage | Selectable reads | Primary verification                                                      |
| --------------------------------- | ---------: | --------------: | ---------------: | ------------------------------------------------------------------------- |
| Access control                    |          4 |               4 |                2 | `dual:verify-access-control:container`                                    |
| Albums                            |          9 |               9 |                3 | `dual:verify-albums:container`                                            |
| Identity                          |          6 |               6 |                1 | `dual:verify-identity:container`                                          |
| Media read/render                 |          9 |               9 |                1 | `dual:verify-media-read:container`, `dual:verify-share-og:container`      |
| Photos                            |         11 |              11 |                4 | `dual:verify-photos-read:container`, `dual:verify-photos-write:container` |
| Pipeline control                  |          8 |               8 |                3 | `dual:verify-queue-control:container`                                     |
| Reactions                         |          4 |               4 |                2 | `dual:verify-reactions:container`                                         |
| Settings                          |         12 |              12 |                7 | `dual:verify-settings-control:container`                                  |
| Setup                             |          7 |               7 |                0 | `dual:verify-wizard:container`                                            |
| Upload shares                     |          8 |               8 |                2 | `dual:verify-upload-shares:container`                                     |
| User administration               |          4 |               4 |                1 | `dual:verify-admin-users:container`                                       |
| Runtime, backup and observability |          7 | 6 + 1 Node-only |                1 | readiness, backup and system verification suites                          |

The browser never selects a backend. Node matches method and path against `GO_API_ROUTES`, reads `system.backend.readProvider`, and proxies registered read and write operations to `CFRAME_GO_UPSTREAM`. Despite the legacy `readProvider` name, this is currently a full registered-route switch. Switching to Go requires `/health/ready` to report database, Redis and media tools as healthy.

Mutating operations are not eligible for compare/shadow metadata, but they do move with the global Go provider. They therefore require ownership, rollback, retry and idempotency verification before the global switch is safe. Read operations must pass normalized Node/Go differential tests before `allowCompare`, `allowShadow` or `userSelectable` is enabled.

To add or migrate an operation:

1. Keep Node, Go and OpenAPI method/path behavior aligned.
2. Declare capability, auth, side effects, maturity and selection policy in `routes.yaml`.
3. Run `pnpm contracts:check`.
4. Add a domain verification scenario, including authorization failures.
5. For media, cover GET/HEAD, Range, conditional requests and cache headers.
6. Update the matrix and deployment acceptance checklist.

Rollback is server controlled: set `system.backend.readProvider=node`. Do not route from a client-provided backend header or query parameter.
