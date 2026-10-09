import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { cleanEnv, origin, ports, privateWrite } from './safety.mjs'
import { stripeCli } from './sandbox.mjs'
import { startLifecycle } from './lifecycle.mjs'
const state = process.argv[2], mirror = process.argv[3]
const require = createRequire(import.meta.url)
const config = JSON.parse(await readFile(join(state, 'config.json'), 'utf8'))
const key = (await readFile(join(state, 'stripe.env'), 'utf8')).trim().split('=')[1]
const children = []
let ending = false
let lifecycleWrite = Promise.resolve()
const actor = startLifecycle(value => { lifecycleWrite = lifecycleWrite.then(() => privateWrite(join(state, 'lifecycle.json'), JSON.stringify({ state: value, updatedAt: new Date().toISOString() }) + '\n')).catch(() => {}) })
actor.send({ type: 'UP' }); actor.send({ type: 'READY' })
function redact(line) { return line.replace(/\b(?:sk_test_|rk_test_|pk_test_|whsec_)[A-Za-z0-9_]+/g, '[redacted]') }
function child(name, command, args, env, onLine = () => {}) {
  const log = join(state, `${name}.log`)
  const proc = spawn(command, args, { cwd: mirror, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  children.push(proc)
  for (const stream of [proc.stdout, proc.stderr]) {
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', text => {
      buffer += text
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        onLine(line)
        appendFile(log, redact(line) + '\n', { mode: 0o600 }).catch(() => {})
      }
    })
  }
  proc.once('error', () => fail(name))
  proc.once('exit', () => { if (!ending) fail(name) })
  return proc
}
async function stop() {
  if (ending) return
  ending = true
  for (const proc of children) {
    if (proc.pid) try { process.kill(-proc.pid, 'SIGTERM') } catch {}
  }
  actor.send({ type: 'DOWN' })
  await privateWrite(join(state, 'status.json'), JSON.stringify({ status: 'down', run: config.run }) + '\n')
  setTimeout(() => {
    for (const proc of children) if (proc.pid) try { process.kill(-proc.pid, 'SIGKILL') } catch {}
    process.exit(0)
  }, 2000)
}
async function fail(step) {
  if (ending) return
  actor.send({ type: 'FAIL' })
  await privateWrite(join(state, 'failure.json'), JSON.stringify({ step, run: config.run, at: new Date().toISOString() }) + '\n')
  await stop()
}
process.on('SIGTERM', stop); process.on('SIGINT', stop)
setInterval(async () => {
  if (ending) return
  const metadata = await readFile(join(state, 'sandbox.json'), 'utf8').then(JSON.parse).catch(() => null)
  const expires = metadata?.leaseExpiresAt ?? metadata?.expiresAt
  if (expires && Date.parse(expires) <= Date.now()) await fail('stripe-key-lease-or-sandbox-expired')
}, 30000).unref()
const base = cleanEnv({ key, state, home: join(state, 'home') })
await mkdir(base.HOME, { recursive: true, mode: 0o700 })
let webhook
const stripeEnv = { PATH: base.PATH, HOME: base.HOME, LANG: base.LANG, STRIPE_API_KEY: key }
// Explicit auth and isolated config: never inherit a logged-in Stripe CLI profile.
child('stripe', 'npx', [...stripeCli, '--config', join(state, 'listener.toml'), '--api-key', key, 'listen', '--events', 'checkout.session.completed,charge.refunded,payment_intent.succeeded', '--forward-to', `${origin}/api/coursebuilder/webhook/stripe`], stripeEnv, line => {
  const match = line.match(/\bwhsec_[A-Za-z0-9]+\b/)
  if (match) webhook = match[0]
})
const deadline = Date.now() + 180000
while (!webhook && !ending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250))
if (!webhook || ending) { if (!ending) await fail('stripe-listener'); } else {
  const env = cleanEnv({ key, webhook, state, home: base.HOME })
  env.COMMERCE_RIG_OWNER = config.owner
  env.COMMERCE_RIG_RUN = config.run
  env.NODE_OPTIONS = `--require=${JSON.stringify(resolve(import.meta.dirname, 'network-guard.cjs'))}`
  await privateWrite(join(state, 'runtime.env'), Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n') + '\n')
  const inngestEnv = { PATH: base.PATH, HOME: base.HOME, LANG: base.LANG, INNGEST_DEV: '1', COMMERCE_RIG_OWNER: config.owner }
  child('inngest', 'npx', ['-y', 'inngest-cli@1.46.0', 'dev', '--no-discovery', '-u', `${origin}/api/inngest`, '--host', '127.0.0.1', '--port', String(ports.jobs), '--connect-gateway-port', String(ports.worker), '--connect-gateway-grpc-port', String(50052 + config.slot * 10), '--connect-executor-grpc-port', String(50053 + config.slot * 10)], inngestEnv)
  child('app', process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(ports.app)], env)
  const readyDeadline = Date.now() + 180000
  while (!ending && Date.now() < readyDeadline) {
    try {
      const [app, jobs] = await Promise.all([fetch(`${origin}/api/auth/session`, { signal: AbortSignal.timeout(3000) }), fetch(`http://127.0.0.1:${ports.jobs}/health`, { signal: AbortSignal.timeout(3000) })])
      if (app.ok && jobs.ok) {
        actor.send({ type: 'READY' })
        await privateWrite(join(state, 'status.json'), JSON.stringify({ status: 'running', run: config.run, webhookRoute: '/api/coursebuilder/webhook/stripe', app: origin, readyAt: new Date().toISOString() }) + '\n')
        break
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (!ending && actor.getSnapshot().value !== 'running') await fail('app-or-inngest-readiness')
}
