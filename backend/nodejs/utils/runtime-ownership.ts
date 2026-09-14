export const RUNTIME_OWNERS = ['node', 'go', 'none'] as const

export type RuntimeOwner = (typeof RUNTIME_OWNERS)[number]

export type RuntimeOwnershipEnvironment = Readonly<
  Record<string, string | undefined>
>

export interface RuntimeOwnership {
  dbMigrator: RuntimeOwner
  pipelineConsumer: RuntimeOwner
  backupScheduler: RuntimeOwner
}

const runtimeOwnerSet = new Set<string>(RUNTIME_OWNERS)

export function parseRuntimeOwner(
  variableName: string,
  rawValue: string | undefined,
  defaultOwner: RuntimeOwner = 'node',
): RuntimeOwner {
  const value = rawValue === undefined ? defaultOwner : rawValue

  if (!runtimeOwnerSet.has(value)) {
    throw new Error(
      `Invalid ${variableName} value ${JSON.stringify(value)}; expected one of: ${RUNTIME_OWNERS.join(', ')}`,
    )
  }

  return value as RuntimeOwner
}

export function resolveRuntimeOwnership(
  environment: RuntimeOwnershipEnvironment = process.env,
): RuntimeOwnership {
  return {
    dbMigrator: parseRuntimeOwner(
      'CFRAME_DB_MIGRATOR',
      environment.CFRAME_DB_MIGRATOR,
    ),
    pipelineConsumer: parseRuntimeOwner(
      'CFRAME_PIPELINE_CONSUMER',
      environment.CFRAME_PIPELINE_CONSUMER,
    ),
    backupScheduler: parseRuntimeOwner(
      'CFRAME_BACKUP_SCHEDULER',
      environment.CFRAME_BACKUP_SCHEDULER,
    ),
  }
}

/** Eagerly validated once during server module loading so invalid values abort startup. */
export const runtimeOwnership: Readonly<RuntimeOwnership> = Object.freeze(
  resolveRuntimeOwnership(),
)

export function isNodeOwner(owner: RuntimeOwner): boolean {
  return owner === 'node'
}
