import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDualContainerSuitePlan,
  parseDualContainerSuiteOptions,
  runDualContainerSuite,
} from '../scripts/verify-dual-container-suite.mjs'

test('dual container suite plans the default and Go owner verification stacks', () => {
  const plan = buildDualContainerSuitePlan({
    port: 33123,
    redisPort: 36323,
    minioPort: 39023,
    goPort: 38023,
  })
  const commands = plan.phases.flatMap((phase) =>
    phase.commands.map((command) => command.label),
  )

  assert.deepEqual(plan.env, {
    CFRAME_DUAL_PORT: '33123',
    CFRAME_DUAL_REDIS_PORT: '36323',
    CFRAME_DUAL_MINIO_PORT: '39023',
    CFRAME_DUAL_GO_PORT: '38023',
  })
  assert.deepEqual(
    plan.phases.map((phase) => phase.name),
    [
      'default-stack',
      'go-pipeline-consumer-stack',
      'pipeline-consumer-handoff-back-to-node',
      'go-backup-scheduler-stack',
      'go-primary-standalone',
      'isolated-go-migrator',
    ],
  )
  assert.ok(commands.includes('pnpm dual:verify-go-readiness:container'))
  assert.ok(commands.includes('pnpm dual:compare:container'))
  assert.ok(commands.includes('pnpm dual:verify-route-surface:container'))
  assert.ok(commands.includes('pnpm dual:verify-route-boundaries:container'))
  assert.ok(commands.includes('pnpm dual:verify-switch:container'))
  assert.ok(commands.includes('pnpm dual:verify-albums:container'))
  assert.ok(commands.includes('pnpm dual:verify-admin-users:container'))
  assert.ok(commands.includes('pnpm dual:verify-reactions:container'))
  assert.ok(commands.includes('pnpm dual:verify-mutations:container'))
  assert.ok(commands.includes('pnpm dual:verify-photos-write:container'))
  assert.ok(commands.includes('pnpm dual:verify-livephoto:container'))
  assert.ok(commands.includes('pnpm dual:verify-system-logs:container'))
  assert.ok(commands.includes('pnpm dual:verify-system-reads:container'))
  assert.ok(commands.includes('pnpm dual:verify-wizard:container'))
  assert.ok(commands.includes('pnpm dual:verify-share-og:container'))
  assert.ok(commands.includes('pnpm dual:verify-queue-control:container'))
  assert.ok(commands.includes('pnpm dual:verify-settings-control:container'))
  assert.ok(commands.includes('pnpm dual:verify-backup:container'))
  assert.ok(commands.includes('pnpm dual:verify-authz:container'))
  assert.ok(commands.includes('pnpm dual:verify-identity:container'))
  assert.ok(commands.includes('pnpm dual:verify-access-control:container'))
  assert.ok(commands.includes('pnpm dual:verify-redis-outage:container'))
  assert.ok(commands.includes('pnpm dual:verify-upload-shares:container'))
  assert.ok(commands.includes('pnpm dual:verify-s3-storage:container'))
  assert.ok(commands.includes('pnpm dual:verify-openlist-storage:container'))
  assert.ok(commands.includes('pnpm dual:up:go-pipeline-consumer:s3'))
  assert.ok(
    commands.includes(
      'docker compose -f deploy/dual/compose.yaml up --build -d',
    ),
  )
  assert.ok(
    commands.includes(
      'pnpm dual:verify-runtime-owners:container:go-pipeline-consumer',
    ),
  )
  assert.ok(commands.includes('pnpm dual:verify-go-backup-scheduler:container'))
  assert.ok(commands.includes('pnpm dual:verify-go-migrator'))
  assert.ok(commands.includes('pnpm dual:up:go-primary'))
  assert.ok(commands.includes('pnpm dual:verify-go-standalone'))
  assert.equal(
    plan.phases.find((phase) => phase.name === 'go-backup-scheduler-stack')
      ?.commands[0]?.label,
    'pnpm dual:down:s3',
    'the S3 overlay and MinIO orphan must be removed before recreating the project network',
  )
  assert.ok(
    commands.includes(
      'docker compose -f deploy/dual/compose.yaml -f deploy/dual/compose.go-primary.yaml stop gateway node',
    ),
  )
})

test('dual container suite cleanup is explicit and does not remove volumes', () => {
  const plan = buildDualContainerSuitePlan()
  const cleanup = plan.cleanup.map((command) => command.label)

  assert.deepEqual(cleanup, [
    'pnpm dual:down:go-primary',
    'pnpm dual:down:s3',
    'pnpm dual:down:go-backup-scheduler',
    'pnpm dual:down:go-pipeline-consumer',
    'pnpm dual:down',
  ])
  assert.doesNotMatch(
    JSON.stringify(plan),
    /down\s+-v/,
    'the suite must not delete shared fixture volumes by default',
  )
})

test('dual container suite parser accepts dry run and custom ports', () => {
  assert.deepEqual(
    parseDualContainerSuiteOptions(
      [
        '--dry-run',
        '--port',
        '33200',
        '--minio-port',
        '39100',
        '--go-port',
        '38100',
      ],
      {
        CFRAME_DUAL_REDIS_PORT: '36400',
      },
    ),
    {
      dryRun: true,
      keep: false,
      port: 33200,
      redisPort: 36400,
      minioPort: 39100,
      goPort: 38100,
    },
  )
})

test('dual container suite runner executes cleanup after a failed command', () => {
  const plan = {
    env: {},
    phases: [
      {
        name: 'sample',
        commands: [
          { label: 'ok', bin: 'ok', args: [], env: {} },
          { label: 'fail', bin: 'fail', args: [], env: {} },
        ],
      },
    ],
    cleanup: [{ label: 'cleanup', bin: 'cleanup', args: [], env: {} }],
  }
  const executed = []

  assert.throws(
    () =>
      runDualContainerSuite({
        plan,
        runner(command) {
          executed.push(command.label)
          return {
            status: command.label === 'fail' ? 1 : 0,
          }
        },
        logger: {
          log() {},
        },
      }),
    /fail failed with exit code 1/,
  )
  assert.deepEqual(executed, ['ok', 'fail', 'cleanup'])
})
