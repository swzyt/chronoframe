import assert from 'node:assert/strict'
import test from 'node:test'

type StoredUpdate = {
  value?: string | null
}

test('SettingsManager enforces and canonically stores the declared database type', async () => {
  const writes: StoredUpdate[] = []
  const setting = {
    type: 'number' as const,
    isReadonly: false,
    enum: null,
  }
  const database = {
    select: () => ({
      from: () => ({
        where: () => ({ get: () => setting }),
      }),
    }),
    update: () => ({
      set: (update: StoredUpdate) => {
        writes.push(update)
        return {
          where: () => ({ run: () => undefined }),
        }
      },
    }),
  }

  Object.assign(globalThis, {
    logger: {
      dynamic: () => ({
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
    },
    useDB: () => database,
    tables: {
      settings: {
        namespace: 'namespace',
        key: 'key',
      },
    },
    and: () => true,
    eq: () => true,
  })

  const { settingsManager } =
    await import('../backend/nodejs/services/settings/settingsManager')

  await assert.rejects(
    settingsManager.set('app', 'access.previewPhotoLimit', '0x10'),
    /Expected a finite JSON number or null/,
  )
  assert.equal(writes.length, 0)

  await settingsManager.set('app', 'access.previewPhotoLimit', -0)
  assert.equal(writes.length, 1)
  assert.equal(writes[0]?.value, '0')
})
