import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  decodeSettingValue,
  encodeSettingValue,
  InvalidSettingValueError,
  JSON_NUMBER_PATTERN,
} from '../backend/nodejs/utils/settings-value'

type NumberFixture = {
  name: string
  stored: string
  valid: boolean
  decoded: number | null
  canonical: string | null
}

const fixtures = JSON.parse(
  readFileSync(
    new URL(
      '../backend/contracts/settings-number-fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  contract: { storageGrammar: string }
  cases: NumberFixture[]
}

test('Node uses the number grammar declared by the shared contract', () => {
  assert.equal(JSON_NUMBER_PATTERN.source, fixtures.contract.storageGrammar)
})

test('Node number reads conform to the shared cross-language fixtures', () => {
  for (const fixture of fixtures.cases) {
    assert.equal(
      decodeSettingValue('number', fixture.stored),
      fixture.decoded,
      fixture.name,
    )
  }
})

test('finite number writes use the fixture canonical representations', () => {
  for (const fixture of fixtures.cases.filter((entry) => entry.valid)) {
    const encoded = encodeSettingValue('number', fixture.decoded)
    assert.equal(encoded.stored, fixture.canonical, fixture.name)
    assert.equal(encoded.value, fixture.decoded, fixture.name)
  }
})

test('number writes reject numeric strings regardless of their lexical form', () => {
  for (const input of ['0x10', ' ', '1e3', 'Infinity', 'NaN', '', '12.5']) {
    assert.throws(
      () => encodeSettingValue('number', input),
      InvalidSettingValueError,
      JSON.stringify(input),
    )
  }
})

test('number writes reject non-finite JavaScript numbers', () => {
  for (const input of [Number.NaN, Number.POSITIVE_INFINITY, -Infinity]) {
    assert.throws(
      () => encodeSettingValue('number', input),
      /finite JSON number/,
    )
  }
})

test('negative zero has one canonical storage and read representation', () => {
  assert.deepEqual(encodeSettingValue('number', -0), {
    value: 0,
    stored: '0',
  })
  assert.equal(Object.is(decodeSettingValue('number', '-0'), -0), false)
})

test('other setting types reject mismatched values and serialize canonically', () => {
  assert.deepEqual(encodeSettingValue('string', 'null'), {
    value: 'null',
    stored: 'null',
  })
  assert.equal(decodeSettingValue('string', 'null'), 'null')
  assert.deepEqual(encodeSettingValue('boolean', true), {
    value: true,
    stored: 'true',
  })
  assert.equal(decodeSettingValue('boolean', '1'), null)
  assert.throws(() => encodeSettingValue('boolean', 1), /JSON boolean/)
  assert.deepEqual(
    encodeSettingValue('json', { zoom: 3, layers: ['photos'] }),
    {
      value: { zoom: 3, layers: ['photos'] },
      stored: '{"zoom":3,"layers":["photos"]}',
    },
  )
  assert.equal(decodeSettingValue('json', '{broken'), null)
})

test('JSON setting writes reject lossy and non-object values', () => {
  assert.throws(() => encodeSettingValue('json', [1, 2]), /JSON-compatible/)
  assert.throws(
    () => encodeSettingValue('json', { count: Number.NaN }),
    /JSON-compatible/,
  )
  assert.throws(
    () => encodeSettingValue('json', { missing: undefined }),
    /JSON-compatible/,
  )
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.throws(() => encodeSettingValue('json', circular), /JSON-compatible/)
})
