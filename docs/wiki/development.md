# Developer Reference

## Stack

| Layer    | Tech                                              |
| -------- | ------------------------------------------------- |
| Frontend | Nuxt 4, Vue 3, Nuxt UI, Tailwind CSS, Pinia       |
| Backend  | Nuxt server routes, SQLite, Drizzle ORM           |
| Media    | Sharp, ExifTool, FFmpeg/FFprobe, HEIC conversion  |
| Maps     | Mapbox, MapLibre, AMap                            |
| Storage  | Local filesystem, S3-compatible storage, OpenList |
| Docs     | VitePress                                         |

## Commands

```bash
pnpm install
pnpm dev
pnpm lint
pnpm fmt:check
pnpm build
pnpm docs:build
pnpm db:check
```

## Permission rules

Every new page or API should define anonymous, regular-user, and admin behavior. Regular users should be scoped by `ownerUserId`; admins can manage all data. Cross-user resource access should return 404 where possible.

## Public access rules

Access password validation must happen on the server. Logged-in users bypass public access protection. Anonymous visitors without a valid access cookie are limited to the configured preview range, including APIs and media routes.

## Media rules

Do not expose final direct object-storage URLs to the client. Media should be returned through ChronoFrame proxy routes so authorization, cache headers, conditional requests, and range requests are handled consistently.

## Localization

All user-facing UI strings need English and Simplified Chinese translations. Raw keys such as `settings.location.provider.options.auto` indicate missing or incorrect i18n wiring.
