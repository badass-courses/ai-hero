import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertTestKey, privateWrite, readPrivateKey } from './safety.mjs'
import { provisioningProxy } from './provision-proxy.mjs'
const exec = promisify(execFile)
export const stripeCli = ['-y', '@stripe/cli@1.53.1']
export function keySource(env = process.env) {
  const mode = env.RIG_STRIPE ?? 'named'
  if (!['named', 'ephemeral'].includes(mode)) throw new Error('RIG_STRIPE must be named or ephemeral')
  if (env.RIG_STRIPE_KEY_SOURCE && env.RIG_STRIPE_KEY_FILE) throw new Error('Select only one Stripe key-source override')
  const source = env.RIG_STRIPE_KEY_SOURCE ?? (env.RIG_STRIPE_KEY_FILE ? `file:${env.RIG_STRIPE_KEY_FILE}` : mode === 'ephemeral' ? 'anonymous' : null)
  // No built-in default: the operator's local setup names the key source.
  if (!source) throw new Error('Stripe key source is not configured; set RIG_STRIPE_KEY_SOURCE')
  return source
}
export function keyPrefix(value) {
  // Return a structural prefix only, never entropy from a credential.
  return typeof value === 'string' ? value.match(/^[a-z]{1,16}_(?:test|live|sandbox|anon)_/)?.[0] ?? 'unrecognized-format' : 'missing'
}
export async function sandbox(state) {
  const source = keySource()
  if (source.startsWith('file:')) {
    const key = await readPrivateKey(source.slice(5))
    await privateWrite(join(state, 'stripe.env'), `STRIPE_SECRET_TOKEN=${key}\n`)
    // Replace any earlier lease record so the supervisor does not expire a permanent key.
    await privateWrite(join(state, 'sandbox.json'), JSON.stringify({ source: 'operator-file', expiresAt: null }, null, 2) + '\n')
    return { key, source: 'operator-file', expiresAt: null }
  }
  if (source.startsWith('agent-secrets:')) {
    let result
    try { result = await exec('secrets', ['--no-update-check', 'lease', source.slice(14), '--ttl', '1h', '--client-id', 'aihero-commerce-rig'], { timeout: 10000, maxBuffer: 16384 }) }
    catch { throw new Error('Stripe test key lease failed') }
    const key = assertTestKey(result.stdout.trim())
    await privateWrite(join(state, 'stripe.env'), `STRIPE_SECRET_TOKEN=${key}\n`)
    const metadata = { source: 'agent-secrets', leasedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 3600000).toISOString(), expiresAt: null }
    await privateWrite(join(state, 'sandbox.json'), JSON.stringify(metadata, null, 2) + '\n')
    return { ...metadata, key }
  }
  if (source !== 'anonymous') throw new Error('RIG_STRIPE_KEY_SOURCE must be agent-secrets:<name>, file:<path>, or anonymous')
  const keyFile = join(state, 'stripe.key')
  const metadataFile = join(state, 'sandbox.json')
  const metadata = await readFile(metadataFile, 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (metadata?.source === 'anonymous-cli' && metadata.status === 'blocked-key-prefix') throw new Error('Anonymous sandbox key has an unsupported prefix; named test keys work, reset the candidate before retrying')
  if (metadata?.source === 'anonymous-cli' && metadata.status === 'ready' && metadata.expiresAt && Date.parse(metadata.expiresAt) > Date.now()) {
    return { ...metadata, key: await readPrivateKey(keyFile) }
  }
  const home = join(state, `stripe-home-${Date.now()}`)
  await mkdir(home, { recursive: true, mode: 0o700 })
  const config = join(home, 'config.toml')
  let output
  const proxy = await provisioningProxy()
  try {
    const result = await exec('npx', [...stripeCli, '--config', config, 'sandbox', 'create', '--non-interactive', '--email', 'commerce-rig@example.test'], {
      env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', BROWSER: '/bin/false', HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, https_proxy: proxy.url, http_proxy: proxy.url, NO_PROXY: '127.0.0.1,localhost' },
      timeout: 180000, maxBuffer: 2 * 1024 * 1024,
    })
    output = result.stdout + '\n' + result.stderr
  } catch (error) {
    await privateWrite(join(home, 'provision-failure.txt'), String(error.stdout ?? '') + '\n' + String(error.stderr ?? ''))
    throw new Error('Anonymous sandbox provisioning failed; account-login network is blocked, inspect private provision-failure.txt')
  } finally { proxy.close() }
  // CLI output and profile can contain claim links and credentials. Keep both private.
  await privateWrite(join(home, 'provision-output.txt'), output)
  const responseText = output.match(/\{[\s\S]*?"secret_key"[\s\S]*?\}/)?.[0]
  const response = responseText ? JSON.parse(responseText) : null
  if (!response?.account_id || !response?.expires_at || !Number.isFinite(Date.parse(response.expires_at))) throw new Error('Anonymous sandbox did not report its id and expiry')
  const expiresAt = new Date(response.expires_at).toISOString()
  const result = { source: 'anonymous-cli', status: 'blocked-key-prefix', createdAt: new Date().toISOString(), sandboxId: response.account_id, expiresAt, keyPrefix: keyPrefix(response.secret_key), expiryEvidence: 'CLI response', profile: config }
  await privateWrite(config, await readFile(config, 'utf8'))
  await privateWrite(metadataFile, JSON.stringify(result, null, 2) + '\n')
  const key = assertTestKey(response?.secret_key)
  result.status = 'ready'
  await privateWrite(keyFile, key + '\n')
  await privateWrite(join(state, 'stripe.env'), `STRIPE_SECRET_TOKEN=${key}\n`)
  await privateWrite(metadataFile, JSON.stringify(result, null, 2) + '\n')
  return { ...result, key }
}
if (process.argv[1]?.endsWith('/sandbox.mjs')) {
  const state = process.argv[2]
  if (!state) throw new Error('A private state directory is required')
  await mkdir(state, { recursive: true, mode: 0o700 })
  try {
    const result = await sandbox(state)
    console.log(JSON.stringify({ source: result.source, expiresAt: result.expiresAt, expiryEvidence: result.expiryEvidence }))
  } catch { console.error('Sandbox provisioning blocked. No credentials printed.'); process.exitCode = 1 }
}
