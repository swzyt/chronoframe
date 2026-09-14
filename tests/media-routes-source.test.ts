import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const imageRouteSource = readFileSync(
  new URL('../backend/nodejs/routes/image/[...key].get.ts', import.meta.url),
  'utf8',
)
const imageHeadRouteSource = readFileSync(
  new URL('../backend/nodejs/routes/image/[...key].head.ts', import.meta.url),
  'utf8',
)
const sharedRouteSource = readFileSync(
  new URL('../backend/nodejs/utils/media-route-handlers.ts', import.meta.url),
  'utf8',
)
const httpAbortSource = readFileSync(
  new URL('../backend/nodejs/utils/http-abort.ts', import.meta.url),
  'utf8',
)
const mediaCacheSource = readFileSync(
  new URL('../backend/nodejs/utils/media-cache.ts', import.meta.url),
  'utf8',
)
const storageInterfaceSource = readFileSync(
  new URL('../backend/nodejs/services/storage/interfaces.ts', import.meta.url),
  'utf8',
)
const localStorageSource = readFileSync(
  new URL('../backend/nodejs/services/storage/providers/local.ts', import.meta.url),
  'utf8',
)
const s3StorageSource = readFileSync(
  new URL('../backend/nodejs/services/storage/providers/s3.ts', import.meta.url),
  'utf8',
)
const openListStorageSource = readFileSync(
  new URL('../backend/nodejs/services/storage/providers/openlist.ts', import.meta.url),
  'utf8',
)
const displayRouteSource = readFileSync(
  new URL('../backend/nodejs/routes/display/[photoId].get.ts', import.meta.url),
  'utf8',
)
const thumbRouteSource = readFileSync(
  new URL('../backend/nodejs/routes/thumb/[...thumbnailUrl].get.ts', import.meta.url),
  'utf8',
)
const ogMediaRouteSource = readFileSync(
  new URL('../backend/nodejs/routes/og-media/[photoId].get.ts', import.meta.url),
  'utf8',
)
const shareOGRouteSource = readFileSync(
  new URL('../backend/nodejs/routes/share-og/[photoId].png.get.ts', import.meta.url),
  'utf8',
)
const storageRouteSource = readFileSync(
  new URL('../backend/nodejs/routes/storage/[...path].get.ts', import.meta.url),
  'utf8',
)
const storageHeadRouteSource = readFileSync(
  new URL('../backend/nodejs/routes/storage/[...path].head.ts', import.meta.url),
  'utf8',
)

test('Node image and storage media routes share byte range parsing', () => {
  assert.match(imageRouteSource, /handleImageMediaRequest/)
  assert.match(storageRouteSource, /handleStorageMediaRequest/)
  assert.match(imageHeadRouteSource, /handleImageMediaRequest/)
  assert.match(storageHeadRouteSource, /handleStorageMediaRequest/)
  assert.match(sharedRouteSource, /parseHTTPByteRange\(range,/)
  assert.doesNotMatch(sharedRouteSource, /\^bytes=\\\(\\d\*/)
})

test('Node storage route keeps original image and cache policy aligned with image route', () => {
  assert.match(
    sharedRouteSource,
    /isOriginalImageMediaKey\(mediaPhoto, relPath\)/,
  )
  assert.match(sharedRouteSource, /requireOriginalImageMediaAccess\(event\)/)
  assert.match(sharedRouteSource, /private, max-age=86400/)
  assert.doesNotMatch(sharedRouteSource, /public, max-age=31536000, immutable/)
  assert.match(
    sharedRouteSource,
    /config\?\.provider !== 'local'[\s\S]*serveProviderMedia\(/,
  )
  assert.doesNotMatch(
    sharedRouteSource,
    /config\?\.provider !== 'local'[\s\S]{0,120}statusCode: 404/,
  )
})

test('Node direct media HEAD routes reuse GET handlers without writing response bodies', () => {
  assert.match(
    sharedRouteSource,
    /getMethod\(event\)\.toUpperCase\(\) === 'HEAD'/,
  )
  assert.match(sharedRouteSource, /setResponseStatus\(event, 200\)/)
  assert.match(sharedRouteSource, /if \(isHead\) \{\n\s+return ''\n\s+\}/)
})

test('Node direct media routes gate Range responses with If-Range validators', () => {
  assert.match(sharedRouteSource, /shouldServeHTTPByteRange\(/)
  assert.match(sharedRouteSource, /getHeader\(event, 'if-range'\)/)
  assert.match(sharedRouteSource, /Last-Modified/)
})

test('Node private media routes vary on Cookie like Go media responses', () => {
  assert.match(mediaCacheSource, /setHeader\(event, 'Vary', 'Cookie'\)/)
  for (const source of [
    sharedRouteSource,
    displayRouteSource,
    thumbRouteSource,
    ogMediaRouteSource,
    shareOGRouteSource,
  ]) {
    assert.match(source, /setPrivateMediaCacheHeaders\(/)
  }
})

test('Node generated thumbnail route declares JPEG content and private cache headers', () => {
  assert.match(
    thumbRouteSource,
    /setHeader\(event, 'Content-Type', 'image\/jpeg'\)/,
  )
  assert.match(thumbRouteSource, /setHeader\(event, 'Content-Length'/)
  assert.match(thumbRouteSource, /private, max-age=86400/)
})

test('Node share-OG route enforces the canonical lowercase PNG suffix', () => {
  assert.match(shareOGRouteSource, /pathnameSegment\.endsWith\('\.png'\)/)
  assert.match(shareOGRouteSource, /statusMessage: 'Image not found'/)
  assert.match(shareOGRouteSource, /replace\(\/\\\.png\$\/, ''\)/)
})

test('Node direct media routes propagate client aborts into upstream reads', () => {
  assert.match(httpAbortSource, /req\.once\('aborted', abort\)/)
  assert.match(httpAbortSource, /res\.once\('close'/)
  assert.equal(
    sharedRouteSource.match(/requestAbortSignal\(event\)/g)?.length,
    2,
  )
  assert.match(
    sharedRouteSource,
    /getFileMeta\(normalizedKey,\s+\{\s+signal: abortSignal,\s+\}\)/,
  )
  assert.match(
    sharedRouteSource,
    /getRangeStream\?\.\([\s\S]*?normalizedKey,[\s\S]*?start,[\s\S]*?end,[\s\S]*?signal: abortSignal/,
  )
  assert.match(
    sharedRouteSource,
    /getRange\?\.\([\s\S]*?normalizedKey,[\s\S]*?start,[\s\S]*?end,[\s\S]*?signal: abortSignal/,
  )
  assert.match(
    sharedRouteSource,
    /getStream\?\.\([\s\S]*?normalizedKey,[\s\S]*?signal: abortSignal/,
  )
  assert.match(
    sharedRouteSource,
    /createReadStream\(absolute,[\s\S]*?start,[\s\S]*?end,[\s\S]*?signal: abortSignal/,
  )
  assert.match(
    sharedRouteSource,
    /createReadStream\(absolute, \{ signal: abortSignal \}\)/,
  )
})

test('Node storage providers expose and forward abort signals for reads', () => {
  assert.match(storageInterfaceSource, /interface StorageReadOptions/)
  assert.match(storageInterfaceSource, /signal\?: AbortSignal/)
  assert.match(
    localStorageSource,
    /readFile\(absFile, \{ signal: options\.signal \}\)/,
  )
  assert.match(
    localStorageSource,
    /createReadStream\(absFile, \{ signal: options\.signal \}\)/,
  )
  assert.match(
    localStorageSource,
    /createReadStream\(absFile, \{ start, end, signal: options\.signal \}\)/,
  )
  assert.match(
    s3StorageSource,
    /options\.signal\?\.addEventListener\('abort', forwardAbort/,
  )
  assert.match(s3StorageSource, /abortSignal: controller\.signal/)
  assert.match(
    openListStorageSource,
    /fetch\(rawUrl, \{ signal: options\.signal \}\)/,
  )
  assert.match(openListStorageSource, /signal: options\.signal/)
})
