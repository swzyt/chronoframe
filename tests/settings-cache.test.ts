import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SETTINGS_CACHE_VERSION_KEY,
  DEFAULT_SETTINGS_CACHE_TTL_MS,
  ExpiringCache,
  parseSettingsCacheVersionKey,
  parseSettingsCacheTtlMs,
  resolveSettingsCacheVersionKey,
  resolveSettingsCacheTtlMs,
} from '../backend/nodejs/utils/settings-cache'

test('settings cache TTL defaults to five seconds when unset', () => {
  assert.equal(parseSettingsCacheTtlMs(undefined), 5_000)
  assert.equal(DEFAULT_SETTINGS_CACHE_TTL_MS, 5_000)
  assert.equal(resolveSettingsCacheTtlMs({}), 5_000)
})

test('settings cache TTL accepts only strict positive base-10 integers', () => {
  assert.equal(parseSettingsCacheTtlMs('1'), 1)
  assert.equal(parseSettingsCacheTtlMs('12345'), 12_345)

  for (const invalid of [
    '',
    '0',
    '-1',
    '+1',
    '01',
    '1.5',
    '1e3',
    ' 5000',
    '5000 ',
    String(Number.MAX_SAFE_INTEGER + 1),
  ]) {
    assert.throws(
      () => parseSettingsCacheTtlMs(invalid),
      /Invalid CFRAME_SETTINGS_CACHE_TTL_MS value/,
    )
  }
})

test('settings cache shared version key defaults and trims custom values', () => {
  assert.equal(
    parseSettingsCacheVersionKey(undefined),
    'chronoframe:settings:version',
  )
  assert.equal(
    DEFAULT_SETTINGS_CACHE_VERSION_KEY,
    'chronoframe:settings:version',
  )
  assert.equal(
    resolveSettingsCacheVersionKey({}),
    'chronoframe:settings:version',
  )
  assert.equal(
    parseSettingsCacheVersionKey(' chronoframe:test-settings-version '),
    'chronoframe:test-settings-version',
  )

  for (const invalid of ['', '   ']) {
    assert.throws(
      () => parseSettingsCacheVersionKey(invalid),
      /Invalid CFRAME_SETTINGS_CACHE_VERSION_KEY value/,
    )
  }
})

test('expiring cache returns fresh values including null', () => {
  let now = 1_000
  const cache = new ExpiringCache<string, string | null>(5_000, () => now)

  assert.deepEqual(cache.get('missing'), { hit: false })
  cache.set('nullable', null)
  now = 5_999
  assert.deepEqual(cache.get('nullable'), { hit: true, value: null })
})

test('expiring cache misses at the TTL boundary and thereafter', () => {
  let now = 10_000
  const cache = new ExpiringCache<string, string>(5_000, () => now)

  cache.set('theme', 'dark')
  now = 15_000
  assert.deepEqual(cache.get('theme'), { hit: false })
  now = 14_000
  assert.deepEqual(cache.get('theme'), { hit: false })
})

test('setting a value refreshes both its value and TTL', () => {
  let now = 100
  const cache = new ExpiringCache<string, string>(50, () => now)

  cache.set('theme', 'dark')
  now = 140
  cache.set('theme', 'light')
  now = 175
  assert.deepEqual(cache.get('theme'), { hit: true, value: 'light' })
  now = 190
  assert.deepEqual(cache.get('theme'), { hit: false })
})

test('expiring cache can be cleared when shared version changes', () => {
  const cache = new ExpiringCache<string, string>(5_000)

  cache.set('app:slogan', 'cached')
  assert.deepEqual(cache.get('app:slogan'), { hit: true, value: 'cached' })
  cache.clear()
  assert.deepEqual(cache.get('app:slogan'), { hit: false })
})

test('expiring cache rejects invalid constructor TTLs', () => {
  for (const ttlMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new ExpiringCache(ttlMs),
      /ttlMs must be a positive safe integer/,
    )
  }
})
