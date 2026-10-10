#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, symlink, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import net from 'node:net'
import Stripe from 'stripe'
import { catalog, fixtures } from './fixtures.mjs'
import { assertDatabase, cleanEnv, databaseUrl, origin, ports, privateWrite, readPrivateKey, slot } from './safety.mjs'
import { sandbox } from './sandbox.mjs'
import { archiveRun } from './stripe-state.mjs'
import { checkout } from './checkout.mjs'
import { connect, seed } from './seed.mjs'
import { applySchema } from './schema.mjs'
const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const dir = dirname(fileURLToPath(import.meta.url)), app = resolve(dir, '../..')
const state = join(dir, '.state', `slot-${slot}`), mirror = join(state, 'app')
const owner = createHash('sha256').update(dir + ':' + slot).digest('hex').slice(0, 16)
const project = `aihero-rig-${owner}`
let currentStep = 'preflight'
async function json(path) { return readFile(path, 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; return null }) }
async function step(label, run) {
  currentStep = label
  const result = await run()
  console.log(`ok ${label}`)
  return result
}
async function privateDirectory(path) {
  const stat = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Private state is not a regular directory')
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}
async function compose(args) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', RIG_DB_PORT: String(ports.db) }
  try { return await exec('docker', ['compose', '--project-name', project, '--file', join(dir, 'compose.yml'), ...args], { env, timeout: 240000, maxBuffer: 2 * 1024 * 1024 }) }
  catch (error) {
    await privateWrite(join(state, 'docker-error.log'), String(error.stderr ?? 'Docker command failed'))
    throw new Error('Docker failed; inspect private docker-error.log (socket access, image, or port conflict)')
  }
}
async function prepareMirror() {
  await privateDirectory(mirror)
  // A real copy: Turbopack does not discover routes through a symlinked src/app.
  // Every original .env* file is excluded; the rig writes its own .env.local.
  await exec('rsync', ['-a', '--delete', '--exclude=/node_modules', '--exclude=/.next', '--exclude=/.env*', '--exclude=/next-env.d.ts', '--exclude=/next.config.mjs', '--exclude=/commerce-rig.drizzle.config.mjs', '--exclude=/scripts/commerce-rig/.state', `${app}/`, `${mirror}/`], { timeout: 240000, maxBuffer: 2 * 1024 * 1024 })
  const modules = join(mirror, 'node_modules')
  if (!(await lstat(modules).catch(() => null))) await symlink(join(app, 'node_modules'), modules)
  // Turbopack otherwise infers its root from any lockfile above the mirror,
  // including ones outside the repo. Pin it to the monorepo, unchanged otherwise.
  const original = join(app, 'next.config.mjs'), root = resolve(app, '../..')
  // Mirrors from earlier rig versions linked the original config here.
  if ((await lstat(join(mirror, 'next.config.mjs')).catch(() => null))?.isSymbolicLink()) await unlink(join(mirror, 'next.config.mjs'))
  await privateWrite(join(mirror, 'next.config.mjs'), [
    `const base = (await import(${JSON.stringify(original)})).default`,
    'export default async (phase, context) => {',
    '  const config = typeof base === \'function\' ? await base(phase, context) : base',
    // A persisted dev cache outlived mirror refreshes and served stale route tables.
    `  return { ...config, experimental: { ...config.experimental, turbopackFileSystemCacheForDev: false }, turbopack: { ...config.turbopack, root: ${JSON.stringify(root)} } }`,
    '}',
  ].join('\n') + '\n')
}
async function ownedSupervisor() {
  const info = await json(join(state, 'supervisor.json'))
  if (!info || info.owner !== owner || !Number.isInteger(info.pid)) return null
  try {
    const { env, cmd } = await processIdentity(info.pid)
    if (!env.includes(`COMMERCE_RIG_OWNER=${owner}`) || !cmd.includes(join(dir, 'serve.mjs')) || !cmd.includes(state)) return null
    return info
  } catch { return null }
}
// Linux exposes /proc; macOS shows a same-user process environment through `ps eww`.
async function processIdentity(pid) {
  if (process.platform === 'linux') {
    const env = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0')
    return { env, cmd: (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').join(' ') }
  }
  const { stdout: cmd } = await exec('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 })
  const { stdout: withEnv } = await exec('ps', ['eww', '-p', String(pid), '-o', 'command='], { timeout: 5000 })
  return { env: withEnv.trim().split(/\s+/), cmd: cmd.trim() }
}
async function stop() {
  const info = await ownedSupervisor()
  if (!info) return
  process.kill(info.pid, 'SIGTERM')
  const deadline = Date.now() + 10000
  while (await ownedSupervisor()) {
    if (Date.now() > deadline) throw new Error('Owned supervisor did not stop; not killing an unverified process')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
async function healthy() {
  if (!await ownedSupervisor()) return false
  const status = await json(join(state, 'status.json'))
  if (status?.status !== 'running') return false
  try {
    const appResponse = await fetch(`${origin}/api/auth/session`, { signal: AbortSignal.timeout(5000) })
    const jobsResponse = await fetch(`http://127.0.0.1:${ports.jobs}/health`, { signal: AbortSignal.timeout(5000) })
    // A real Inngest server answers /health too; only the local dev server counts.
    return appResponse.ok && jobsResponse.ok && jobsResponse.headers.get('x-inngest-server-kind') === 'dev'
  } catch { return false }
}
// Inngest silently moves to another port on conflict, and the app would then talk
// to whatever owns the configured one. Refuse to start instead.
async function assertPortsFree() {
  for (const port of [ports.app, ports.jobs, ports.worker, ports.gatewayGrpc, ports.executorGrpc]) {
    const busy = await new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.setTimeout(1000)
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('timeout', () => { socket.destroy(); resolve(false) })
      socket.once('error', () => resolve(false))
    })
    if (busy) throw new Error(`Port ${port} is already in use on 127.0.0.1; pick another RIG_SLOT or stop its owner`)
  }
}
async function runtimeKey() {
  if ((process.env.RIG_STRIPE ?? 'named') === 'named') return (await sandbox(state)).key
  return readPrivateKey(join(state, 'stripe.env'))
}
async function up() {
  await step('docker-mysql', () => compose(['up', '-d', '--wait']))
  // Validate the run's Stripe mode before reusing or renewing anything for it.
  const saved = await json(join(state, 'config.json'))
  if (saved && saved.stripeMode !== (process.env.RIG_STRIPE ?? 'named')) throw new Error('Stripe mode changed; down and reset before changing modes')
  if (await healthy()) {
    if ((process.env.RIG_STRIPE ?? 'named') === 'named') await step('renew-test-key-lease', () => sandbox(state))
    console.log('ok schema/fixtures/catalog/listener/inngest/app already running')
    return
  }
  await stop()
  await step('ports-free', assertPortsFree)
  await step('isolated-app-directory', prepareMirror)
  let config = await json(join(state, 'config.json'))
  if (!config) {
    config = { run: randomUUID(), owner, slot, stripeMode: process.env.RIG_STRIPE ?? 'named' }
    await privateWrite(join(state, 'config.json'), JSON.stringify(config, null, 2) + '\n')
  }
  if (config.stripeMode !== (process.env.RIG_STRIPE ?? 'named')) throw new Error('Stripe mode changed; down and reset before changing modes')
  const { key } = await step('stripe-test-key', () => sandbox(state))
  const env = cleanEnv({ key, state, home: join(state, 'home') })
  await privateDirectory(env.HOME)
  // db:push and Next never read the original checkout's .env files.
  await privateWrite(join(mirror, '.env.local'), Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n') + '\n')
  env.NODE_OPTIONS = `--require=${JSON.stringify(join(dir, 'network-guard.cjs'))}`
  await step('schema-apply-and-verify', () => applySchema({ mirror, state, env, databaseUrl }))
  process.env.DATABASE_URL = assertDatabase(databaseUrl)
  process.env.STRIPE_SECRET_TOKEN = key
  const priorSeed = await json(join(state, 'seed.json'))
  await step('synthetic-fixtures-and-stripe-catalog', async () => {
    if (priorSeed?.generation === config.run && priorSeed.stripeSeeded) {
      const { db, close } = await connect()
      try {
        const buyer = await db.query.users.findFirst()
        if (buyer?.fields?.commerceRig !== config.run) throw new Error('Database does not match the saved run; reset required')
      } finally { await close() }
      return
    }
    await seed(state, config.run)
  })
  // The app's prebuild compiles these workspace packages; their exports point at dist/.
  await step('workspace-packages', async () => {
    try {
      await exec('pnpm', ['--filter', '@ai-hero/course-sync-schema', '--filter', '@ai-hero/front-desk-support', 'build'], { cwd: resolve(app, '../..'), env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' }, timeout: 240000, maxBuffer: 4 * 1024 * 1024 })
    } catch (error) {
      await privateWrite(join(state, 'workspace-build.log'), `${error.stdout ?? ''}\n${error.stderr ?? ''}`)
      throw new Error('Workspace package build failed; inspect private workspace-build.log')
    }
  })
  await step('listener-inngest-app', async () => {
    // A previous attempt's failure must not fail this start.
    await unlink(join(state, 'failure.json')).catch(error => { if (error.code !== 'ENOENT') throw error })
    const daemonEnv = { PATH: process.env.PATH, HOME: env.HOME, LANG: env.LANG, RIG_SLOT: String(slot), COMMERCE_RIG_OWNER: owner }
    const proc = spawn(process.execPath, [join(dir, 'serve.mjs'), state, mirror], { cwd: app, env: daemonEnv, detached: true, stdio: 'ignore' })
    proc.unref()
    await privateWrite(join(state, 'supervisor.json'), JSON.stringify({ pid: proc.pid, owner, run: config.run }) + '\n')
    const deadline = Date.now() + 360000
    while (Date.now() < deadline) {
      if (await healthy()) return
      const failure = await json(join(state, 'failure.json'))
      if (failure?.run === config.run) throw new Error(`Supervisor failed at ${failure.step}; inspect private service logs`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    await stop()
    throw new Error('Service startup timed out; no running proof')
  })
  console.log(`ok rig ready: ${origin}; run ${config.run}`)
}
async function reset() {
  await step('stop-owned-services', stop)
  const config = await json(join(state, 'config.json'))
  if (config) {
    const key = await runtimeKey()
    await step('archive-old-stripe-catalog-and-expire-sessions', () => archiveRun(new Stripe(key), state, config.run))
  }
  await step('docker-mysql', () => compose(['up', '-d', '--wait']))
  await step('drop-only-rig-database', () => compose(['exec', '-T', '-e', 'MYSQL_PWD=root-local-only', 'db', 'mysql', '-uroot', '-e', 'DROP DATABASE IF EXISTS commerce_rig; CREATE DATABASE commerce_rig; GRANT ALL ON commerce_rig.* TO \'rig\'@\'%\';']))
  // Preserve the old receipts and journal before starting the next run.
  if (config) {
    const archive = join(state, 'runs', config.run)
    await privateDirectory(archive)
    for (const name of await readdir(state)) {
      if (name.endsWith('.json') || name.startsWith('checkout-')) {
        const source = join(state, name)
        if ((await lstat(source)).isFile()) await copyFile(source, join(archive, name))
      }
    }
  }
  for (const name of ['config.json', 'seed.json', 'artifacts.json', 'failure.json', 'status.json']) {
    await unlink(join(state, name)).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  if ((process.env.RIG_STRIPE ?? 'named') === 'ephemeral') {
    await unlink(join(state, 'sandbox.json')).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  await up()
}
async function prices() {
  if (!await healthy()) throw new Error('Rig is not running; run rig up first')
  process.env.DATABASE_URL = databaseUrl
  const key = await runtimeKey()
  const rows = []
  for (const fixture of fixtures) {
    try {
      const receipt = await checkout(state, key, fixture.key)
      rows.push({ fixture: fixture.key, quantity: fixture.quantity, subtotalCents: receipt.createdSession.subtotal, discountCents: receipt.createdSession.discount, totalCents: receipt.createdSession.total, pendingFacts: receipt.pendingFacts, basis: receipt.catalogBasis, commit: receipt.commit, dirty: receipt.dirty })
    } catch (error) { rows.push({ fixture: fixture.key, quantity: fixture.quantity, status: 'blocked', reason: String(error.message).replace(/(?:sk_test_|rk_test_|whsec_)[A-Za-z0-9_]+/g, '[redacted]'), pendingFacts: fixture.pending ?? null }) }
  }
  await privateWrite(join(state, 'price-table.json'), JSON.stringify(rows, null, 2) + '\n')
  console.table(rows.map(row => ({ fixture: row.fixture, quantity: row.quantity, total: row.totalCents === undefined ? 'blocked' : (row.totalCents / 100).toFixed(2), pending: row.pendingFacts ?? row.reason ?? '' })))
}
const command = process.argv[2]
if (command === 'fixtures') { console.table(fixtures.map(({ key, quantity, pending }) => ({ fixture: key, quantity, pending: pending ?? '' }))); process.exit(0) }
if (!['up', 'reset', 'down', 'checkout', 'prices', 'status'].includes(command)) {
  console.log('Usage: rig up | reset | down | checkout <fixture> [--complete] | prices | fixtures | status')
  process.exit(command ? 1 : 0)
}
await privateDirectory(join(dir, '.state')); await privateDirectory(state)
const lockPath = join(state, 'command.lock')
let lock
try {
  lock = await open(lockPath, 'wx', 0o600)
  await lock.writeFile(JSON.stringify({ pid: process.pid, owner }))
  switch (command) {
    case 'up': await up(); break
    case 'reset': await reset(); break
    case 'down': await step('stop-owned-services', stop); await step('docker-down-preserve-volume', () => compose(['down'])); break
    case 'checkout': {
      if (!await healthy()) throw new Error('Rig is not running; run rig up first')
      process.env.DATABASE_URL = databaseUrl
      await checkout(state, await runtimeKey(), process.argv[3], process.argv.includes('--complete'))
      break
    }
    case 'prices': await prices(); break
    case 'status': console.log(JSON.stringify({ healthy: await healthy(), ...(await json(join(state, 'status.json')) ?? {}), sandbox: await json(join(state, 'sandbox.json')) }, null, 2)); break
  }
} catch (error) {
  const message = error.code === 'EEXIST' ? 'another rig command owns command.lock; verify its PID before removing a stale lock' : String(error.message).replace(/(?:sk_test_|rk_test_|whsec_)[A-Za-z0-9_]+/g, '[redacted]')
  console.error(`fail ${currentStep}: ${message}`)
  await privateWrite(join(state, 'command-failure.json'), JSON.stringify({ command, step: currentStep, message, at: new Date().toISOString() }) + '\n')
  process.exitCode = 1
} finally {
  if (lock) { await lock.close(); await unlink(lockPath) }
}
