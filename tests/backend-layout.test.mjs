import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const exists = (path) => existsSync(`${root}/${path}`)

test('all backend implementations live under backend', () => {
  assert.equal(exists('server'), false, 'root server/ must not be recreated')
  assert.equal(exists('backend/nodejs/api'), true)
  assert.equal(exists('backend/nodejs/database/migrations'), true)
  assert.equal(exists('backend/go/cmd/api/main.go'), true)
  assert.equal(exists('backend/go/internal'), true)
  assert.equal(exists('backend/contracts/routes.yaml'), true)
})

test('Nuxt maps its server directory to the Node.js backend', () => {
  const nuxtConfig = readFileSync(`${root}/nuxt.config.ts`, 'utf8')
  assert.match(nuxtConfig, /serverDir:\s*['"]backend\/nodejs['"]/)
})

test('shared fixtures stay outside language-specific modules', () => {
  assert.equal(exists('backend/contracts/settings-number-fixtures.json'), true)
  assert.equal(exists('backend/go/contracts'), false)
  assert.equal(exists('backend/nodejs/contracts'), false)
})

test('build and database configuration use the consolidated paths', () => {
  const packageJson = readFileSync(`${root}/package.json`, 'utf8')
  const goDockerfile = readFileSync(`${root}/backend/go/Dockerfile`, 'utf8')
  const nodeDockerfile = readFileSync(`${root}/Dockerfile`, 'utf8')
  const dualCompose = readFileSync(`${root}/deploy/dual/compose.yaml`, 'utf8')

  assert.match(packageJson, /backend\/nodejs\/drizzle\.config\.ts/)
  assert.match(
    packageJson,
    /docker build --target test -f backend\/go\/Dockerfile[^\n]+ \./,
  )
  assert.match(goDockerfile, /go build[^\n]+\.\/cmd\/api/)
  assert.match(
    goDockerfile,
    /COPY backend\/contracts \/src\/backend\/contracts/,
  )
  assert.match(nodeDockerfile, /backend\/nodejs\/database\/migrations/)
  assert.match(dualCompose, /dockerfile: backend\/go\/Dockerfile/)
})
