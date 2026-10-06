import { afterAll, beforeEach, expect, vi } from 'vitest'
import { deniedDatabaseOperations } from './db-guard-state'
// No real app env/server/DB/Redis bootstrap. These guards are software mocks,
// not an OS network sandbox. Every HTTP transport under test must be injected.
vi.mock('@/env.mjs', () => ({ env: {} }))
vi.mock('@/server/logger', () => ({ log: { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} } }))
vi.mock('@/lib/subscriber-marketing/drovr-shadow-dispatch', () => ({ dispatchDrovrShadowFactSafely: () => {} }))
vi.mock('@/server/redis-client', () => ({
 redis: new Proxy({}, { get: () => () => { throw new Error('REAL_REDIS_CALL_DENIED') } }),
}))
vi.mock('@/inngest/inngest.server', () => { throw new Error('REAL_INNGEST_IMPORT_DENIED') })
beforeEach(() => {
 vi.stubGlobal('fetch', () => { throw new Error('REAL_PROVIDER_FETCH_DENIED') })
 vi.stubGlobal('WebSocket', () => { throw new Error('REAL_NETWORK_SOCKET_DENIED') })
})

 // Named route fixtures import ports before installing their own fakes.
 // Model imports without constructing clients; unexpected uses fail.
 // Per-fixture vi.mock overrides own synthetic behavior.
 vi.mock('@/coursebuilder/email-list-provider', () => ({
  emailListProvider: new Proxy({}, { get: () => () => { throw new Error('REAL_EMAIL_LIST_PROVIDER_CALL_DENIED') } }),
 }))
 vi.mock('@/server/with-skill', () => ({
  withSkill: (handler: (request: Request) => unknown) => handler,
 }))

 // Sticky audit: a caught DB denial is STILL a failed suite. Never clear it.
 afterAll(() => {
  const operations = [...deniedDatabaseOperations]
  console.info('DB_IMPORT_STUB_AUDIT', JSON.stringify({ file: expect.getState().testPath, operations }))
  expect(operations, 'Any runtime use of the import-only DB/schema port is a real finding').toEqual([])
 })
