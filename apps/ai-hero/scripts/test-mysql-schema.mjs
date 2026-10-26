// @ts-nocheck: untyped Node operator tooling for scripts/test-mysql.sh; not app code.
// Usage: node scripts/test-mysql-schema.mjs <mysql://root:...@127.0.0.1:<port>/<db>>
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyGeneratedSchema } from './commerce-rig/schema.mjs'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const SYSTEM_DATABASES = new Set(['mysql', 'sys', 'information_schema', 'performance_schema'])

// Only a disposable loopback database: never a remote host or a system schema.
function assertDisposableDatabase(rawUrl) {
  const url = new URL(rawUrl ?? '')
  const database = url.pathname.slice(1)
  if (
    url.protocol !== 'mysql:' ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    !/^[a-z0-9_]{1,64}$/.test(database) ||
    SYSTEM_DATABASES.has(database)
  ) {
    throw new Error('Refusing a database that is not a disposable loopback test database')
  }
  return url.toString()
}

const databaseUrl = assertDisposableDatabase(process.argv[2])
const mirror = join(dirname(fileURLToPath(import.meta.url)), '..')
const state = await mkdtemp(join(tmpdir(), 'aih-test-mysql-schema-'))
try {
  const result = await applyGeneratedSchema({
    mirror,
    state,
    env: process.env,
    databaseUrl,
    configDir: state,
  })
  console.log(JSON.stringify(result))
} finally {
  await rm(state, { recursive: true, force: true })
}
