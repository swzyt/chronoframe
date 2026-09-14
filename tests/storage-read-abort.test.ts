import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Readable } from 'node:stream'
import { LocalStorageProvider } from '../backend/nodejs/services/storage/providers/local'
import { OpenListStorageProvider } from '../backend/nodejs/services/storage/providers/openlist'
import { S3StorageProvider } from '../backend/nodejs/services/storage/providers/s3'

const assertAbortError = async (read: () => Promise<unknown>) => {
  await assert.rejects(read, (error) => {
    assert.equal((error as Error).name, 'AbortError')
    return true
  })
}

test('local storage read APIs reject before touching storage when already aborted', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cframe-abort-'))
  const provider = new LocalStorageProvider({
    provider: 'local',
    basePath: tempRoot,
  })

  try {
    await provider.create('safe/photo.jpg', Buffer.from('chronoframe'))

    const controller = new AbortController()
    controller.abort()
    const options = { signal: controller.signal }

    await assertAbortError(() => provider.get('safe/photo.jpg', options))
    await assertAbortError(() =>
      provider.getRange('safe/photo.jpg', 0, 3, options),
    )
    await assertAbortError(() => provider.getStream('safe/photo.jpg', options))
    await assertAbortError(() =>
      provider.getRangeStream('safe/photo.jpg', 0, 3, options),
    )
    await assertAbortError(() =>
      provider.getFileMeta('safe/photo.jpg', options),
    )
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})

test('S3 provider slices range responses when compatible endpoint ignores Range', async () => {
  const provider = new S3StorageProvider({
    provider: 's3',
    bucket: 'bucket',
    region: 'us-east-1',
    endpoint: 'https://s3.example.test',
    accessKeyId: 'access',
    secretAccessKey: 'secret',
    prefix: 'photos',
    forcePathStyle: true,
  })
  const body = Buffer.from('chronoframe-s3-full-body')
  const sent: string[] = []

  ;(provider as any).client = {
    send: async (command: any) => {
      sent.push(command?.input?.Range || '')
      return {
        Body: Readable.from(body),
        ContentLength: body.length,
        ContentType: 'image/jpeg',
        ETag: '"test-etag"',
      }
    },
  }

  const range = await provider.getRange('users/1/photo.jpg', 1, 4)

  assert.equal(sent[0], 'bytes=1-4')
  assert.equal(range?.toString(), 'hron')
})

test('OpenList provider slices range responses when download endpoint ignores Range', async () => {
  const body = Buffer.from('chronoframe-openlist-full-body')
  const ranges: string[] = []
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith('/api/fs/download')) {
      ranges.push(String(request.headers.range || ''))
      response.writeHead(200, {
        'Content-Length': String(body.length),
        'Content-Type': 'image/jpeg',
      })
      response.end(body)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.equal(typeof address, 'object')

  const provider = new OpenListStorageProvider({
    provider: 'openlist',
    baseUrl: `http://127.0.0.1:${address?.port}`,
    token: 'token',
    rootPath: 'photos',
    downloadEndpoint: '/api/fs/download',
  } as any)

  try {
    const range = await provider.getRange('users/1/photo.jpg', 1, 4)

    assert.equal(ranges[0], 'bytes=1-4')
    assert.equal(range?.toString(), 'hron')
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
})

test('OpenList provider slices range responses when raw_url endpoint ignores Range', async () => {
  const body = Buffer.from('chronoframe-openlist-raw-full-body')
  const ranges: string[] = []
  let baseUrl = ''
  const server = http.createServer(async (request, response) => {
    if (request.url === '/api/fs/get') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: {
            size: body.length,
            raw_url: `${baseUrl}/raw/photo.jpg`,
          },
        }),
      )
      return
    }
    if (request.url === '/raw/photo.jpg') {
      ranges.push(String(request.headers.range || ''))
      response.writeHead(200, {
        'Content-Length': String(body.length),
        'Content-Type': 'image/jpeg',
      })
      response.end(body)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.equal(typeof address, 'object')
  baseUrl = `http://127.0.0.1:${address?.port}`

  const provider = new OpenListStorageProvider({
    provider: 'openlist',
    baseUrl,
    token: 'token',
    rootPath: 'photos',
  } as any)

  try {
    const range = await provider.getRange('users/1/photo.jpg', 1, 4)

    assert.equal(ranges[0], 'bytes=1-4')
    assert.equal(range?.toString(), 'hron')
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
})
