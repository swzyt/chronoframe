import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const compose = readFileSync(
  new URL('../deploy/dual/compose.yaml', import.meta.url),
  'utf8',
)
const caddyfile = readFileSync(
  new URL('../deploy/dual/Caddyfile', import.meta.url),
  'utf8',
)
const goPipelineConsumerOverride = readFileSync(
  new URL('../deploy/dual/compose.go-pipeline-consumer.yaml', import.meta.url),
  'utf8',
)
const goMigratorOverride = readFileSync(
  new URL('../deploy/dual/compose.go-migrator.yaml', import.meta.url),
  'utf8',
)
const goBackupSchedulerOverride = readFileSync(
  new URL('../deploy/dual/compose.go-backup-scheduler.yaml', import.meta.url),
  'utf8',
)
const goPrimaryOverride = readFileSync(
  new URL('../deploy/dual/compose.go-primary.yaml', import.meta.url),
  'utf8',
)
const s3Override = readFileSync(
  new URL('../deploy/dual/compose.s3.yaml', import.meta.url),
  'utf8',
)
const packageJSON = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)

function service(name) {
  const header = new RegExp(`^  ${name}:\\n`, 'm').exec(compose)
  assert.ok(header, `missing ${name} service`)
  const start = header.index
  const nextService = /^  [a-z][a-z0-9_-]*:\n/gm
  nextService.lastIndex = start + header[0].length
  const next = nextService.exec(compose)
  return compose.slice(start, next?.index)
}

test('dual Compose initializes Node WAL before starting the shared-state Go backend', () => {
  const node = service('node')
  const go = service('go')

  assert.match(
    node,
    /fetch\('http:\/\/127\.0\.0\.1:3000\/api\/_auth\/session'\)/,
  )
  assert.match(go, /node:\n\s+condition: service_healthy/)
  assert.match(go, /\$\{CFRAME_DATA_DIR:-app_data}:\/app\/data/)
  assert.match(go, /CFRAME_GO_MODE: normal/)
  assert.match(node, /CFRAME_GO_UPSTREAM: http:\/\/go:8080/)
})

test('dual Compose defaults shared SQLite data to a Docker named volume', () => {
  const node = service('node')
  const go = service('go')
  const fixture = service('fixture')

  for (const candidate of [node, go, fixture]) {
    assert.match(candidate, /\$\{CFRAME_DATA_DIR:-app_data}:\/app\/data/)
  }
  assert.match(compose, /^  app_data:\n/m)
})

test('dual Compose includes a containerized fixture seeder for the shared volume', () => {
  const fixture = service('fixture')

  assert.match(fixture, /profiles:\n\s+- tools/)
  assert.match(fixture, /target: build/)
  assert.match(fixture, /DATABASE_URL: \/app\/data\/app\.sqlite3/)
  assert.match(fixture, /CFRAME_REDIS_URL: redis:\/\/redis:6379\/0/)
  assert.match(fixture, /redis:\n\s+condition: service_healthy/)
  assert.match(fixture, /pnpm\n\s+- dual:seed-compare/)
})

test('dual compare can run from the Compose tools network', () => {
  assert.equal(
    packageJSON.scripts['dual:compare:container'],
    'docker compose -f deploy/dual/compose.yaml --profile tools run --rm --build fixture node scripts/compare-backends.mjs --node http://gateway --go http://gateway/__lab/go --all --cookie "cf_session=Q0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0M"',
  )
})

test('dual switch verifier can run from the Compose tools network', () => {
  assert.equal(
    packageJSON.scripts['dual:verify-switch:container'],
    'docker compose -f deploy/dual/compose.yaml --profile tools run --rm --build fixture node scripts/verify-dual-switch.mjs --base http://gateway --go-base http://go:8080',
  )
})

test('dual route surface verifier can run from the Compose tools network', () => {
  assert.equal(
    packageJSON.scripts['dual:verify-route-surface:container'],
    'docker compose -f deploy/dual/compose.yaml --profile tools run --rm --build fixture node scripts/verify-dual-route-surface.mjs --base http://gateway',
  )
})

test('dual route boundaries verifier can run from the Compose tools network', () => {
  assert.equal(
    packageJSON.scripts['dual:verify-route-boundaries:container'],
    'docker compose -f deploy/dual/compose.yaml --profile tools run --rm --build fixture node scripts/verify-dual-route-boundaries.mjs --node http://gateway --go http://gateway/__lab/go',
  )
})

test('dual authz verifier can run from the Compose tools network', () => {
  assert.equal(
    packageJSON.scripts['dual:verify-authz:container'],
    'docker compose -f deploy/dual/compose.yaml --profile tools run --rm --build fixture node scripts/verify-dual-authz.mjs --base http://gateway',
  )
})

test('dual mutation verifier can run from the Compose tools network', () => {
  assert.equal(
    packageJSON.scripts['dual:verify-mutations:container'],
    'docker compose -f deploy/dual/compose.yaml --profile tools run --rm --build fixture node scripts/verify-dual-mutations.mjs --base http://gateway',
  )
})

test('dual photos-write verifier can access shared state from the Compose tools network', () => {
  assert.equal(
    packageJSON.scripts['dual:verify-photos-write:container'],
    'docker compose -f deploy/dual/compose.yaml --profile tools run --rm --build fixture node scripts/verify-dual-photos-write.mjs --base http://gateway --db /app/data/app.sqlite3',
  )
})

test('dual Live Photo verifier can access shared state from the Compose tools network', () => {
  assert.equal(
    packageJSON.scripts['dual:verify-livephoto:container'],
    'docker compose -f deploy/dual/compose.yaml --profile tools run --rm --build fixture node scripts/verify-dual-livephoto.mjs --base http://gateway --db /app/data/app.sqlite3',
  )
})

test('dual system-read verifier can access shared state from the Compose tools network', () => {
  assert.equal(
    packageJSON.scripts['dual:verify-system-reads:container'],
    'docker compose -f deploy/dual/compose.yaml --profile tools run --rm --build fixture node scripts/verify-dual-system-reads.mjs --base http://gateway --db /app/data/app.sqlite3',
  )
})

test('dual wizard verifier can access shared SQLite and Redis from the Compose tools network', () => {
  assert.equal(
    packageJSON.scripts['dual:verify-wizard:container'],
    'docker compose -f deploy/dual/compose.yaml --profile tools run --rm --build fixture node scripts/verify-dual-wizard.mjs --base http://gateway --db /app/data/app.sqlite3',
  )
})

test('dual share-OG verifier can access shared media and state from the Compose tools network', () => {
  assert.equal(
    packageJSON.scripts['dual:verify-share-og:container'],
    'docker compose -f deploy/dual/compose.yaml --profile tools run --rm --build fixture node scripts/verify-dual-share-og.mjs --base http://gateway --db /app/data/app.sqlite3 --data-root /app/data',
  )
})

test('dual upload pipeline verifier can run with the Go consumer Compose owner', () => {
  assert.equal(
    packageJSON.scripts['dual:verify-upload-pipeline:container'],
    'docker compose -f deploy/dual/compose.yaml -f deploy/dual/compose.go-pipeline-consumer.yaml --profile tools run --rm --build fixture node scripts/verify-dual-upload-pipeline.mjs --base http://gateway',
  )
})

test('dual S3 verifier runs against an isolated MinIO service in the tools network', () => {
  assert.match(s3Override, /^  minio:\n/m)
  assert.match(
    s3Override,
    /quay\.io\/minio\/minio:RELEASE\.2025-04-22T22-12-26Z/,
  )
  assert.match(s3Override, /CFRAME_DUAL_S3_ENDPOINT: http:\/\/minio:9000/)
  assert.match(s3Override, /condition: service_started/)
  assert.equal(
    packageJSON.scripts['dual:verify-s3-storage:container'],
    'docker compose -f deploy/dual/compose.yaml -f deploy/dual/compose.go-pipeline-consumer.yaml -f deploy/dual/compose.s3.yaml --profile tools run --rm --build fixture node scripts/verify-dual-s3-storage.mjs --base http://gateway --s3-endpoint http://minio:9000',
  )
})

test('dual OpenList verifier runs an isolated protocol fixture in the tools network', () => {
  assert.equal(
    packageJSON.scripts['dual:verify-openlist-storage:container'],
    'docker compose -f deploy/dual/compose.yaml -f deploy/dual/compose.go-pipeline-consumer.yaml --profile tools run --rm --build fixture node scripts/verify-dual-openlist-storage.mjs --base http://gateway --openlist-host self --openlist-bind 0.0.0.0',
  )
})

test('dual Redis outage verifier controls only the local Compose Redis lifecycle', () => {
  assert.equal(
    packageJSON.scripts['dual:verify-redis-outage:container'],
    'node scripts/verify-dual-redis-outage.mjs',
  )
})

test('dual access-control verifier can run from the Compose tools network', () => {
  assert.equal(
    packageJSON.scripts['dual:verify-access-control:container'],
    'docker compose -f deploy/dual/compose.yaml --profile tools run --rm --build fixture node scripts/verify-dual-access-control.mjs --base http://gateway',
  )
})

test('dual all-in-one container verifier orchestrates the parity gates', () => {
  assert.equal(
    packageJSON.scripts['dual:verify-all:container'],
    'node scripts/verify-dual-container-suite.mjs',
  )
})

test('Go-primary Compose owns backend jobs and has no Node startup dependency', () => {
  assert.match(goPrimaryOverride, /^  go-migrator:\n/m)
  assert.match(goPrimaryOverride, /CFRAME_GO_MIGRATE_ONLY: 'true'/)
  assert.match(
    goPrimaryOverride,
    /127\.0\.0\.1:\$\{CFRAME_DUAL_GO_PORT:-38080}:8080/,
  )
  assert.match(
    goPrimaryOverride,
    /go:[\s\S]*CFRAME_PIPELINE_CONSUMER: go[\s\S]*CFRAME_BACKUP_SCHEDULER: go/,
  )
  assert.match(
    goPrimaryOverride,
    /go:[\s\S]*depends_on: !override[\s\S]*go-migrator:[\s\S]*redis:/,
  )
  const goSection = goPrimaryOverride.slice(
    goPrimaryOverride.indexOf('\n  go:'),
  )
  assert.doesNotMatch(goSection, /\n\s+node:/)
  assert.equal(
    packageJSON.scripts['dual:verify-go-standalone'],
    'node scripts/verify-go-standalone.mjs',
  )
})

test('dual Compose keeps a single active owner for stateful capabilities', () => {
  const node = service('node')
  const go = service('go')

  assert.match(node, /CFRAME_REDIS_REQUIRED: 'true'/)
  assert.match(node, /CFRAME_DB_MIGRATOR: node/)
  assert.match(node, /CFRAME_PIPELINE_CONSUMER: node/)
  assert.match(node, /CFRAME_BACKUP_SCHEDULER: node/)
  assert.match(
    node,
    /NUXT_SESSION_PASSWORD: \$\{NUXT_SESSION_PASSWORD:-chronoframe-dual-development-secret-change-me}/,
  )
  assert.match(
    node,
    /NUXT_OG_IMAGE_SECRET: \$\{NUXT_OG_IMAGE_SECRET:-chronoframe-dual-og-development-secret}/,
  )

  assert.match(go, /CFRAME_REDIS_REQUIRED: 'true'/)
  assert.match(go, /CFRAME_DB_MIGRATOR: none/)
  assert.match(go, /CFRAME_PIPELINE_CONSUMER: none/)
  assert.match(go, /CFRAME_BACKUP_SCHEDULER: none/)
  assert.match(
    go,
    /NUXT_SESSION_PASSWORD: \$\{NUXT_SESSION_PASSWORD:-chronoframe-dual-development-secret-change-me}/,
  )
  assert.match(
    go,
    /NUXT_OG_IMAGE_SECRET: \$\{NUXT_OG_IMAGE_SECRET:-chronoframe-dual-og-development-secret}/,
  )
})

test('dual Compose exposes password-protected Redis only on loopback for fixture seeding', () => {
  const redis = service('redis')

  assert.match(redis, /127\.0\.0\.1:\$\{CFRAME_DUAL_REDIS_PORT:-36379}:6379/)
  assert.match(redis, /--requirepass "\$\${REDIS_PASSWORD}"/)
})

test('Go pipeline consumer override transfers the singleton owner explicitly', () => {
  assert.match(goPipelineConsumerOverride, /CFRAME_PIPELINE_CONSUMER: go/)
  assert.match(
    goPipelineConsumerOverride,
    /Node sees owner=go and skips its Nitro pipeline queue plugin/,
  )
  assert.doesNotMatch(
    goPipelineConsumerOverride,
    /CFRAME_PIPELINE_CONSUMER:\s*node/,
  )
})

test('Go migrator override bootstraps SQLite before Node and Go API services', () => {
  assert.match(goMigratorOverride, /^  go-migrator:\n/m)
  assert.match(goMigratorOverride, /context: \.\.\/\.\./)
  assert.match(goMigratorOverride, /dockerfile: backend\/go\/Dockerfile/)
  assert.match(goMigratorOverride, /CFRAME_DB_MIGRATOR: go/)
  assert.match(goMigratorOverride, /CFRAME_GO_MIGRATE_ONLY: 'true'/)
  assert.match(goMigratorOverride, /CFRAME_REDIS_REQUIRED: 'false'/)
  assert.match(goMigratorOverride, /\$\{CFRAME_DATA_DIR:-app_data}:\/app\/data/)
  assert.match(
    goMigratorOverride,
    /node:[\s\S]*CFRAME_DB_MIGRATOR: go[\s\S]*go-migrator:\n\s+condition: service_completed_successfully/,
  )
  assert.match(
    goMigratorOverride,
    /go:[\s\S]*CFRAME_DB_MIGRATOR: none[\s\S]*go-migrator:\n\s+condition: service_completed_successfully/,
  )
})

test('Go backup scheduler override transfers the singleton owner explicitly', () => {
  assert.match(goBackupSchedulerOverride, /CFRAME_BACKUP_SCHEDULER: go/)
  assert.match(
    goBackupSchedulerOverride,
    /Node sees owner=go and skips its Nitro database-backup plugin/,
  )
  assert.match(
    goBackupSchedulerOverride,
    /CFRAME_GO_BACKUP_SCHEDULE_REFRESH_INTERVAL: \$\{CFRAME_GO_BACKUP_SCHEDULE_REFRESH_INTERVAL:-1s}/,
  )
  assert.doesNotMatch(
    goBackupSchedulerOverride,
    /CFRAME_BACKUP_SCHEDULER:\s*node/,
  )
})

test('stable Node gateway startup does not depend on the experimental Go backend', () => {
  const gateway = service('gateway')

  assert.match(gateway, /node:\n\s+condition: service_healthy/)
  assert.doesNotMatch(gateway, /^\s+go:/m)
})

test('Caddy exposes the complete Go learning API behind an explicit prefix', () => {
  assert.match(
    caddyfile,
    /@go_api\s+path_regexp go_api \^\/__lab\/go\/\(api\|image\|storage\|display\|thumb\|og-media\|share-og\)/,
  )
  assert.match(caddyfile, /uri strip_prefix \/__lab\/go/)
  assert.match(
    caddyfile,
    /handle \/__lab\/go\/\*\s*{\s*respond [^\n]+ 404\s*}/s,
  )
  assert.doesNotMatch(caddyfile, /handle_path \/__lab\/go\/\*/)
  assert.match(caddyfile, /handle\s*{\s*reverse_proxy node:3000\s*}/s)
  for (const header of [
    'X-ChronoFrame-Backend-Request',
    'X-ChronoFrame-Route-Id',
    'X-ChronoFrame-Original-URL',
    'X-ChronoFrame-Original-Accept-Encoding',
  ]) {
    assert.match(
      caddyfile,
      new RegExp(`request_header -${header}`),
      `Caddy must strip ${header} from external requests`,
    )
  }
})
