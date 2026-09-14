#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..')
const ROUTE_MANIFEST_PATH = path.join(
  REPOSITORY_ROOT,
  'backend/contracts/routes.yaml',
)
const OPENAPI_PATH = path.join(
  REPOSITORY_ROOT,
  'backend/contracts/openapi.yaml',
)
const ROUTE_SCHEMA_PATH = path.join(
  REPOSITORY_ROOT,
  'backend/contracts/routes.schema.json',
)

const HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
])
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const MATURITY_LEVELS = new Set(['experimental', 'verified', 'stable'])
const OWNERS = new Set(['node', 'go'])
const SOURCE_TYPES = new Set(['filesystem', 'framework', 'virtual'])
const NODE_SERVER_DIRECTORY = 'backend/nodejs'

// Nitro treats a handler without a method suffix as an ANY route. The current
// handlers deliberately implement only these methods; the contract rejects all
// other verbs instead of silently blessing the framework fallback.
const UNSUFFIXED_METHODS = new Map([
  [
    'backend/nodejs/api/photos/[photoId]/reactions.ts',
    ['GET', 'POST', 'DELETE'],
  ],
  ['backend/nodejs/api/queue/stats/index.ts', ['GET']],
  ['backend/nodejs/api/system/logs.ts', ['GET']],
  ['backend/nodejs/api/system/settings/[namespace]/[key].ts', ['GET', 'PUT']],
  [
    'backend/nodejs/api/system/settings/storage-config/[id].ts',
    ['GET', 'PUT', 'DELETE'],
  ],
  [
    'backend/nodejs/api/system/settings/storage-config/index.ts',
    ['GET', 'POST'],
  ],
])

const FRAMEWORK_ROUTES = [
  {
    method: 'GET',
    path: '/api/_auth/session',
    source: 'nuxt-auth-utils@0.5.29:dist/runtime/server/api/session.get.js',
  },
  {
    method: 'DELETE',
    path: '/api/_auth/session',
    source: 'nuxt-auth-utils@0.5.29:dist/runtime/server/api/session.delete.js',
  },
]

const REQUIRED_OWNERSHIP_FIELDS = [
  'id',
  'method',
  'path',
  'source',
  'sourceType',
  'capability',
  'owner',
  'sideEffect',
  'auth',
  'maturity',
  'allowCompare',
  'allowShadow',
  'userSelectable',
]

const problems = []

function report(condition, message) {
  if (!condition) problems.push(message)
}

function sourceLocation(source, offset) {
  const prefix = source.slice(0, offset)
  const lines = prefix.split('\n')
  return {
    line: lines.length,
    column: lines.at(-1).length + 1,
  }
}

function formatJsonPath(pathSegments) {
  return pathSegments.reduce((path, segment) => {
    if (typeof segment === 'number') return `${path}[${segment}]`
    if (/^[A-Za-z_$][\w$]*$/.test(segment)) return `${path}.${segment}`
    return `${path}[${JSON.stringify(segment)}]`
  }, '$')
}

export function findDuplicateJsonObjectKeys(source) {
  const duplicates = []
  let index = 0

  function fail(message) {
    const { line, column } = sourceLocation(source, index)
    throw new Error(`${line}:${column}: ${message}`)
  }

  function skipWhitespace() {
    while (index < source.length && /\s/.test(source[index])) index += 1
  }

  function parseString() {
    if (source[index] !== '"') fail('expected JSON string')
    index += 1
    let value = ''
    while (index < source.length) {
      const char = source[index]
      index += 1
      if (char === '"') return value
      if (char === '\\') {
        if (index >= source.length) fail('unterminated string escape')
        const escape = source[index]
        index += 1
        if (escape === 'u') {
          const hex = source.slice(index, index + 4)
          if (!/^[\da-fA-F]{4}$/.test(hex)) fail('invalid unicode escape')
          value += String.fromCharCode(Number.parseInt(hex, 16))
          index += 4
        } else if (escape === '"' || escape === '\\' || escape === '/') {
          value += escape
        } else if (escape === 'b') {
          value += '\b'
        } else if (escape === 'f') {
          value += '\f'
        } else if (escape === 'n') {
          value += '\n'
        } else if (escape === 'r') {
          value += '\r'
        } else if (escape === 't') {
          value += '\t'
        } else {
          fail(`invalid string escape \\${escape}`)
        }
        continue
      }
      if (char.charCodeAt(0) < 0x20) fail('unescaped control character')
      value += char
    }
    fail('unterminated JSON string')
  }

  function parseNumber() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      source.slice(index),
    )
    if (!match) fail('expected JSON number')
    index += match[0].length
  }

  function parseKeyword(keyword) {
    if (!source.startsWith(keyword, index)) fail(`expected ${keyword}`)
    index += keyword.length
  }

  function parseArray(pathSegments) {
    index += 1
    skipWhitespace()
    if (source[index] === ']') {
      index += 1
      return
    }

    let itemIndex = 0
    while (index < source.length) {
      parseValue([...pathSegments, itemIndex])
      itemIndex += 1
      skipWhitespace()
      if (source[index] === ',') {
        index += 1
        skipWhitespace()
        continue
      }
      if (source[index] === ']') {
        index += 1
        return
      }
      fail('expected , or ]')
    }
    fail('unterminated array')
  }

  function parseObject(pathSegments) {
    index += 1
    skipWhitespace()
    const keys = new Map()
    if (source[index] === '}') {
      index += 1
      return
    }

    while (index < source.length) {
      const keyOffset = index
      const key = parseString()
      const firstOffset = keys.get(key)
      if (firstOffset !== undefined) {
        duplicates.push({
          path: formatJsonPath(pathSegments),
          key,
          first: sourceLocation(source, firstOffset),
          duplicate: sourceLocation(source, keyOffset),
        })
      } else {
        keys.set(key, keyOffset)
      }

      skipWhitespace()
      if (source[index] !== ':') fail('expected :')
      index += 1
      parseValue([...pathSegments, key])
      skipWhitespace()
      if (source[index] === ',') {
        index += 1
        skipWhitespace()
        continue
      }
      if (source[index] === '}') {
        index += 1
        return
      }
      fail('expected , or }')
    }
    fail('unterminated object')
  }

  function parseValue(pathSegments) {
    skipWhitespace()
    const char = source[index]
    if (char === '{') return parseObject(pathSegments)
    if (char === '[') return parseArray(pathSegments)
    if (char === '"') {
      parseString()
      return
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      parseNumber()
      return
    }
    if (char === 't') return parseKeyword('true')
    if (char === 'f') return parseKeyword('false')
    if (char === 'n') return parseKeyword('null')
    fail('expected JSON value')
  }

  parseValue([])
  skipWhitespace()
  if (index !== source.length) fail('unexpected trailing content')
  return duplicates
}

export function assertNoDuplicateJsonObjectKeys(source, relative) {
  const duplicates = findDuplicateJsonObjectKeys(source)
  if (duplicates.length === 0) return

  const details = duplicates
    .map(
      (duplicate) =>
        `- ${duplicate.path}: key ${JSON.stringify(duplicate.key)} first at ` +
        `${duplicate.first.line}:${duplicate.first.column}, duplicate at ` +
        `${duplicate.duplicate.line}:${duplicate.duplicate.column}`,
    )
    .join('\n')
  throw new Error(`${relative} contains duplicate object keys:\n${details}`)
}

async function readJsonCompatibleYaml(filename) {
  const relative = path.relative(REPOSITORY_ROOT, filename)
  let source
  try {
    source = await readFile(filename, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${relative}: ${error.message}`)
  }
  try {
    const parsed = JSON.parse(source)
    assertNoDuplicateJsonObjectKeys(source, relative)
    return parsed
  } catch (error) {
    throw new Error(
      `${relative} must use the JSON-compatible subset of YAML 1.2: ${error.message}`,
    )
  }
}

async function walkTypescriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkTypescriptFiles(filename)))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(filename)
    }
  }
  return files.sort()
}

function manifestPathForSource(source, method) {
  const apiPrefix = `${NODE_SERVER_DIRECTORY}/api/`
  const routePrefix = `${NODE_SERVER_DIRECTORY}/routes/`
  const prefix = source.startsWith(apiPrefix)
    ? apiPrefix
    : source.startsWith(routePrefix)
      ? routePrefix
      : null
  if (!prefix) throw new Error(`unsupported filesystem route source: ${source}`)

  let stem = source.slice(prefix.length)
  const suffix = `.${method.toLowerCase()}.ts`
  stem = stem.endsWith(suffix)
    ? stem.slice(0, -suffix.length)
    : stem.slice(0, -'.ts'.length)

  const segments = stem.split('/')
  if (segments.at(-1) === 'index') segments.pop()
  const normalized = segments.map((segment) => {
    const catchAll = /^\[\.\.\.([^\]]+)\]$/.exec(segment)
    if (catchAll) return `{${catchAll[1]}}`
    const parameter = /^\[([^\]]+)\](.*)$/.exec(segment)
    if (parameter) return `{${parameter[1]}}${parameter[2]}`
    return segment
  })

  const base = prefix === apiPrefix ? '/api' : ''
  return `${base}/${normalized.join('/')}`
}

function routeKey(method, routePath) {
  return `${String(method).toUpperCase()} ${String(routePath)}`
}

async function expectedCurrentRoutes() {
  const expected = new Map()
  const sourceRoots = [
    path.join(REPOSITORY_ROOT, NODE_SERVER_DIRECTORY, 'api'),
    path.join(REPOSITORY_ROOT, NODE_SERVER_DIRECTORY, 'routes'),
  ]

  for (const sourceRoot of sourceRoots) {
    for (const filename of await walkTypescriptFiles(sourceRoot)) {
      const source = path
        .relative(REPOSITORY_ROOT, filename)
        .split(path.sep)
        .join('/')
      const methodMatch =
        /\.(get|post|put|patch|delete|head|options)\.ts$/i.exec(source)
      const methods = methodMatch
        ? [methodMatch[1].toUpperCase()]
        : UNSUFFIXED_METHODS.get(source)

      if (!methods) {
        problems.push(
          `${source} has no method suffix and no intentional-method mapping in ${path.relative(REPOSITORY_ROOT, fileURLToPath(import.meta.url))}`,
        )
        continue
      }

      for (const method of methods) {
        const routePath = manifestPathForSource(source, method)
        const key = routeKey(method, routePath)
        report(!expected.has(key), `filesystem exposes duplicate route ${key}`)
        expected.set(key, { method, path: routePath, source })
      }
    }
  }

  for (const route of FRAMEWORK_ROUTES) {
    const key = routeKey(route.method, route.path)
    report(!expected.has(key), `framework exposes duplicate route ${key}`)
    expected.set(key, route)
  }
  return expected
}

function validateMaturity(item, label) {
  report(
    item.maturity &&
      typeof item.maturity === 'object' &&
      !Array.isArray(item.maturity),
    `${label}.maturity must be an object`,
  )
  if (!item.maturity || typeof item.maturity !== 'object') return

  const implementations = Object.keys(item.maturity)
  report(implementations.length > 0, `${label}.maturity must not be empty`)
  for (const implementation of implementations) {
    report(
      OWNERS.has(implementation),
      `${label}.maturity has unknown implementation ${implementation}`,
    )
    report(
      MATURITY_LEVELS.has(item.maturity[implementation]),
      `${label}.maturity.${implementation} has invalid value ${String(item.maturity[implementation])}`,
    )
  }
  report(
    Boolean(item.maturity[item.owner]),
    `${label}.maturity must describe its current owner ${item.owner}`,
  )
}

function validateOwnershipFields(item, label) {
  for (const field of REQUIRED_OWNERSHIP_FIELDS) {
    report(Object.hasOwn(item, field), `${label} is missing ${field}`)
  }
  for (const field of [
    'id',
    'method',
    'path',
    'source',
    'sourceType',
    'capability',
    'owner',
    'sideEffect',
    'auth',
  ]) {
    report(
      typeof item[field] === 'string' && item[field].length > 0,
      `${label}.${field} must be a non-empty string`,
    )
  }
  for (const field of ['allowCompare', 'allowShadow', 'userSelectable']) {
    report(
      typeof item[field] === 'boolean',
      `${label}.${field} must be a boolean`,
    )
  }
  report(OWNERS.has(item.owner), `${label}.owner must be node or go`)
  validateMaturity(item, label)
}

async function sourceExists(source) {
  if (
    typeof source !== 'string' ||
    path.isAbsolute(source) ||
    source.split('/').includes('..')
  ) {
    return false
  }
  try {
    return (await stat(path.join(REPOSITORY_ROOT, source))).isFile()
  } catch {
    return false
  }
}

async function validateManifest(manifest, expected) {
  report(manifest.version === 1, 'routes.yaml version must be 1')
  report(
    OWNERS.has(manifest.defaultReadOwner),
    'routes.yaml defaultReadOwner must be node or go',
  )
  report(Array.isArray(manifest.routes), 'routes.yaml routes must be an array')
  report(Array.isArray(manifest.actors), 'routes.yaml actors must be an array')
  if (!Array.isArray(manifest.routes) || !Array.isArray(manifest.actors)) return

  const routesByKey = new Map()
  const routesById = new Map()
  const routesByOperationId = new Map()
  const mutationOwnersByCapability = new Map()

  for (const [index, route] of manifest.routes.entries()) {
    const label = `routes[${index}]${route?.id ? ` (${route.id})` : ''}`
    report(route && typeof route === 'object', `${label} must be an object`)
    if (!route || typeof route !== 'object') continue
    validateOwnershipFields(route, label)
    report(HTTP_METHODS.has(route.method), `${label}.method is not supported`)
    report(SOURCE_TYPES.has(route.sourceType), `${label}.sourceType is invalid`)
    report(
      typeof route.path === 'string' && route.path.startsWith('/'),
      `${label}.path must start with /`,
    )
    report(
      route.path === '/' ||
        (typeof route.path === 'string' && !route.path.endsWith('/')),
      `${label}.path must not have a trailing slash`,
    )
    report(
      typeof route.openapiOperationId === 'string' &&
        route.openapiOperationId.length > 0,
      `${label}.openapiOperationId must be a non-empty string`,
    )

    const key = routeKey(route.method, route.path)
    report(
      !routesByKey.has(key),
      `${key} appears more than once in routes.yaml`,
    )
    report(
      !routesById.has(route.id),
      `route id ${route.id} appears more than once in routes.yaml`,
    )
    report(
      !routesByOperationId.has(route.openapiOperationId),
      `OpenAPI operationId ${route.openapiOperationId} appears more than once in routes.yaml`,
    )
    routesByKey.set(key, route)
    routesById.set(route.id, route)
    routesByOperationId.set(route.openapiOperationId, route)

    const isMutation = !READ_METHODS.has(route.method)
    const hasSideEffect = route.sideEffect !== 'none'
    if (isMutation) {
      report(
        OWNERS.has(route.owner),
        `${key} is a mutation and must have an explicit owner`,
      )
      report(route.allowCompare === false, `${key} mutation cannot compare`)
      report(route.allowShadow === false, `${key} mutation cannot shadow`)
      report(
        route.userSelectable === false,
        `${key} mutation cannot be user-selectable`,
      )
      const priorOwner = mutationOwnersByCapability.get(route.capability)
      report(
        !priorOwner || priorOwner === route.owner,
        `${route.capability} mutations have conflicting owners ${priorOwner} and ${route.owner}`,
      )
      mutationOwnersByCapability.set(route.capability, route.owner)
    }
    if (hasSideEffect) {
      report(
        route.allowCompare === false,
        `${key} has side effects and cannot compare`,
      )
      report(
        route.allowShadow === false,
        `${key} has side effects and cannot shadow`,
      )
      report(
        route.userSelectable === false,
        `${key} has side effects and cannot be user-selectable`,
      )
    }
    if (route.allowShadow || route.allowCompare || route.userSelectable) {
      report(
        route.method === 'GET' && route.sideEffect === 'none',
        `${key} experimental routing is allowed only for side-effect-free GET routes`,
      )
      report(
        Boolean(route.maturity?.node && route.maturity?.go),
        `${key} experimental routing requires maturity for both implementations`,
      )
    }
    if (route.userSelectable) {
      report(
        route.allowCompare && route.allowShadow,
        `${key} user selection requires compare and shadow eligibility`,
      )
    }

    if (route.sourceType === 'filesystem' || route.sourceType === 'virtual') {
      report(
        await sourceExists(route.source),
        `${label}.source does not exist: ${route.source}`,
      )
    }
  }

  report(
    expected.size === 86,
    `filesystem/framework inventory changed: expected the audited 86 operations, found ${expected.size}`,
  )
  for (const [key, route] of expected) {
    const declared = routesByKey.get(key)
    report(
      Boolean(declared),
      `${key} (${route.source}) is missing from routes.yaml`,
    )
    if (declared) {
      report(
        declared.source === route.source,
        `${key} source mismatch: routes.yaml has ${declared.source}, filesystem/framework contract has ${route.source}`,
      )
      report(
        declared.sourceType ===
          (route.source.startsWith('nuxt-auth-utils@')
            ? 'framework'
            : 'filesystem'),
        `${key} has the wrong sourceType`,
      )
    }
  }
  for (const [key, route] of routesByKey) {
    if (route.sourceType === 'filesystem' || route.sourceType === 'framework') {
      report(
        expected.has(key),
        `${key} is declared as ${route.sourceType} but has no current route source`,
      )
    }
  }

  const actorsById = new Map()
  const requiredActors = new Set([
    'db-migrator',
    'pipeline-consumer',
    'backup-scheduler',
  ])
  for (const [index, actor] of manifest.actors.entries()) {
    const label = `actors[${index}]${actor?.id ? ` (${actor.id})` : ''}`
    report(actor && typeof actor === 'object', `${label} must be an object`)
    if (!actor || typeof actor !== 'object') continue
    validateOwnershipFields(actor, label)
    report(actor.method === 'ACTOR', `${label}.method must be ACTOR`)
    report(
      actor.path === `actor://${actor.id}`,
      `${label}.path must match its id`,
    )
    report(
      actor.sourceType === 'runtime',
      `${label}.sourceType must be runtime`,
    )
    report(actor.auth === 'internal', `${label}.auth must be internal`)
    report(
      actor.sideEffect !== 'none',
      `${label} must declare its side effects`,
    )
    report(actor.allowCompare === false, `${label} cannot compare`)
    report(actor.allowShadow === false, `${label} cannot shadow`)
    report(actor.userSelectable === false, `${label} cannot be user-selectable`)
    report(
      !actorsById.has(actor.id),
      `actor id ${actor.id} appears more than once`,
    )
    actorsById.set(actor.id, actor)
    report(
      await sourceExists(actor.source),
      `${label}.source does not exist: ${actor.source}`,
    )
  }
  for (const actor of requiredActors) {
    report(actorsById.has(actor), `required runtime actor ${actor} is missing`)
  }

  return { routesByKey, routesById }
}

function resolveLocalReference(document, reference) {
  if (!reference.startsWith('#/')) return undefined
  return reference
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, part) => value?.[part], document)
}

function validateReferences(document, value, location = '#') {
  if (!value || typeof value !== 'object') return
  if (typeof value.$ref === 'string') {
    report(
      Boolean(resolveLocalReference(document, value.$ref)),
      `${location} has unresolved reference ${value.$ref}`,
    )
  }
  for (const [key, child] of Object.entries(value)) {
    validateReferences(document, child, `${location}/${key}`)
  }
}

function operationPathParameterNames(openapi, pathItem, operation) {
  const pathParameters = Array.isArray(pathItem.parameters)
    ? pathItem.parameters
    : []
  const operationParameters = Array.isArray(operation.parameters)
    ? operation.parameters
    : []
  const parameters = [...pathParameters, ...operationParameters]
  return new Set(
    parameters
      .map((parameter) =>
        parameter.$ref
          ? resolveLocalReference(openapi, parameter.$ref)
          : parameter,
      )
      .filter((parameter) => parameter?.in === 'path' && parameter.required)
      .map((parameter) => parameter.name),
  )
}

function validateOpenApi(openapi, manifestRoutesByKey, manifestRoutesById) {
  report(openapi.openapi === '3.1.0', 'openapi.yaml must declare OpenAPI 3.1.0')
  report(
    openapi.paths && typeof openapi.paths === 'object',
    'openapi.yaml paths must be an object',
  )
  if (!openapi.paths || typeof openapi.paths !== 'object') return

  validateReferences(openapi, openapi)
  const operations = new Map()
  const operationIds = new Map()
  for (const [routePath, pathItem] of Object.entries(openapi.paths)) {
    report(
      pathItem && typeof pathItem === 'object' && !Array.isArray(pathItem),
      `${routePath} OpenAPI path item must be an object`,
    )
    if (!pathItem || typeof pathItem !== 'object' || Array.isArray(pathItem)) {
      continue
    }
    for (const [lowerMethod, operation] of Object.entries(pathItem)) {
      const method = lowerMethod.toUpperCase()
      if (!HTTP_METHODS.has(method)) continue
      const key = routeKey(method, routePath)
      report(!operations.has(key), `${key} appears more than once in OpenAPI`)
      report(
        operation && typeof operation === 'object',
        `${key} OpenAPI operation must be an object`,
      )
      if (!operation || typeof operation !== 'object') continue
      report(
        typeof operation.operationId === 'string' &&
          operation.operationId.length > 0,
        `${key} is missing operationId`,
      )
      report(
        !operationIds.has(operation.operationId),
        `OpenAPI operationId ${operation.operationId} appears more than once`,
      )
      report(
        operation.responses && Object.keys(operation.responses).length > 0,
        `${key} is missing responses`,
      )
      operations.set(key, operation)
      operationIds.set(operation.operationId, key)

      const parameters = operationPathParameterNames(
        openapi,
        pathItem,
        operation,
      )
      for (const match of routePath.matchAll(/\{([^}]+)\}/g)) {
        report(
          parameters.has(match[1]),
          `${key} does not declare required path parameter ${match[1]}`,
        )
      }
    }
  }

  for (const [key, route] of manifestRoutesByKey) {
    const operation = operations.get(key)
    report(Boolean(operation), `${key} is missing from openapi.yaml`)
    if (!operation) continue
    report(
      operation.operationId === route.openapiOperationId,
      `${key} operationId mismatch: ${operation.operationId} != ${route.openapiOperationId}`,
    )
    report(
      operation['x-chronoframe-route-id'] === route.id,
      `${key} x-chronoframe-route-id mismatch`,
    )
  }
  for (const [key, operation] of operations) {
    const routeId = operation['x-chronoframe-route-id']
    const route = manifestRoutesById.get(routeId)
    report(
      Boolean(route),
      `${key} references unknown route id ${String(routeId)}`,
    )
    if (route) {
      report(
        routeKey(route.method, route.path) === key,
        `${key} references route id ${routeId} for ${route.method} ${route.path}`,
      )
    }
  }
  report(
    operations.size === manifestRoutesByKey.size,
    `OpenAPI operation count ${operations.size} does not match manifest route count ${manifestRoutesByKey.size}`,
  )

  const schemas = openapi.components?.schemas || {}
  for (const schemaName of [
    'LivenessResponse',
    'ReadinessResponse',
    'VersionResponse',
    'PublicSettingsResponse',
  ]) {
    report(
      Boolean(schemas[schemaName]),
      `OpenAPI schema ${schemaName} is missing`,
    )
  }
  report(
    schemas.LivenessResponse?.properties?.status?.const === 'ok',
    'LivenessResponse must require status=ok',
  )
  report(
    schemas.ReadinessResponse?.properties?.status?.enum?.includes('not_ready'),
    'ReadinessResponse must describe the not_ready state',
  )
  report(
    schemas.VersionResponse?.properties?.backend?.const === 'go',
    'VersionResponse must identify the Go backend',
  )
  report(
    schemas.PublicSettingsResponse?.required?.includes('timestamp') &&
      schemas.PublicSettingsResponse?.required?.includes('data') &&
      schemas.PublicSettingsResponse?.properties?.timestamp?.format === 'int64',
    'PublicSettingsResponse must require timestamp (int64 milliseconds) and data',
  )
}

async function main() {
  let manifest
  let openapi
  let routeSchema
  try {
    ;[manifest, openapi, routeSchema] = await Promise.all([
      readJsonCompatibleYaml(ROUTE_MANIFEST_PATH),
      readJsonCompatibleYaml(OPENAPI_PATH),
      readJsonCompatibleYaml(ROUTE_SCHEMA_PATH),
    ])
  } catch (error) {
    console.error(`route contract verification failed:\n- ${error.message}`)
    process.exitCode = 1
    return
  }

  const expected = await expectedCurrentRoutes()
  report(
    routeSchema?.$schema === 'https://json-schema.org/draft/2020-12/schema' &&
      Boolean(routeSchema?.$defs?.route) &&
      Boolean(routeSchema?.$defs?.actor),
    'routes.schema.json must be a Draft 2020-12 schema for routes and actors',
  )
  const manifestIndex = await validateManifest(manifest, expected)
  if (manifestIndex) {
    validateOpenApi(
      openapi,
      manifestIndex.routesByKey,
      manifestIndex.routesById,
    )
  }

  if (problems.length > 0) {
    console.error(
      `route contract verification failed (${problems.length} problem${problems.length === 1 ? '' : 's'}):`,
    )
    for (const problem of problems) console.error(`- ${problem}`)
    process.exitCode = 1
    return
  }

  const virtualCount = manifest.routes.filter(
    (route) => route.sourceType === 'virtual',
  ).length
  console.log(
    `route contract verified: ${manifest.routes.length} routes ` +
      `(${expected.size} filesystem/framework intents + ${virtualCount} virtual), ` +
      `${manifest.actors.length} runtime actors, ${manifest.routes.length} OpenAPI operations`,
  )
}

await main()
