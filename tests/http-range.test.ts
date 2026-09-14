import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isHTTPDateNotModified,
  parseHTTPByteRange,
  shouldServeHTTPByteRange,
} from '../backend/nodejs/utils/http-range'

test('HTTP byte range parser supports closed, open-ended and suffix ranges', () => {
  assert.deepEqual(parseHTTPByteRange('bytes=0-9', 100), {
    type: 'ok',
    start: 0,
    end: 9,
  })
  assert.deepEqual(parseHTTPByteRange('bytes=90-', 100), {
    type: 'ok',
    start: 90,
    end: 99,
  })
  assert.deepEqual(parseHTTPByteRange('bytes=-10', 100), {
    type: 'ok',
    start: 90,
    end: 99,
  })
  assert.deepEqual(parseHTTPByteRange('bytes=-200', 100), {
    type: 'ok',
    start: 0,
    end: 99,
  })
  assert.deepEqual(parseHTTPByteRange('bytes=90-200', 100), {
    type: 'ok',
    start: 90,
    end: 99,
  })
})

test('HTTP byte range parser rejects invalid and unsatisfiable ranges', () => {
  assert.deepEqual(parseHTTPByteRange('bytes=10-9', 100), {
    type: 'unsatisfiable',
  })
  assert.deepEqual(parseHTTPByteRange('bytes=100-', 100), {
    type: 'unsatisfiable',
  })
  assert.deepEqual(parseHTTPByteRange('bytes=-0', 100), {
    type: 'unsatisfiable',
  })
  assert.deepEqual(parseHTTPByteRange('bytes=0-1,4-5', 100), {
    type: 'invalid',
  })
  assert.deepEqual(parseHTTPByteRange('items=0-1', 100), { type: 'invalid' })
  assert.deepEqual(parseHTTPByteRange('bytes=-1', 0), {
    type: 'unsatisfiable',
  })
})

test('HTTP If-Range validator gates range responses by etag or HTTP date', () => {
  const lastModified = new Date('2026-09-11T21:03:51.735Z')
  assert.equal(
    shouldServeHTTPByteRange(undefined, 'W/"70-demo"', lastModified),
    true,
  )
  assert.equal(
    shouldServeHTTPByteRange('W/"70-demo"', 'W/"70-demo"', lastModified),
    true,
  )
  assert.equal(
    shouldServeHTTPByteRange('W/"stale"', 'W/"70-demo"', lastModified),
    false,
  )
  assert.equal(
    shouldServeHTTPByteRange(
      'Fri, 11 Sep 2026 21:03:51 GMT',
      'W/"70-demo"',
      lastModified,
    ),
    true,
  )
  assert.equal(
    shouldServeHTTPByteRange(
      'Fri, 11 Sep 2026 21:03:50 GMT',
      'W/"70-demo"',
      lastModified,
    ),
    false,
  )
  assert.equal(
    shouldServeHTTPByteRange('not a date', 'W/"70-demo"', lastModified),
    false,
  )
})

test('HTTP If-Modified-Since comparison uses HTTP second precision', () => {
  const lastModified = new Date('2026-09-11T21:03:51.735Z')
  assert.equal(
    isHTTPDateNotModified('Fri, 11 Sep 2026 21:03:51 GMT', lastModified),
    true,
  )
  assert.equal(
    isHTTPDateNotModified('Fri, 11 Sep 2026 21:03:50 GMT', lastModified),
    false,
  )
})
