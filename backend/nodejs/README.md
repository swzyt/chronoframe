# Node.js backend

This directory is the existing Nuxt/Nitro backend, relocated from the repository-root `server/` directory so both backend implementations share one parent.

Nuxt is configured with:

```ts
export default defineNuxtConfig({
  serverDir: 'backend/nodejs',
})
```

That preserves Nitro's normal directory semantics:

- `api/` and `routes/` define HTTP handlers;
- `middleware/` defines server middleware;
- `plugins/` defines Nitro plugins;
- `tasks/` defines Nitro tasks;
- `database/` contains the Drizzle schema and migration ledger;
- `services/` and `utils/` contain server-only application code.

Use `#server/...` for internal imports so code follows the configured server directory without hard-coded repository-relative paths. Database commands still run from the repository root; each root script points Drizzle to `backend/nodejs/drizzle.config.ts`.

Do not put cross-language contracts in this directory. Add them to `backend/contracts` so the Go and Node.js implementations consume the same source of truth.
