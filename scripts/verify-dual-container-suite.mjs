#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const DEFAULT_PORT = 33119
const DEFAULT_REDIS_PORT = 36399
const DEFAULT_MINIO_PORT = 39019
const DEFAULT_GO_PORT = 38019

const DEFAULT_STACK_CHECKS = [
  'dual:verify-go-readiness:container',
  'dual:compare:container',
  'dual:verify-route-surface:container',
  'dual:verify-route-boundaries:container',
  'dual:verify-switch:container',
  'dual:verify-photos-read:container',
  'dual:verify-albums:container',
  'dual:verify-admin-users:container',
  'dual:verify-reactions:container',
  'dual:verify-mutations:container',
  'dual:verify-photos-write:container',
  'dual:verify-livephoto:container',
  'dual:verify-system-logs:container',
  'dual:verify-system-reads:container',
  'dual:verify-wizard:container',
  'dual:verify-share-og:container',
  'dual:verify-queue-control:container',
  'dual:verify-settings-control:container',
  'dual:verify-media-read:container',
  'dual:verify-runtime-owners:container',
  'dual:verify-backup:container',
  'dual:verify-authz:container',
  'dual:verify-oauth:container',
  'dual:verify-identity:container',
  'dual:verify-access-control:container',
  'dual:verify-redis-outage:container',
]

const GO_PIPELINE_STACK_CHECKS = [
  'dual:verify-runtime-owners:container:go-pipeline-consumer',
  'dual:verify-media-parity:container',
  'dual:verify-upload-shares:container',
  'dual:verify-s3-storage:container',
  'dual:verify-openlist-storage:container',
]

const ISOLATED_CHECKS = [
  'dual:verify-go-backup-scheduler:container',
  'dual:verify-go-migrator',
]

export function parseDualContainerSuiteOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  let dryRun = false
  let keep = false
  const values = new Map()

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--keep') {
      keep = true
      continue
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`)
    }
    if (
      !['--port', '--redis-port', '--minio-port', '--go-port'].includes(arg)
    ) {
      throw new Error(`Unknown option: ${arg}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`)
    }
    values.set(arg, value)
    index += 1
  }

  return {
    dryRun,
    keep,
    port: parsePort(
      values.get('--port') || environment.CFRAME_DUAL_PORT || DEFAULT_PORT,
      'port',
    ),
    redisPort: parsePort(
      values.get('--redis-port') ||
        environment.CFRAME_DUAL_REDIS_PORT ||
        DEFAULT_REDIS_PORT,
      'redis-port',
    ),
    minioPort: parsePort(
      values.get('--minio-port') ||
        environment.CFRAME_DUAL_MINIO_PORT ||
        DEFAULT_MINIO_PORT,
      'minio-port',
    ),
    goPort: parsePort(
      values.get('--go-port') ||
        environment.CFRAME_DUAL_GO_PORT ||
        DEFAULT_GO_PORT,
      'go-port',
    ),
  }
}

export function buildDualContainerSuitePlan({
  port = DEFAULT_PORT,
  redisPort = DEFAULT_REDIS_PORT,
  minioPort = DEFAULT_MINIO_PORT,
  goPort = DEFAULT_GO_PORT,
} = {}) {
  const env = Object.freeze({
    CFRAME_DUAL_PORT: String(parsePort(port, 'port')),
    CFRAME_DUAL_REDIS_PORT: String(parsePort(redisPort, 'redis-port')),
    CFRAME_DUAL_MINIO_PORT: String(parsePort(minioPort, 'minio-port')),
    CFRAME_DUAL_GO_PORT: String(parsePort(goPort, 'go-port')),
  })

  return Object.freeze({
    env,
    phases: Object.freeze([
      phase('default-stack', [
        pnpmRun('dual:down', env),
        pnpmRun('dual:up', env),
        pnpmRun('dual:seed-compare:container', env),
        dockerComposeRestart(['deploy/dual/compose.yaml'], ['node', 'go'], env),
        pnpmRun('dual:seed-session:container', env),
        ...DEFAULT_STACK_CHECKS.map((script) => pnpmRun(script, env)),
      ]),
      phase('go-pipeline-consumer-stack', [
        pnpmRun('dual:down', env),
        pnpmRun('dual:up:go-pipeline-consumer:s3', env),
        pnpmRun('dual:seed-compare:container', env),
        dockerComposeRestart(
          [
            'deploy/dual/compose.yaml',
            'deploy/dual/compose.go-pipeline-consumer.yaml',
          ],
          ['node', 'go'],
          env,
        ),
        pnpmRun('dual:seed-session:container', env),
        ...GO_PIPELINE_STACK_CHECKS.map((script) => pnpmRun(script, env)),
      ]),
      phase('pipeline-consumer-handoff-back-to-node', [
        dockerComposeUp(['deploy/dual/compose.yaml'], env),
        dockerComposeRestart(['deploy/dual/compose.yaml'], ['node', 'go'], env),
        pnpmRun('dual:seed-session:container', env),
        pnpmRun('dual:verify-runtime-owners:container', env),
      ]),
      phase('go-backup-scheduler-stack', [
        // Tear down the full S3 overlay, including its MinIO service, before
        // Compose recreates the shared project network for the next owner.
        pnpmRun('dual:down:s3', env),
        pnpmRun('dual:up:go-backup-scheduler', env),
        pnpmRun('dual:seed-compare:container', env),
        dockerComposeRestart(
          [
            'deploy/dual/compose.yaml',
            'deploy/dual/compose.go-backup-scheduler.yaml',
          ],
          ['node', 'go'],
          env,
        ),
        pnpmRun('dual:seed-session:container', env),
        pnpmRun('dual:verify-go-backup-scheduler:container', env),
      ]),
      phase('go-primary-standalone', [
        pnpmRun('dual:down:go-backup-scheduler', env),
        pnpmRun('dual:up:go-primary', env),
        pnpmRun('dual:seed-compare:container', env),
        dockerComposeRestart(
          ['deploy/dual/compose.yaml', 'deploy/dual/compose.go-primary.yaml'],
          ['node', 'go'],
          env,
        ),
        pnpmRun('dual:seed-session:container', env),
        dockerComposeStop(
          ['deploy/dual/compose.yaml', 'deploy/dual/compose.go-primary.yaml'],
          ['gateway', 'node'],
          env,
        ),
        pnpmRun('dual:verify-go-standalone', env),
        dockerComposeUpServices(
          ['deploy/dual/compose.yaml', 'deploy/dual/compose.go-primary.yaml'],
          ['node', 'gateway'],
          env,
        ),
      ]),
      phase('isolated-go-migrator', [
        pnpmRun('dual:down:go-primary', env),
        pnpmRun('dual:verify-go-migrator', env),
      ]),
    ]),
    cleanup: Object.freeze([
      pnpmRun('dual:down:go-primary', env),
      pnpmRun('dual:down:s3', env),
      pnpmRun('dual:down:go-backup-scheduler', env),
      pnpmRun('dual:down:go-pipeline-consumer', env),
      pnpmRun('dual:down', env),
    ]),
  })
}

export function runDualContainerSuite({
  plan = buildDualContainerSuitePlan(),
  keep = false,
  runner = runCommand,
  logger = console,
} = {}) {
  const startedAt = Date.now()
  const summary = {
    ok: false,
    phases: [],
    cleanup: [],
  }

  try {
    for (const currentPhase of plan.phases) {
      logger.log(`\n== ${currentPhase.name} ==`)
      const phaseSummary = {
        name: currentPhase.name,
        commands: [],
      }
      summary.phases.push(phaseSummary)
      for (const command of currentPhase.commands) {
        logger.log(`$ ${formatCommand(command)}`)
        const result = runner(command)
        phaseSummary.commands.push({
          label: command.label,
          status: result.status,
        })
        if (result.status !== 0) {
          throw new Error(
            `${command.label} failed with exit code ${result.status}`,
          )
        }
      }
    }
    summary.ok = true
    return summary
  } finally {
    if (!keep) {
      for (const command of plan.cleanup) {
        logger.log(`$ ${formatCommand(command)}`)
        const result = runner(command)
        summary.cleanup.push({
          label: command.label,
          status: result.status,
        })
      }
    }
    summary.durationMs = Date.now() - startedAt
  }
}

function phase(name, commands) {
  return Object.freeze({
    name,
    commands: Object.freeze(commands),
  })
}

function pnpmRun(script, env) {
  return command(`pnpm ${script}`, 'pnpm', [script], env)
}

function dockerComposeUp(composeFiles, env) {
  const args = composeFiles.flatMap((file) => ['-f', file])
  return command(
    `docker compose ${args.join(' ')} up --build -d`,
    'docker',
    ['compose', ...args, 'up', '--build', '-d'],
    env,
  )
}

function dockerComposeRestart(composeFiles, services, env) {
  const args = composeFiles.flatMap((file) => ['-f', file])
  return command(
    `docker compose ${args.join(' ')} restart ${services.join(' ')}`,
    'docker',
    ['compose', ...args, 'restart', ...services],
    env,
  )
}

function dockerComposeStop(composeFiles, services, env) {
  const args = composeFiles.flatMap((file) => ['-f', file])
  return command(
    `docker compose ${args.join(' ')} stop ${services.join(' ')}`,
    'docker',
    ['compose', ...args, 'stop', ...services],
    env,
  )
}

function dockerComposeUpServices(composeFiles, services, env) {
  const args = composeFiles.flatMap((file) => ['-f', file])
  return command(
    `docker compose ${args.join(' ')} up -d ${services.join(' ')}`,
    'docker',
    ['compose', ...args, 'up', '-d', ...services],
    env,
  )
}

function command(label, bin, args, env) {
  return Object.freeze({
    label,
    bin,
    args: Object.freeze(args),
    env,
  })
}

function runCommand(commandToRun) {
  return spawnSync(commandToRun.bin, commandToRun.args, {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      ...commandToRun.env,
    },
    stdio: 'inherit',
  })
}

function formatCommand(commandToRun) {
  const env = Object.entries(commandToRun.env)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  return `${env} ${commandToRun.label}`
}

function parsePort(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0 || number > 65_535) {
    throw new Error(`${label} must be an integer between 1 and 65535`)
  }
  return number
}

function main() {
  const options = parseDualContainerSuiteOptions()
  const plan = buildDualContainerSuitePlan(options)
  if (options.dryRun) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }

  const summary = runDualContainerSuite({
    plan,
    keep: options.keep,
  })
  console.log(JSON.stringify(summary, null, 2))
  if (!summary.ok) {
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
