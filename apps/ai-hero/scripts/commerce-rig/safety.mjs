// @ts-nocheck: untyped Node operator tooling, covered by rig.test.mjs; not app code.
import { randomBytes } from 'node:crypto'
import { chmod, lstat, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export const slot = Number(process.env.RIG_SLOT ?? 0)
if (!Number.isInteger(slot) || slot < 0 || slot > 9) throw new Error('RIG_SLOT must be an integer from 0 to 9')
// Inngest's default 8288 is often taken by a real Inngest server; the rig never shares it.
export const ports = { db: 13316 + slot * 10, app: 3310 + slot * 10, frontDesk: 3311 + slot * 10, jobs: 18288 + slot * 10, worker: 18289 + slot * 10, gatewayGrpc: 18290 + slot * 10, executorGrpc: 18291 + slot * 10 }
export const databaseUrl = `mysql://rig:rig-local-only@127.0.0.1:${ports.db}/commerce_rig`
export const origin = `http://127.0.0.1:${ports.app}`
export function assertDatabase(value) {
  if (value !== databaseUrl) throw new Error('Refusing a database other than the rig loopback database')
  return value
}
export function assertTestKey(value) {
  if (!/^(sk_test_|rk_test_)[A-Za-z0-9]+$/.test(value ?? '')) throw new Error('Only Stripe test-mode secret/restricted keys are allowed')
  return value
}
export function assertTestObject(value) {
  if (value?.livemode !== false) throw new Error('Stripe object is not explicitly test-mode')
  return value
}
export async function privateWrite(path, value) {
  // Refuse symlinks rather than chmod or overwrite a foreign file.
  const stat = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (stat?.isSymbolicLink()) throw new Error('Refusing a symlink in private state')
  // Write then rename, so a concurrent reader never sees a half-written file.
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, value, { mode: 0o600, flag: 'wx' })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}
export async function readCatalogOverlay(path) {
  if (!path) return null
  if (!isAbsolute(path)) throw new Error('RIG_CATALOG_OVERLAY must be an absolute path')
  const stat = await lstat(path)
  if (!stat.isFile()) throw new Error('Catalog overlay must be a regular file')
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error('Catalog overlay is not valid JSON') }
}
export async function readPrivateKey(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Key source must be a private regular file (mode 0600)')
  const text = (await readFile(path, 'utf8')).trim()
  const assignment = text.match(/^(?:AIH_RIG_STRIPE_SECRET_KEY|STRIPE_SECRET_TOKEN)=(.+)$/m)
  return assertTestKey((assignment?.[1] ?? text).trim())
}
export function cleanEnv({ key = 'sk_test_RigPlaceholder', webhook = 'whsec_rig_placeholder', state, home, path = process.env.PATH }) {
  assertTestKey(key)
  const env = {
    PATH: path, HOME: home, LANG: 'C.UTF-8', NODE_ENV: 'development',
    DATABASE_URL: assertDatabase(databaseUrl), DATABASE_POOL_SIZE: '4',
    NEXTAUTH_URL: origin, COURSEBUILDER_URL: origin, NEXT_PUBLIC_URL: origin,
    NEXTAUTH_SECRET: 'commerce-rig-local-auth-secret-not-for-deployment',
    PERSONAL_ACCESS_TOKEN_SECRET: 'commerce-rig-local-pat-secret-not-for-deployment',
    STRIPE_SECRET_TOKEN: key, STRIPE_WEBHOOK_SECRET: webhook,
    INNGEST_DEV: `http://127.0.0.1:${ports.jobs}`, INNGEST_BASE_URL: `http://127.0.0.1:${ports.jobs}`, RIG_SLOT: String(slot),
    INNGEST_EVENT_KEY: 'rig-local', INNGEST_SIGNING_KEY: 'rig-local',
    OPENAI_MODEL_ID: 'disabled', UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:9',
    UPLOADTHING_URL: 'http://127.0.0.1:9', CONVERTKIT_SIGNUP_FORM: '0',
    NEXT_PUBLIC_APP_NAME: 'Commerce Rig', NEXT_PUBLIC_SITE_TITLE: 'Commerce Rig',
    NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.test',
    NEXT_PUBLIC_PARTYKIT_ROOM_NAME: 'disabled', NEXT_PUBLIC_PARTY_KIT_URL: 'http://127.0.0.1:9',
    NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME: 'disabled', NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET: 'disabled',
    COMMERCE_RIG_STATE: state, NEXT_TELEMETRY_DISABLED: '1',
  }
  for (const name of ['OPENAI_API_KEY', 'MUX_SECRET_KEY', 'MUX_ACCESS_TOKEN_ID', 'UPSTASH_REDIS_REST_TOKEN', 'DEEPGRAM_API_KEY', 'POSTMARK_API_KEY', 'POSTMARK_WEBHOOK_SECRET', 'CONVERTKIT_API_SECRET', 'CONVERTKIT_API_KEY', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) env[name] = 'rig-disabled'
  return env
}
export function freshToken() { return randomBytes(32).toString('hex') }
export function publicSession(session) {
  assertTestObject(session)
  if (session.currency !== 'usd' || !Number.isSafeInteger(session.amount_total)) throw new Error('Unexpected checkout currency/amount')
  return { id: session.id, ...(session.metadata?.decisionRef ? { decisionRef: session.metadata.decisionRef } : {}), currency: session.currency, subtotal: session.amount_subtotal, discount: session.total_details?.amount_discount, tax: session.total_details?.amount_tax, total: session.amount_total, paymentStatus: session.payment_status, status: session.status }
}
