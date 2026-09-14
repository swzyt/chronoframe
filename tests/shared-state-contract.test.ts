import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeSharedAccess,
  decodeSharedSession,
  digestOpaqueToken,
  encodeSharedAccess,
  encodeSharedSession,
  sharedStateKey,
} from '../backend/nodejs/utils/shared-state-contract'

const token = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const digest =
  'ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0'

test('Node token digest and key match the Go golden vector', () => {
  assert.equal(digestOpaqueToken(token), digest)
  assert.equal(
    sharedStateKey('test', 'session', token),
    `cf:v1:test:session:${digest}`,
  )
  assert.throws(() => sharedStateKey('../prod', 'session', token), /namespace/)
})

test('shared session JSON has stable cross-language fields and absolute expiry', () => {
  const record = {
    schemaVersion: 1 as const,
    userId: 12,
    authVersion: 1,
    issuedAt: 1_788_940_800,
    expiresAt: 1_791_532_800,
  }
  const encoded = encodeSharedSession(record)
  assert.equal(
    encoded,
    '{"schemaVersion":1,"userId":12,"authVersion":1,"issuedAt":1788940800,"expiresAt":1791532800}',
  )
  assert.deepEqual(decodeSharedSession(encoded, record.issuedAt), record)
  assert.throws(() => decodeSharedSession(encoded, record.expiresAt), /expired/)
})

test('shared access JSON validates access version', () => {
  const record = {
    schemaVersion: 1 as const,
    accessVersion: 3,
    issuedAt: 1_788_940_800,
    expiresAt: 1_791_532_800,
  }
  assert.deepEqual(
    decodeSharedAccess(encodeSharedAccess(record), record.issuedAt),
    record,
  )
  assert.throws(
    () => encodeSharedAccess({ ...record, accessVersion: 0 }),
    /invalid/,
  )
})
