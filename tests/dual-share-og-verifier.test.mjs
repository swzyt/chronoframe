import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import sharp from 'sharp'

import {
  SHARE_OG_CASES,
  SHARE_OG_ROUTE_IDS,
  compareRenderedPNGs,
  parseShareOGVerifierOptions,
} from '../scripts/verify-dual-share-og.mjs'

test('share-OG verifier owns the final Go route and promotes it to verified', () => {
  const contract = JSON.parse(
    readFileSync(
      new URL('../backend/contracts/routes.yaml', import.meta.url),
      'utf8',
    ),
  )
  assert.deepEqual(SHARE_OG_ROUTE_IDS, ['media.share-og'])
  assert.equal(
    contract.routes.find((route) => route.id === 'media.share-og')?.maturity.go,
    'verified',
  )
  assert.deepEqual(
    contract.routes.filter((route) => route.maturity.go === 'experimental'),
    [],
  )
})

test('share-OG gate covers rendering, authorization, switching, and cleanup', () => {
  for (const fragment of [
    'real image',
    'video thumbnail',
    'fallback',
    'preview access',
    'PNG suffix',
    'gateway switching',
    'pixel-level',
    'cleanup',
  ]) {
    assert.ok(
      SHARE_OG_CASES.some((entry) => entry.includes(fragment)),
      `missing share-OG coverage for ${fragment}`,
    )
  }
})

test('share-OG verifier defaults to the shared production services', () => {
  assert.deepEqual(
    parseShareOGVerifierOptions([], {
      CFRAME_DUAL_PORT: '33125',
      CFRAME_DUAL_REDIS_PORT: '36425',
    }),
    {
      base: 'http://127.0.0.1:33125',
      nodeURL: 'http://127.0.0.1:33125',
      goURL: 'http://127.0.0.1:33125/__lab/go',
      databasePath: path.resolve('./data/app.sqlite3'),
      dataRoot: path.resolve('./data'),
      redisURL: 'redis://127.0.0.1:36425/0',
      redisPassword: 'chronoframe-development-only-change-me',
      settingsVersionKey: 'chronoframe:settings:version',
      timeoutMs: 10000,
      maxVisualMAE: 8,
      prefix: 'dual-share-og',
    },
  )
})

test('share-OG pixel comparator reports identical rendered images', async () => {
  const fixture = await sharp({
    create: {
      width: 1200,
      height: 600,
      channels: 3,
      background: '#09090b',
    },
  })
    .png()
    .toBuffer()
  const result = await compareRenderedPNGs(fixture, fixture)
  assert.equal(result.mae, 0)
  assert.equal(result.maximumDifference, 0)
})
