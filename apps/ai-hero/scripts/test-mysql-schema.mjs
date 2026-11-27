// @ts-nocheck: untyped Node operator tooling for scripts/test-mysql.sh; not app code.
// Usage: node scripts/test-mysql-schema.mjs <mysql://root:...@127.0.0.1:<port>/<db>>
import { deepStrictEqual } from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import mysql from 'mysql2/promise'
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

async function checkCouponBatchMigration(databaseUrl, mirror) {
  const scratch = `aih_batch_ddl_${randomUUID().replaceAll('-', '')}`
  const tables = ['Control', 'Grant', '', 'Item', 'Intent', 'Day', 'Alert']
    .map(suffix => `AI_CouponBatch${suffix}`).sort()
  const connection = await mysql.createConnection({ uri: databaseUrl, multipleStatements: true })
  const generated = new URL(databaseUrl).pathname.slice(1)
  let created = false
  try {
    await connection.query(`CREATE DATABASE \`${scratch}\``)
    created = true
    await connection.query(`USE \`${scratch}\``)
    const migration = await readFile(join(mirror, 'src/db/migrations/20261126_ai_hero_coupon_batches.sql'), 'utf8')
    await connection.query(migration)
    const [actual] = await connection.query('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()')
    deepStrictEqual(actual.map(row => row.name).sort(), tables)
    for (const table of tables) {
      const [expected] = await connection.query(`SHOW CREATE TABLE \`${generated}\`.\`${table}\``)
      const [applied] = await connection.query(`SHOW CREATE TABLE \`${scratch}\`.\`${table}\``)
      deepStrictEqual(applied[0]['Create Table'], expected[0]['Create Table'], `Migration drift: ${table}`)
    }
    console.log(`Coupon batch migration matches Drizzle (${tables.length} tables)`)
  } finally {
    try {
      if (created) await connection.query(`DROP DATABASE \`${scratch}\``)
    } finally {
      await connection.end()
    }
  }
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
  if (process.argv.includes('--check-coupon-batch-migration'))
    await checkCouponBatchMigration(databaseUrl, mirror)
} finally {
  await rm(state, { recursive: true, force: true })
}
