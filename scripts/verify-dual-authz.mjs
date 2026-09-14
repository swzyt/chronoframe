#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import {
	canonicalize,
  DUAL_BACKEND_COMPARE_FIXTURE,
  joinBackendURL,
} from './compare-backends.mjs'
import {
  FIXTURE_MEMBER_SESSION_TOKEN,
  FIXTURE_SESSION_TOKEN,
} from './seed-dual-backend-fixture.mjs'

export const DEFAULT_AUTHZ_BASE_URL = 'http://127.0.0.1:3000'
export const DEFAULT_AUTHZ_ADMIN_COOKIE = `cf_session=${FIXTURE_SESSION_TOKEN}`
export const DEFAULT_AUTHZ_MEMBER_COOKIE = `cf_session=${FIXTURE_MEMBER_SESSION_TOKEN}`

const ERROR_FIELDS = ['statusCode', 'statusMessage', 'message']
const PROVIDER_SETTING_PATH = '/api/system/settings/system/backend.readProvider'
const PUBLIC_UPLOAD_SHARE_BASE_PATH = `/api/upload-shares/public/${DUAL_BACKEND_COMPARE_FIXTURE.uploadShareToken}`
const PUBLIC_UPLOAD_SHARE_VALID_KEY = [
  'dual-fixture',
  'users',
  String(DUAL_BACKEND_COMPARE_FIXTURE.userId),
  'guest-uploads',
  String(DUAL_BACKEND_COMPARE_FIXTURE.uploadShareId),
  'authz.jpg',
].join('/')

export const AUTHZ_ERROR_CASES = Object.freeze([
  Object.freeze({
    name: 'anonymous admin users list',
    method: 'GET',
    path: '/api/admin/users',
    cookie: 'anonymous',
    expectedStatus: 401,
    expectedStatusMessage: 'Unauthorized',
  }),
  Object.freeze({
    name: 'member admin users list forbidden',
    method: 'GET',
    path: '/api/admin/users',
    cookie: 'member',
    expectedStatus: 403,
    expectedStatusMessage: 'Forbidden',
  }),
  Object.freeze({
    name: 'admin user create missing fields',
    method: 'POST',
    path: '/api/admin/users',
    cookie: 'admin',
    body: {},
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin user create null fields',
    method: 'POST',
    path: '/api/admin/users',
    cookie: 'admin',
    body: {
      username: null,
      email: null,
      password: null,
      isAdmin: null,
    },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin user create null body',
    method: 'POST',
    path: '/api/admin/users',
    cookie: 'admin',
    body: null,
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin user update empty object',
    method: 'PATCH',
    path: `/api/admin/users/${DUAL_BACKEND_COMPARE_FIXTURE.memberUserId}`,
    cookie: 'admin',
    body: {},
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin user update null fields',
    method: 'PATCH',
    path: `/api/admin/users/${DUAL_BACKEND_COMPARE_FIXTURE.memberUserId}`,
    cookie: 'admin',
    body: {
      username: null,
      email: null,
      password: null,
      isAdmin: null,
      isActive: null,
    },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin user update invalid field types',
    method: 'PATCH',
    path: `/api/admin/users/${DUAL_BACKEND_COMPARE_FIXTURE.memberUserId}`,
    cookie: 'admin',
    body: {
      username: 1,
      email: true,
      password: [],
      isAdmin: 'false',
      isActive: 0,
    },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin user update invalid transformed bounds',
    method: 'PATCH',
    path: `/api/admin/users/${DUAL_BACKEND_COMPARE_FIXTURE.memberUserId}`,
    cookie: 'admin',
    body: {
      username: '   ',
      email: ' USER@example.com ',
      password: 'short',
    },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin user update invalid coerced path',
    method: 'PATCH',
    path: '/api/admin/users/not-a-number',
    cookie: 'admin',
    body: { username: 'valid-name' },
    expectedStatus: 500,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'admin update missing user',
    method: 'PATCH',
    path: '/api/admin/users/99999999',
    cookie: 'admin',
    body: { username: 'missing-user' },
    expectedStatus: 404,
    expectedStatusMessage: 'User not found',
  }),
  Object.freeze({
    name: 'admin delete missing user',
    method: 'DELETE',
    path: '/api/admin/users/99999999',
    cookie: 'admin',
    expectedStatus: 404,
    expectedStatusMessage: 'User not found',
  }),
  Object.freeze({
    name: 'admin user delete invalid coerced path',
    method: 'DELETE',
    path: '/api/admin/users/not-a-number',
    cookie: 'admin',
    expectedStatus: 500,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'admin cannot delete own account',
    method: 'DELETE',
    path: `/api/admin/users/${DUAL_BACKEND_COMPARE_FIXTURE.userId}`,
    cookie: 'admin',
    expectedStatus: 400,
    expectedStatusMessage: 'You cannot delete your own account',
  }),
  Object.freeze({
    name: 'anonymous settings schema',
    method: 'GET',
    path: '/api/system/settings/schema',
    cookie: 'anonymous',
    expectedStatus: 401,
    expectedStatusMessage: 'Unauthorized',
  }),
  Object.freeze({
    name: 'member settings schema forbidden',
    method: 'GET',
    path: '/api/system/settings/schema',
    cookie: 'member',
    expectedStatus: 403,
    expectedStatusMessage: 'Forbidden',
  }),
  Object.freeze({
    name: 'anonymous upload shares list',
    method: 'GET',
    path: '/api/upload-shares',
    cookie: 'anonymous',
    expectedStatus: 401,
    expectedStatusMessage: 'Unauthorized',
  }),
  Object.freeze({
    name: 'upload share create null body',
    method: 'POST',
    path: '/api/upload-shares',
    cookie: 'admin',
    body: null,
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'upload share create rejects null label',
    method: 'POST',
    path: '/api/upload-shares',
    cookie: 'admin',
    body: { label: null },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'upload share create invalid field types',
    method: 'POST',
    path: '/api/upload-shares',
    cookie: 'admin',
    body: { label: 1, expiresInDays: '30', maxUploads: true },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'upload share create transformed and integer bounds',
    method: 'POST',
    path: '/api/upload-shares',
    cookie: 'admin',
    body: {
      label: `  ${'😀'.repeat(81)}  `,
      expiresInDays: 1.5,
      maxUploads: 0,
    },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'upload share create upper bounds',
    method: 'POST',
    path: '/api/upload-shares',
    cookie: 'admin',
    body: { expiresInDays: 366, maxUploads: 10001 },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'upload share update null body',
    method: 'PATCH',
    path: '/api/upload-shares/99999999',
    cookie: 'admin',
    body: null,
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'upload share update invalid field types',
    method: 'PATCH',
    path: '/api/upload-shares/99999999',
    cookie: 'admin',
    body: { label: 1, isActive: null, maxUploads: '2' },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'upload share update transformed and integer bounds',
    method: 'PATCH',
    path: '/api/upload-shares/99999999',
    cookie: 'admin',
    body: { label: `  ${'😀'.repeat(81)}  `, maxUploads: 1.5 },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'upload share update lower bound',
    method: 'PATCH',
    path: '/api/upload-shares/99999999',
    cookie: 'admin',
    body: { maxUploads: 0 },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'upload share update upper bound',
    method: 'PATCH',
    path: '/api/upload-shares/99999999',
    cookie: 'admin',
    body: { maxUploads: 10001 },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'upload share update invalid numeric path',
    method: 'PATCH',
    path: '/api/upload-shares/not-a-number',
    cookie: 'admin',
    body: { label: 'valid' },
    expectedStatus: 400,
    expectedStatusMessage: 'Invalid share id',
  }),
  Object.freeze({
    name: 'upload share update accepts decimal integer path',
    method: 'PATCH',
    path: '/api/upload-shares/42.0',
    cookie: 'admin',
    body: {},
    expectedStatus: 404,
    expectedStatusMessage: 'Upload link not found',
  }),
  Object.freeze({
    name: 'upload share update accepts radix integer path',
    method: 'PATCH',
    path: '/api/upload-shares/0x2a',
    cookie: 'admin',
    body: {},
    expectedStatus: 404,
    expectedStatusMessage: 'Upload link not found',
  }),
  Object.freeze({
    name: 'upload share update accepts out-of-range numeric path',
    method: 'PATCH',
    path: '/api/upload-shares/1e20',
    cookie: 'admin',
    body: {},
    expectedStatus: 404,
    expectedStatusMessage: 'Upload link not found',
  }),
  Object.freeze({
    name: 'upload share delete invalid numeric path',
    method: 'DELETE',
    path: '/api/upload-shares/not-a-number',
    cookie: 'admin',
    expectedStatus: 400,
    expectedStatusMessage: 'Invalid share id',
  }),
  Object.freeze({
    name: 'anonymous profile',
    method: 'GET',
    path: '/api/profile',
    cookie: 'anonymous',
    expectedStatus: 401,
    expectedStatusMessage: 'Unauthorized',
  }),
  Object.freeze({
    name: 'anonymous preview-locked album detail',
    method: 'GET',
    path: `/api/albums/${DUAL_BACKEND_COMPARE_FIXTURE.restrictedAlbumId}`,
    cookie: 'anonymous',
    expectedStatus: 401,
    expectedStatusMessage: 'Site access required to view more albums',
  }),
  Object.freeze({
    name: 'member hidden display media',
    method: 'GET',
    path: `/display/${DUAL_BACKEND_COMPARE_FIXTURE.hiddenPhotoId}`,
    cookie: 'member',
    expectedStatus: 404,
    expectedStatusMessage: 'Photo not found',
  }),
  Object.freeze({
    name: 'admin invalid setting namespace',
    method: 'GET',
    path: '/api/system/settings/__invalid_namespace__',
    cookie: 'admin',
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin invalid setting key',
    method: 'GET',
    path: '/api/system/settings/app/__invalid_key__',
    cookie: 'admin',
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin settings fields missing namespace',
    method: 'GET',
    path: '/api/system/settings/fields',
    cookie: 'admin',
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin settings fields empty namespace',
    method: 'GET',
    path: '/api/system/settings/fields?namespace=',
    cookie: 'admin',
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin settings fields repeated namespace',
    method: 'GET',
    path: '/api/system/settings/fields?namespace=system&namespace=app',
    cookie: 'admin',
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin settings fields unknown namespace',
    method: 'GET',
    path: '/api/system/settings/fields?namespace=__invalid_namespace__',
    cookie: 'admin',
    expectedStatus: 404,
    expectedStatusMessage: 'Namespace __invalid_namespace__ not found',
  }),
  Object.freeze({
    name: 'admin queue task list repeated status',
    method: 'GET',
    path: '/api/queue/task/list?status=completed&status=pending',
    cookie: 'admin',
    expectedStatus: 500,
    expectedStatusMessage: 'Failed to fetch task list',
  }),
  Object.freeze({
    name: 'admin queue task list repeated type',
    method: 'GET',
    path: '/api/queue/task/list?type=photo&type=video',
    cookie: 'admin',
    expectedStatus: 500,
    expectedStatusMessage: 'Failed to fetch task list',
  }),
  Object.freeze({
    name: 'admin queue clear repeated include flag',
    method: 'DELETE',
    path: '/api/queue/task/clear?includeCompleted=false&includeCompleted=true&includeFailed=false',
    cookie: 'admin',
    expectedStatus: 500,
    expectedStatusMessage: 'Failed to clear tasks',
  }),
  Object.freeze({
    name: 'admin queue clear repeated age',
    method: 'DELETE',
    path: '/api/queue/task/clear?olderThanDays=-1&olderThanDays=1',
    cookie: 'admin',
    expectedStatus: 500,
    expectedStatusMessage: 'Failed to clear tasks',
  }),
  Object.freeze({
    name: 'admin setting update missing value',
    method: 'PUT',
    path: '/api/system/settings/app/title',
    cookie: 'admin',
    body: {},
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin settings batch missing updates',
    method: 'PUT',
    path: '/api/system/settings/batch',
    cookie: 'admin',
    body: {},
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin settings batch empty body',
    method: 'PUT',
    path: '/api/system/settings/batch',
    cookie: 'admin',
    rawBody: '',
    contentType: 'application/json',
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin settings batch null body',
    method: 'PUT',
    path: '/api/system/settings/batch',
    cookie: 'admin',
    rawBody: 'null',
    contentType: 'application/json',
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin settings batch malformed JSON',
    method: 'PUT',
    path: '/api/system/settings/batch',
    cookie: 'admin',
    rawBody: '{',
    contentType: 'application/json',
    expectedStatus: 400,
    expectedStatusMessage: 'Bad Request',
  }),
  Object.freeze({
    name: 'admin settings batch trailing JSON document',
    method: 'PUT',
    path: '/api/system/settings/batch',
    cookie: 'admin',
    rawBody: '{"updates":[]}{}',
    contentType: 'application/json',
    expectedStatus: 400,
    expectedStatusMessage: 'Bad Request',
  }),
  Object.freeze({
    name: 'admin settings batch updates not array',
    method: 'PUT',
    path: '/api/system/settings/batch',
    cookie: 'admin',
    body: { updates: {} },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin settings batch invalid namespace and key',
    method: 'PUT',
    path: '/api/system/settings/batch',
    cookie: 'admin',
    body: {
      updates: [
        {
          namespace: '__invalid_namespace__',
          key: '__invalid_key__',
          value: 'x',
        },
      ],
    },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin settings batch missing value',
    method: 'PUT',
    path: '/api/system/settings/batch',
    cookie: 'admin',
    body: {
      updates: [{ namespace: 'app', key: 'title' }],
    },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin EXIF reindex invalid action',
    method: 'POST',
    path: '/api/photos/exif/reindex',
    cookie: 'admin',
    body: { action: 'invalid-action' },
    expectedStatus: 400,
    expectedStatusMessage: 'Invalid action parameter',
  }),
  Object.freeze({
    name: 'admin LivePhoto manage missing action',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: {},
    expectedStatus: 400,
    expectedStatusMessage: 'Action is required',
  }),
  Object.freeze({
    name: 'admin LivePhoto manage missing body',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    expectedStatus: 500,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'admin LivePhoto manage null body',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: null,
    expectedStatus: 500,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'admin LivePhoto manage primitive body',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: 1,
    expectedStatus: 400,
    expectedStatusMessage: 'Action is required',
  }),
  Object.freeze({
    name: 'admin LivePhoto manage array body',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: [],
    expectedStatus: 400,
    expectedStatusMessage: 'Action is required',
  }),
  Object.freeze({
    name: 'admin LivePhoto manage whitespace action',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: { action: '   ' },
    expectedStatus: 400,
    expectedStatusMessage:
      'Invalid action. Use "scan", "detect", "process", or "update-photo"',
  }),
  Object.freeze({
    name: 'admin LivePhoto manage numeric action',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: { action: 1 },
    expectedStatus: 400,
    expectedStatusMessage:
      'Invalid action. Use "scan", "detect", "process", or "update-photo"',
  }),
  Object.freeze({
    name: 'admin LivePhoto process false video key',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: { action: 'process', videoKey: false },
    expectedStatus: 400,
    expectedStatusMessage: 'videoKey is required for process action',
  }),
  Object.freeze({
    name: 'admin LivePhoto detect invalid photo id binding',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: { action: 'detect', photoIds: [true] },
    expectedStatus: 500,
    expectedStatusMessage: 'Failed to process LivePhoto management request',
  }),
  Object.freeze({
    name: 'admin LivePhoto update numeric photo id',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: { action: 'update-photo', photoId: 1 },
    expectedStatus: 404,
    expectedStatusMessage: 'Photo not found',
  }),
  Object.freeze({
    name: 'admin LivePhoto update object photo id',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: { action: 'update-photo', photoId: {} },
    expectedStatus: 500,
    expectedStatusMessage: 'Failed to process LivePhoto management request',
  }),
  Object.freeze({
    name: 'admin LivePhoto manage malformed body',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    rawBody: '{"action":',
    contentType: 'application/json',
    expectedStatus: 400,
    expectedStatusMessage: 'Bad Request',
  }),
  Object.freeze({
    name: 'admin photo upload prepare missing body',
    method: 'POST',
    path: '/api/photos',
    cookie: 'admin',
    expectedStatus: 400,
    expectedStatusMessage: 'Missing Required Parameter',
  }),
  Object.freeze({
    name: 'admin photo upload prepare null body',
    method: 'POST',
    path: '/api/photos',
    cookie: 'admin',
    body: null,
    expectedStatus: 400,
    expectedStatusMessage: 'Missing Required Parameter',
  }),
  Object.freeze({
    name: 'admin photo upload repeated key',
    method: 'PUT',
    path: '/api/photos/upload?key=first&key=second',
    cookie: 'admin',
    rawBody: 'x',
    contentType: 'application/json',
    expectedStatus: 500,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'admin duplicate check missing body',
    method: 'POST',
    path: '/api/photos/check-duplicate',
    cookie: 'admin',
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin duplicate check null body',
    method: 'POST',
    path: '/api/photos/check-duplicate',
    cookie: 'admin',
    body: null,
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin duplicate check missing all inputs',
    method: 'POST',
    path: '/api/photos/check-duplicate',
    cookie: 'admin',
    body: {},
    expectedStatus: 400,
    expectedStatusMessage: 'Missing Required Parameter',
    expectedData: {
      title: 'Missing Required Parameter',
      message:
        'Please provide fileNames, storageKeys or contentHashes parameter',
    },
  }),
  Object.freeze({
    name: 'admin duplicate check fileNames type validation',
    method: 'POST',
    path: '/api/photos/check-duplicate',
    cookie: 'admin',
    body: { fileNames: {} },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin duplicate check fileNames item validation',
    method: 'POST',
    path: '/api/photos/check-duplicate',
    cookie: 'admin',
    body: { fileNames: [123] },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin duplicate check storageKeys type validation',
    method: 'POST',
    path: '/api/photos/check-duplicate',
    cookie: 'admin',
    body: { storageKeys: {} },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin duplicate check contentHashes type validation',
    method: 'POST',
    path: '/api/photos/check-duplicate',
    cookie: 'admin',
    body: { contentHashes: {} },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin photo albums invalid album id',
    method: 'PUT',
    path: `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}/albums`,
    cookie: 'admin',
    body: { albumIds: [0] },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin album create missing title',
    method: 'POST',
    path: '/api/albums',
    cookie: 'admin',
    body: {},
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin album create null optional fields',
    method: 'POST',
    path: '/api/albums',
    cookie: 'admin',
    body: {
      title: 'valid title',
      description: null,
      coverPhotoId: null,
      photoIds: null,
      isHidden: null,
    },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin album create null body',
    method: 'POST',
    path: '/api/albums',
    cookie: 'admin',
    body: null,
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin album update null optional fields',
    method: 'PUT',
    path: `/api/albums/${DUAL_BACKEND_COMPARE_FIXTURE.albumId}`,
    cookie: 'admin',
    body: {
      title: null,
      description: null,
      coverPhotoId: null,
      photoIds: null,
      isHidden: null,
    },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin missing album update',
    method: 'PUT',
    path: '/api/albums/99999999',
    cookie: 'admin',
    body: { title: 'missing-album' },
    expectedStatus: 404,
    expectedStatusMessage: 'Album not found',
  }),
  Object.freeze({
    name: 'admin missing album delete',
    method: 'DELETE',
    path: '/api/albums/99999999',
    cookie: 'admin',
    expectedStatus: 404,
    expectedStatusMessage: 'Album not found',
  }),
  Object.freeze({
    name: 'admin missing album photo relation delete',
    method: 'DELETE',
    path: '/api/albums/99999999/photos/missing-photo',
    cookie: 'admin',
    expectedStatus: 404,
    expectedStatusMessage: 'Album not found',
  }),
  Object.freeze({
    name: 'admin photo albums bulk missing photo',
    method: 'PUT',
    path: '/api/photos/albums',
    cookie: 'admin',
    body: {
      photoIds: ['dual-authz-missing-photo'],
      albumIds: [],
      mode: 'replace',
    },
    expectedStatus: 404,
    expectedStatusMessage: 'Photo not found',
  }),
  Object.freeze({
    name: 'public missing reaction delete',
    method: 'DELETE',
    path: `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}/reactions`,
    cookie: 'anonymous',
    expectedStatus: 404,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'public reaction post missing body',
    method: 'POST',
    path: `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}/reactions`,
    cookie: 'anonymous',
    expectedStatus: 500,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'public reaction post null body',
    method: 'POST',
    path: `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}/reactions`,
    cookie: 'anonymous',
    body: null,
    expectedStatus: 500,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'public reaction post primitive body',
    method: 'POST',
    path: `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}/reactions`,
    cookie: 'anonymous',
    body: 1,
    expectedStatus: 400,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'public reaction post missing type',
    method: 'POST',
    path: `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}/reactions`,
    cookie: 'anonymous',
    body: {},
    expectedStatus: 400,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'public reaction post invalid type value',
    method: 'POST',
    path: `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}/reactions`,
    cookie: 'anonymous',
    body: { reactionType: ['like'] },
    expectedStatus: 400,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'public reaction post malformed JSON',
    method: 'POST',
    path: `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}/reactions`,
    cookie: 'anonymous',
    rawBody: '{"reactionType":',
    contentType: 'application/json',
    expectedStatus: 400,
    expectedStatusMessage: 'Bad Request',
  }),
  Object.freeze({
    name: 'admin photo update missing original file',
    method: 'PUT',
    path: `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}`,
    cookie: 'admin',
    body: { title: 'dual-authz-title-should-not-write-without-file' },
    expectedStatus: 404,
    expectedStatusMessage: 'Photo file is missing',
  }),
  Object.freeze({
    name: 'admin photo update missing body',
    method: 'PUT',
    path: '/api/photos/missing-photo-validation',
    cookie: 'admin',
    expectedStatus: 500,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'admin photo update null body',
    method: 'PUT',
    path: '/api/photos/missing-photo-validation',
    cookie: 'admin',
    body: null,
    expectedStatus: 500,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'admin photo update invalid field types',
    method: 'PUT',
    path: '/api/photos/missing-photo-validation',
    cookie: 'admin',
    body: {
      title: null,
      description: 1,
      tags: 'x',
      location: true,
      rating: '3',
    },
    expectedStatus: 500,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'admin photo update UTF-16 text bounds',
    method: 'PUT',
    path: '/api/photos/missing-photo-validation',
    cookie: 'admin',
    body: { title: `  ${'😀'.repeat(257)}  ` },
    expectedStatus: 500,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'admin photo update tag schema bounds',
    method: 'PUT',
    path: '/api/photos/missing-photo-validation',
    cookie: 'admin',
    body: { tags: [1, `  ${'😀'.repeat(65)}  `] },
    expectedStatus: 500,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'admin photo update invalid location',
    method: 'PUT',
    path: '/api/photos/missing-photo-validation',
    cookie: 'admin',
    body: { location: { latitude: -91, longitude: 181 } },
    expectedStatus: 500,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'admin photo update invalid rating',
    method: 'PUT',
    path: '/api/photos/missing-photo-validation',
    cookie: 'admin',
    body: { rating: 1.5 },
    expectedStatus: 500,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'admin photo update malformed JSON',
    method: 'PUT',
    path: '/api/photos/missing-photo-validation',
    cookie: 'admin',
    rawBody: '{"title":',
    contentType: 'application/json',
    expectedStatus: 400,
    expectedStatusMessage: 'Bad Request',
  }),
  Object.freeze({
    name: 'admin photo update empty object',
    method: 'PUT',
    path: '/api/photos/missing-photo-validation',
    cookie: 'admin',
    body: {},
    expectedStatus: 400,
    expectedStatusMessage: 'No changes to apply',
  }),
  Object.freeze({
    name: 'admin photo update preserves nonempty whitespace id',
    method: 'PUT',
    path: '/api/photos/%20',
    cookie: 'admin',
    body: { title: 'valid' },
    expectedStatus: 404,
    expectedStatusMessage: 'Photo not found',
  }),
  Object.freeze({
    name: 'admin missing photo update',
    method: 'PUT',
    path: '/api/photos/missing-photo',
    cookie: 'admin',
    body: { title: 'missing-photo' },
    expectedStatus: 404,
    expectedStatusMessage: 'Photo not found',
  }),
  Object.freeze({
    name: 'admin missing photo delete',
    method: 'DELETE',
    path: '/api/photos/missing-photo',
    cookie: 'admin',
    expectedStatus: 404,
    expectedStatusMessage: 'Photo not found',
  }),
  Object.freeze({
    name: 'admin missing photo livephoto read',
    method: 'GET',
    path: '/api/photos/missing-photo/livephoto',
    cookie: 'admin',
    expectedStatus: 404,
    expectedStatusMessage: 'Photo not found',
  }),
  Object.freeze({
    name: 'public invalid reaction type',
    method: 'POST',
    path: `/api/photos/${DUAL_BACKEND_COMPARE_FIXTURE.photoId}/reactions`,
    cookie: 'anonymous',
    body: {},
    expectedStatus: 400,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'admin missing album detail',
    method: 'GET',
    path: `/api/albums/${DUAL_BACKEND_COMPARE_FIXTURE.albumId + 9_999_999}`,
    cookie: 'admin',
    expectedStatus: 404,
    expectedStatusMessage: 'Album not found',
  }),
  Object.freeze({
    name: 'admin missing queue task stats',
    method: 'GET',
    path: '/api/queue/stats/missing-task',
    cookie: 'admin',
    expectedStatus: 404,
    expectedStatusMessage: 'Task not found',
  }),
  Object.freeze({
    name: 'admin queue add task missing payload',
    method: 'POST',
    path: '/api/queue/add-task',
    cookie: 'admin',
    body: {},
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin queue add task null optionals',
    method: 'POST',
    path: '/api/queue/add-task',
    cookie: 'admin',
    body: {
      payload: {
        type: 'photo',
        storageKey: 'x',
        contentHash: null,
        eraseLocation: null,
      },
      priority: null,
      maxAttempts: null,
    },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin queue add task reverse geocoding bounds',
    method: 'POST',
    path: '/api/queue/add-task',
    cookie: 'admin',
    body: {
      payload: {
        type: 'photo-reverse-geocoding',
        photoId: '',
        latitude: -91,
        longitude: 181,
      },
    },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin queue add tasks missing array',
    method: 'POST',
    path: '/api/queue/add-tasks',
    cookie: 'admin',
    body: {},
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin queue add tasks empty array',
    method: 'POST',
    path: '/api/queue/add-tasks',
    cookie: 'admin',
    body: { tasks: [] },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin queue add tasks null nested fields',
    method: 'POST',
    path: '/api/queue/add-tasks',
    cookie: 'admin',
    body: {
      tasks: [{ payload: null, priority: null, maxAttempts: null }],
      defaultPriority: null,
      defaultMaxAttempts: null,
    },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin queue add tasks rejects video discriminator',
    method: 'POST',
    path: '/api/queue/add-tasks',
    cookie: 'admin',
    body: { tasks: [{ payload: { type: 'video', storageKey: 'x' } }] },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin queue add tasks maximum array size',
    method: 'POST',
    path: '/api/queue/add-tasks',
    cookie: 'admin',
    body: {
      tasks: Array.from({ length: 1001 }, () => ({
        payload: { type: 'photo', storageKey: 'x' },
      })),
    },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin queue retry missing task id',
    method: 'POST',
    path: '/api/queue/task/retry',
    cookie: 'admin',
    body: {},
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin queue retry fractional task id',
    method: 'POST',
    path: '/api/queue/task/retry',
    cookie: 'admin',
    body: { taskId: 1.5 },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin queue retry non-positive task id',
    method: 'POST',
    path: '/api/queue/task/retry',
    cookie: 'admin',
    body: { taskId: 0 },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin queue batch retry null fields',
    method: 'POST',
    path: '/api/queue/task/retry-batch',
    cookie: 'admin',
    body: { taskIds: null, retryAll: null },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'admin queue batch retry without selection',
    method: 'POST',
    path: '/api/queue/task/retry-batch',
    cookie: 'admin',
    body: {},
    expectedStatus: 400,
    expectedStatusMessage:
      'Either taskIds array or retryAll flag must be provided',
  }),
  Object.freeze({
    name: 'admin missing storage configuration read',
    method: 'GET',
    path: '/api/system/settings/storage-config/99999999',
    cookie: 'admin',
    expectedStatus: 404,
    expectedStatusMessage: 'Storage configuration not found',
  }),
  Object.freeze({
    name: 'admin missing storage configuration update precedes body validation',
    method: 'PUT',
    path: '/api/system/settings/storage-config/99999999',
    cookie: 'admin',
    body: { name: 'missing' },
    expectedStatus: 404,
    expectedStatusMessage: 'Storage configuration not found',
  }),
  Object.freeze({
    name: 'admin missing storage configuration delete',
    method: 'DELETE',
    path: '/api/system/settings/storage-config/99999999',
    cookie: 'admin',
    expectedStatus: 404,
    expectedStatusMessage: 'Storage configuration not found',
  }),
  Object.freeze({
    name: 'admin missing upload share update',
    method: 'PATCH',
    path: '/api/upload-shares/99999999',
    cookie: 'admin',
    body: { label: 'missing' },
    expectedStatus: 404,
    expectedStatusMessage: 'Upload link not found',
  }),
  Object.freeze({
    name: 'admin missing upload share delete',
    method: 'DELETE',
    path: '/api/upload-shares/99999999',
    cookie: 'admin',
    expectedStatus: 404,
    expectedStatusMessage: 'Upload link not found',
  }),
  Object.freeze({
    name: 'public missing upload share read',
    method: 'GET',
    path: '/api/upload-shares/public/missing-token',
    cookie: 'anonymous',
    expectedStatus: 404,
    expectedStatusMessage: 'Upload link not found',
  }),
  Object.freeze({
    name: 'public upload share prepare missing body',
    method: 'POST',
    path: `${PUBLIC_UPLOAD_SHARE_BASE_PATH}/prepare`,
    cookie: 'anonymous',
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'public upload share prepare null body',
    method: 'POST',
    path: `${PUBLIC_UPLOAD_SHARE_BASE_PATH}/prepare`,
    cookie: 'anonymous',
    body: null,
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'public upload share prepare missing fileName',
    method: 'POST',
    path: `${PUBLIC_UPLOAD_SHARE_BASE_PATH}/prepare`,
    cookie: 'anonymous',
    body: {},
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'public upload share prepare fileName type validation',
    method: 'POST',
    path: `${PUBLIC_UPLOAD_SHARE_BASE_PATH}/prepare`,
    cookie: 'anonymous',
    body: { fileName: 123 },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'public upload share prepare empty fileName',
    method: 'POST',
    path: `${PUBLIC_UPLOAD_SHARE_BASE_PATH}/prepare`,
    cookie: 'anonymous',
    body: { fileName: '' },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'public upload share prepare contentType type validation',
    method: 'POST',
    path: `${PUBLIC_UPLOAD_SHARE_BASE_PATH}/prepare`,
    cookie: 'anonymous',
    body: { fileName: 'guest.jpg', contentType: 123 },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'public upload share prepare contentHash type validation',
    method: 'POST',
    path: `${PUBLIC_UPLOAD_SHARE_BASE_PATH}/prepare`,
    cookie: 'anonymous',
    body: { fileName: 'guest.jpg', contentHash: null },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'public upload share task missing body',
    method: 'POST',
    path: `${PUBLIC_UPLOAD_SHARE_BASE_PATH}/task`,
    cookie: 'anonymous',
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'public upload share task null body',
    method: 'POST',
    path: `${PUBLIC_UPLOAD_SHARE_BASE_PATH}/task`,
    cookie: 'anonymous',
    body: null,
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'public upload share task missing payload',
    method: 'POST',
    path: `${PUBLIC_UPLOAD_SHARE_BASE_PATH}/task`,
    cookie: 'anonymous',
    body: {},
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'public upload share task invalid type',
    method: 'POST',
    path: `${PUBLIC_UPLOAD_SHARE_BASE_PATH}/task`,
    cookie: 'anonymous',
    body: { payload: { type: 'bad', storageKey: 'x' } },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'public upload share task missing storageKey',
    method: 'POST',
    path: `${PUBLIC_UPLOAD_SHARE_BASE_PATH}/task`,
    cookie: 'anonymous',
    body: { payload: { type: 'photo' } },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'public upload share task invalid contentHash',
    method: 'POST',
    path: `${PUBLIC_UPLOAD_SHARE_BASE_PATH}/task`,
    cookie: 'anonymous',
    body: { payload: { type: 'photo', storageKey: 'x', contentHash: 'bad' } },
    expectedStatus: 400,
    expectedStatusMessage: 'Validation Error',
  }),
  Object.freeze({
    name: 'public upload share upload missing key',
    method: 'PUT',
    path: `${PUBLIC_UPLOAD_SHARE_BASE_PATH}/upload`,
    cookie: 'anonymous',
    rawBody: 'x',
    contentType: 'image/jpeg',
    expectedStatus: 400,
    expectedStatusMessage: 'Missing Required Parameter',
  }),
  Object.freeze({
    name: 'public upload share upload repeated key',
    method: 'PUT',
    path: `${PUBLIC_UPLOAD_SHARE_BASE_PATH}/upload?key=${PUBLIC_UPLOAD_SHARE_VALID_KEY}&key=${PUBLIC_UPLOAD_SHARE_VALID_KEY}`,
    cookie: 'anonymous',
    rawBody: 'x',
    contentType: 'application/json',
    expectedStatus: 500,
    expectedStatusMessage: 'Server Error',
  }),
  Object.freeze({
    name: 'public upload share upload unsupported MIME',
    method: 'PUT',
    path: `${PUBLIC_UPLOAD_SHARE_BASE_PATH}/upload?key=${PUBLIC_UPLOAD_SHARE_VALID_KEY}`,
    cookie: 'anonymous',
    rawBody: 'x',
    contentType: 'application/json',
    expectedStatus: 415,
    expectedStatusMessage: 'Unsupported File Type',
  }),
])

export const AUTHZ_SUCCESS_CASES = Object.freeze([
  Object.freeze({
    name: 'admin LivePhoto scan success shape',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: { action: 'scan' },
    expectedStatus: 200,
    bodyComparator: 'canonical',
    expectedBody: {
      message: 'Scan completed',
      results: { processed: 0, matched: 0, errors: [] },
    },
  }),
  Object.freeze({
    name: 'admin LivePhoto detect selected photo success shape',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: {
      action: 'detect',
      photoIds: [DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId],
    },
    expectedStatus: 200,
    bodyComparator: 'canonical',
    expectedBody: {
      message: 'Batch LivePhoto detection completed',
      results: { total: 1, processed: 1, found: 0, results: [] },
    },
  }),
  Object.freeze({
    name: 'admin LivePhoto detect non-array photo ids scans all',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: { action: 'detect', photoIds: 'all' },
    expectedStatus: 200,
    bodyComparator: 'canonical',
    expectedBody: {
      message: 'Batch LivePhoto detection completed',
      results: { total: 2, processed: 2, found: 0, results: [] },
    },
  }),
  Object.freeze({
    name: 'admin LivePhoto detect numeric photo id success shape',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: { action: 'detect', photoIds: [1] },
    expectedStatus: 200,
    bodyComparator: 'canonical',
    expectedBody: {
      message: 'Batch LivePhoto detection completed',
      results: { total: 0, processed: 0, found: 0, results: [] },
    },
  }),
  Object.freeze({
    name: 'admin LivePhoto process missing object success shape',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: { action: 'process', videoKey: 'originals/missing-livephoto.MOV' },
    expectedStatus: 200,
    bodyComparator: 'canonical',
    expectedBody: {
      message: 'Failed to process LivePhoto',
      success: false,
      videoKey: 'originals/missing-livephoto.MOV',
    },
  }),
  Object.freeze({
    name: 'admin LivePhoto process numeric video key success shape',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: { action: 'process', videoKey: 1 },
    expectedStatus: 200,
    bodyComparator: 'canonical',
    expectedBody: {
      message: 'Failed to process LivePhoto',
      success: false,
      videoKey: 1,
    },
  }),
  Object.freeze({
    name: 'admin LivePhoto update without matching video success shape',
    method: 'POST',
    path: '/api/photos/livephoto/manage',
    cookie: 'admin',
    body: {
      action: 'update-photo',
      photoId: DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId,
    },
    expectedStatus: 200,
    bodyComparator: 'canonical',
    expectedBody: {
      message: 'No matching video found for this photo',
      success: false,
      photoId: DUAL_BACKEND_COMPARE_FIXTURE.mutablePhotoId,
    },
  }),
  Object.freeze({
    name: 'member system stats success shape',
    method: 'GET',
    path: '/api/system/stats',
    cookie: 'member',
    expectedStatus: 200,
    bodyComparator: 'member-system-stats',
  }),
])

export const AUTHZ_CASES = Object.freeze([
  ...AUTHZ_ERROR_CASES,
  ...AUTHZ_SUCCESS_CASES,
])

export function parseAuthzVerifierOptions(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`)
    }
    if (
      ![
        '--base',
        '--node',
        '--go',
        '--admin-cookie',
        '--member-cookie',
        '--timeout-ms',
      ].includes(arg)
    ) {
      throw new Error(`Unknown option: ${arg}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`)
    }
    values.set(arg, value)
    index += 1
  }

  const base = normalizeBaseURL(
    values.get('--base') ||
      environment.CFRAME_DUAL_BASE_URL ||
      (environment.CFRAME_DUAL_PORT
        ? `http://127.0.0.1:${environment.CFRAME_DUAL_PORT}`
        : DEFAULT_AUTHZ_BASE_URL),
  )
  const nodeURL = normalizeBaseURL(
    values.get('--node') || environment.CFRAME_DUAL_NODE_URL || base,
  )
  const goURL = normalizeBaseURL(
    values.get('--go') || environment.CFRAME_DUAL_GO_URL || `${base}/__lab/go`,
  )
  const adminCookie = normalizeOptionalCookie(
    values.get('--admin-cookie') ||
      environment.CFRAME_DUAL_ADMIN_COOKIE ||
      environment.CFRAME_DUAL_COOKIE ||
      DEFAULT_AUTHZ_ADMIN_COOKIE,
  )
  const memberCookie = normalizeOptionalCookie(
    values.get('--member-cookie') ||
      environment.CFRAME_DUAL_MEMBER_COOKIE ||
      DEFAULT_AUTHZ_MEMBER_COOKIE,
  )
  const timeoutMs = parsePositiveInteger(
    values.get('--timeout-ms') || environment.CFRAME_DUAL_TIMEOUT_MS || 5_000,
    'timeout-ms',
  )
  if (timeoutMs > 60_000) {
    throw new Error('timeout-ms must be 60000 or less')
  }

  return {
    base,
    nodeURL,
    goURL,
    adminCookie,
    memberCookie,
    timeoutMs,
  }
}

export async function verifyDualAuthz({
  nodeURL,
  goURL,
  adminCookie = DEFAULT_AUTHZ_ADMIN_COOKIE,
  memberCookie = DEFAULT_AUTHZ_MEMBER_COOKIE,
  timeoutMs = 5_000,
  cases = AUTHZ_CASES,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function')
  }
  if (!nodeURL || !goURL) {
    throw new Error('nodeURL and goURL are required')
  }
  const normalized = {
    nodeURL: normalizeBaseURL(nodeURL),
    goURL: normalizeBaseURL(goURL),
    adminCookie: normalizeOptionalCookie(adminCookie),
    memberCookie: normalizeOptionalCookie(memberCookie),
    timeoutMs: parsePositiveInteger(timeoutMs, 'timeout-ms'),
  }

  const results = []
  const restoreProvider = await forceNodeProvider({
    nodeURL: normalized.nodeURL,
    adminCookie: normalized.adminCookie,
    timeoutMs: normalized.timeoutMs,
    fetchImpl,
  })
  try {
    for (const testCase of cases) {
      results.push(
        await compareAuthzCase({
          ...normalized,
          testCase,
          fetchImpl,
        }),
      )
    }
  } finally {
    await restoreProvider()
  }

  return {
    ok: results.every((result) => result.equal),
    total: results.length,
    failed: results.filter((result) => !result.equal).length,
    nodeURL: normalized.nodeURL,
    goURL: normalized.goURL,
    results,
  }
}

export function validateAuthzComparison(testCase, nodeResult, goResult) {
  const differences = []
  for (const [backendName, result] of [
    ['node', nodeResult],
    ['go', goResult],
  ]) {
    if (result.status !== testCase.expectedStatus) {
      differences.push({
        field: `${backendName}.status`,
        expected: testCase.expectedStatus,
        actual: result.status,
      })
    }
    if (result.backend !== backendName) {
      differences.push({
        field: `${backendName}.headers.x-chronoframe-backend`,
        expected: backendName,
        actual: result.backend,
      })
    }
    if (result.contentType !== 'application/json') {
      differences.push({
        field: `${backendName}.headers.content-type`,
        expected: 'application/json',
        actual: result.contentType,
      })
    }
    if (result.setCookie) {
      differences.push({
        field: `${backendName}.headers.set-cookie`,
        expected: 'absent',
        actual: 'present',
      })
    }
    if (result.requestId !== result.responseRequestId) {
      differences.push({
        field: `${backendName}.headers.x-request-id`,
        expected: result.requestId,
        actual: result.responseRequestId,
      })
    }
    if (
      testCase.expectedStatusMessage &&
      result.errorBody.statusMessage !== testCase.expectedStatusMessage
    ) {
      differences.push({
        field: `${backendName}.body.statusMessage`,
        expected: testCase.expectedStatusMessage,
        actual: result.errorBody.statusMessage,
      })
    }
    if (
      testCase.expectedData !== undefined &&
      JSON.stringify(result.errorBody.data) !==
        JSON.stringify(testCase.expectedData)
    ) {
      differences.push({
        field: `${backendName}.body.data`,
        expected: testCase.expectedData,
        actual: result.errorBody.data,
      })
    }
    if (testCase.expectedBody !== undefined) {
      const actualBody = selectComparableBody(
        testCase.bodyComparator,
        result.errorBody,
      )
      const expectedBody = selectComparableBody(
        testCase.bodyComparator,
        testCase.expectedBody,
      )
      if (JSON.stringify(actualBody) !== JSON.stringify(expectedBody)) {
        differences.push({
          field: `${backendName}.body`,
          expected: expectedBody,
          actual: actualBody,
        })
      }
    }
  }

  if (nodeResult.status !== goResult.status) {
    differences.push({
      field: 'status',
      node: nodeResult.status,
      go: goResult.status,
    })
  }
  const nodeError = selectErrorFields(nodeResult.errorBody)
  const goError = selectErrorFields(goResult.errorBody)
  if (JSON.stringify(nodeError) !== JSON.stringify(goError)) {
    differences.push({
      field: 'body.error',
      node: nodeError,
      go: goError,
    })
  }
  if (testCase.bodyComparator) {
    const nodeBody = selectComparableBody(
      testCase.bodyComparator,
      nodeResult.errorBody,
    )
    const goBody = selectComparableBody(
      testCase.bodyComparator,
      goResult.errorBody,
    )
    if (JSON.stringify(nodeBody) !== JSON.stringify(goBody)) {
      differences.push({
        field: `body.${testCase.bodyComparator}`,
        node: nodeBody,
        go: goBody,
      })
    }
  }
  return differences
}

async function compareAuthzCase({
  nodeURL,
  goURL,
  adminCookie,
  memberCookie,
  timeoutMs,
  testCase,
  fetchImpl,
}) {
  const requestId = `dual-authz-${randomUUID()}`
  const [nodeResult, goResult] = await Promise.all([
    executeAuthzRequest({
      baseURL: nodeURL,
      expectedBackend: 'node',
      adminCookie,
      memberCookie,
      timeoutMs,
      requestId,
      testCase,
      fetchImpl,
    }),
    executeAuthzRequest({
      baseURL: goURL,
      expectedBackend: 'go',
      adminCookie,
      memberCookie,
      timeoutMs,
      requestId,
      testCase,
      fetchImpl,
    }),
  ])
  const differences = validateAuthzComparison(testCase, nodeResult, goResult)
  return {
    equal: differences.length === 0,
    name: testCase.name,
    method: testCase.method,
    path: testCase.path,
    expectedStatus: testCase.expectedStatus,
    node: nodeResult,
    go: goResult,
    differences,
  }
}

async function executeAuthzRequest({
  baseURL,
  expectedBackend,
  adminCookie,
  memberCookie,
  timeoutMs,
  requestId,
  testCase,
  fetchImpl,
}) {
  const headers = {
    Accept: 'application/json',
    'Accept-Language': 'en',
    'X-Request-Id': requestId,
  }
  const cookie = resolveCookie(testCase.cookie, { adminCookie, memberCookie })
  if (cookie) headers.Cookie = cookie
  const body =
    testCase.rawBody === undefined
      ? testCase.body === undefined
        ? undefined
        : JSON.stringify(testCase.body)
      : testCase.rawBody
  if (testCase.contentType) {
    headers['Content-Type'] = testCase.contentType
  } else if (testCase.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  const response = await fetchImpl(joinBackendURL(baseURL, testCase.path), {
    method: testCase.method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  return {
    expectedBackend,
    status: response.status,
    backend: response.headers.get('x-chronoframe-backend'),
    contentType: normalizedContentType(response.headers.get('content-type')),
    setCookie: response.headers.has('set-cookie'),
    requestId,
    responseRequestId: response.headers.get('x-request-id'),
    errorBody: parseJSONBody(text),
  }
}

async function forceNodeProvider({
  nodeURL,
  adminCookie,
  timeoutMs,
  fetchImpl,
}) {
  const current = await executeControlRequest({
    baseURL: nodeURL,
    path: PROVIDER_SETTING_PATH,
    method: 'GET',
    adminCookie,
    timeoutMs,
    fetchImpl,
  })
  const originalProvider = current?.value === 'go' ? 'go' : 'node'
  if (originalProvider !== 'node') {
    await executeControlRequest({
      baseURL: nodeURL,
      path: PROVIDER_SETTING_PATH,
      method: 'PUT',
      adminCookie,
      timeoutMs,
      fetchImpl,
      body: { value: 'node' },
    })
  }
  return async () => {
    if (originalProvider === 'node') return
    await executeControlRequest({
      baseURL: nodeURL,
      path: PROVIDER_SETTING_PATH,
      method: 'PUT',
      adminCookie,
      timeoutMs,
      fetchImpl,
      body: { value: originalProvider },
    })
  }
}

async function executeControlRequest({
  baseURL,
  path,
  method,
  adminCookie,
  timeoutMs,
  fetchImpl,
  body,
}) {
  const headers = {
    Accept: 'application/json',
    'Accept-Language': 'en',
    'X-Request-Id': `dual-authz-control-${randomUUID()}`,
  }
  if (adminCookie) headers.Cookie = adminCookie
  const payload = body === undefined ? undefined : JSON.stringify(body)
  if (payload !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetchImpl(joinBackendURL(baseURL, path), {
    method,
    headers,
    body: payload,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  const parsed = parseJSONBody(text)
  if (!response.ok) {
    throw new Error(
      `Authz verifier control request failed: ${method} ${path} returned ${response.status}`,
    )
  }
  return parsed
}

function resolveCookie(kind, { adminCookie, memberCookie }) {
  switch (kind) {
    case undefined:
    case 'anonymous':
      return undefined
    case 'admin':
      return adminCookie
    case 'member':
      return memberCookie
    default:
      throw new Error(`Unknown authz cookie kind: ${kind}`)
  }
}

function selectErrorFields(body) {
  const selected = {}
  if (body === null || typeof body !== 'object') return selected
  for (const field of ERROR_FIELDS) {
    if (Object.hasOwn(body, field)) {
      selected[field] = body[field]
    }
  }
  return selected
}

function selectComparableBody(comparator, body) {
  switch (comparator) {
    case 'canonical':
      return canonicalize(body)
    case 'member-system-stats':
      return selectMemberSystemStatsBody(body)
    default:
      throw new Error(`Unknown authz body comparator: ${comparator}`)
  }
}

function selectMemberSystemStatsBody(body) {
  if (body === null || typeof body !== 'object') return body
  return {
    uptime: body.uptime,
    runningOn: body.runningOn,
    memory: body.memory,
    workerPool: body.workerPool,
    photos: body.photos,
    storage: body.storage,
    trends: Array.isArray(body.trends)
      ? body.trends.map((entry) => ({
          date: entry?.date,
          count: entry?.count,
        }))
      : body.trends,
  }
}

function parseJSONBody(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { parseError: true, raw: text.slice(0, 500) }
  }
}

function normalizedContentType(value) {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || ''
}

function parsePositiveInteger(value, label) {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return parsed
}

function normalizeBaseURL(value) {
  const url = new URL(value)
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/g, '') || '/'
  return url.toString().replace(/\/$/g, '')
}

function normalizeOptionalCookie(value) {
  const cookie = String(value || '').trim()
  return cookie || undefined
}

async function main() {
  const options = parseAuthzVerifierOptions()
  const result = await verifyDualAuthz(options)
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
