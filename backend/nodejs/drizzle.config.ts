import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './backend/nodejs/database/schema.ts',
  out: './backend/nodejs/database/migrations',
  dbCredentials: {
    url: 'file:./data/app.sqlite3',
  },
})
