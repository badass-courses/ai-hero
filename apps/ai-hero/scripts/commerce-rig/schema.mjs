import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import mysql from 'mysql2/promise'
import { assertDatabase, privateWrite } from './safety.mjs'
const exec = promisify(execFile)
const require = createRequire(import.meta.url)

// drizzle-kit push reported success on MySQL 8 while rejecting
// `timestamp(3) ... ON UPDATE CURRENT_TIMESTAMP`. The rig therefore generates
// the app's DDL from its own schema, applies a rig-only overlay, executes each
// statement with errors fatal, and proves every snapshot table and column exists.
export function overlay(statement) {
  return statement.replace(/(`[^`]+`\s+timestamp\((\d)\)[^,\n]*?ON UPDATE CURRENT_TIMESTAMP)(?!\()/gi, '$1($2)')
}
export function splitStatements(sql) {
  return sql.split('--> statement-breakpoint').map(part => part.trim()).filter(Boolean)
}
export function missingSchema(snapshot, columns) {
  const present = new Map()
  for (const { table, column } of columns) {
    if (!present.has(table)) present.set(table, new Set())
    present.get(table).add(column)
  }
  const missing = []
  for (const [table, definition] of Object.entries(snapshot.tables ?? {})) {
    if (!present.has(table)) { missing.push(table); continue }
    for (const column of Object.keys(definition.columns ?? {})) {
      if (!present.get(table).has(column)) missing.push(`${table}.${column}`)
    }
  }
  return missing
}
export async function applySchema({ mirror, state, env, databaseUrl }) {
  const out = join(state, 'drizzle')
  // Fresh output keeps the migration a complete CREATE set rather than a diff.
  await rm(out, { recursive: true, force: true })
  const config = join(mirror, 'commerce-rig.drizzle.config.mjs')
  await privateWrite(config, `export default ${JSON.stringify({ schema: ['./src/db/schema.ts'], dialect: 'mysql', tablesFilter: ['AI_*'], out })}\n`)
  try {
    // Direct binary: an isolated HOME makes corepack try to download pnpm.
    await exec(process.execPath, [join(dirname(require.resolve('drizzle-kit/api')), 'bin.cjs'), 'generate', `--config=${config}`, '--name=rig'], { cwd: mirror, env, timeout: 240000, maxBuffer: 4 * 1024 * 1024 })
  } catch (error) {
    await privateWrite(join(state, 'schema-error.log'), `${error.stdout ?? ''}\n${error.stderr ?? ''}`.replace(/(?:sk_test_|rk_test_|whsec_)[A-Za-z0-9_]+/g, '[redacted]'))
    throw new Error('drizzle-kit generate failed in the isolated directory; inspect private schema-error.log')
  }
  const files = (await readdir(out)).filter(name => name.endsWith('.sql'))
  if (files.length !== 1) throw new Error(`Expected one generated migration, found ${files.length}`)
  const generated = splitStatements(await readFile(join(out, files[0]), 'utf8'))
  const statements = generated.map(overlay)
  const snapshot = JSON.parse(await readFile(join(out, 'meta', '0000_snapshot.json'), 'utf8'))
  const expectedTables = Object.keys(snapshot.tables ?? {})
  if (!expectedTables.length || !statements.length) throw new Error('Generated schema is empty')
  const connection = await mysql.createConnection({ uri: assertDatabase(databaseUrl), multipleStatements: false })
  const log = []
  try {
    const [existing] = await connection.query('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE()')
    // A populated database is only verified. A partial apply fails the check and needs reset.
    const fresh = Number(existing[0].count) === 0
    for (const [index, statement] of (fresh ? statements : []).entries()) {
      try { await connection.query(statement) }
      catch (error) {
        const target = statement.match(/^(?:CREATE TABLE|ALTER TABLE|CREATE (?:UNIQUE )?INDEX [^\s]+ ON)\s+`([^`]+)`/i)?.[1] ?? 'unknown'
        throw new Error(`Schema statement ${index + 1}/${statements.length} failed on ${target}: ${error.code ?? 'error'}`)
      }
      log.push({ index: index + 1, overlaid: statement !== generated[index] })
    }
    const [columns] = await connection.query('SELECT table_name AS `table`, column_name AS `column` FROM information_schema.columns WHERE table_schema = DATABASE()')
    const missing = missingSchema(snapshot, columns)
    if (missing.length) throw new Error(`Schema did not apply: ${missing.length} missing tables/columns, first ${missing.slice(0, 3).join(', ')}`)
    const result = { mode: fresh ? 'applied' : 'verified-existing', tables: expectedTables.length, statements: log.length, overlaid: log.filter(item => item.overlaid).length }
    await privateWrite(join(state, 'schema.json'), JSON.stringify({ ...result, appliedAt: new Date().toISOString() }, null, 2) + '\n')
    return result
  } finally { await connection.end() }
}
