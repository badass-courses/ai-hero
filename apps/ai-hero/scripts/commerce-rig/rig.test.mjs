import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, chmod, mkdir, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { getTableColumns } from 'drizzle-orm'
import { catalog, fixtures, fixtureFor } from './fixtures.mjs'
import { assertDatabase, assertTestKey, assertTestObject, cleanEnv, databaseUrl, origin, privateWrite, readPrivateKey, publicSession } from './safety.mjs'
import { provesAccess } from './checkout.mjs'
import { tables } from './seed.mjs'
import { remember, archiveRun } from './stripe-state.mjs'
import { startLifecycle } from './lifecycle.mjs'
import { keySource, keyPrefix } from './sandbox.mjs'
import { provisioningHosts, provisioningProxy } from './provision-proxy.mjs'
import https from 'node:https'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
const require = createRequire(import.meta.url)
const metadata = require('./stripe-metadata.cjs')
const state = join(import.meta.dirname, '.state', 'tests')
await mkdir(state, { recursive: true, mode: 0o700 })
const temp = await mkdtemp(join(state, 'run-'))
const run = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

test('only explicit Stripe test key prefixes are accepted', () => {
  for (const key of ['sk_test_dummy123', 'rk_test_dummy123']) assert.equal(assertTestKey(key), key)
  for (const key of ['sk_live_dummy', 'rk_live_dummy', 'rkcs_test_dummy123', 'sk_test_', 'pk_test_dummy', '', undefined, ' sk_test_dummy']) assert.throws(() => assertTestKey(key), /test-mode/)
})
test('named, file alias and ephemeral sources are explicit and conflicting overrides fail', () => {
  assert.equal(keySource({}), 'agent-secrets:ai-hero::stripe_test_secret_key')
  assert.equal(keySource({ RIG_STRIPE_KEY_FILE: '/private/stripe.env' }), 'file:/private/stripe.env')
  assert.equal(keySource({ RIG_STRIPE: 'ephemeral' }), 'anonymous')
  assert.equal(keySource({ RIG_STRIPE_KEY_SOURCE: 'agent-secrets:alternate' }), 'agent-secrets:alternate')
  assert.throws(() => keySource({ RIG_STRIPE_KEY_SOURCE: 'anonymous', RIG_STRIPE_KEY_FILE: '/private/key' }), /only one/)
  assert.throws(() => keySource({ RIG_STRIPE: 'live' }), /named or ephemeral/)
})
test('prefix diagnostics retain no key material', () => {
  assert.equal(keyPrefix('sk_test_doNotRecordThis'), 'sk_test_')
  assert.equal(keyPrefix('rk_test_doNotRecordThis'), 'rk_test_')
  assert.equal(keyPrefix('newkind_test_doNotRecordThis'), 'newkind_test_')
  assert.equal(keyPrefix('rkcs_test_doNotRecordThis'), 'rkcs_test_')
  assert.equal(keyPrefix('opaqueCredentialWithoutSeparators'), 'unrecognized-format')
})
test('exact owned loopback database only', () => {
  assert.equal(assertDatabase(databaseUrl), databaseUrl)
  for (const url of ['mysql://rig:rig-local-only@db.example.com/commerce_rig', databaseUrl.replace('commerce_rig', 'production'), databaseUrl.replace('127.0.0.1', 'localhost')]) assert.throws(() => assertDatabase(url), /Refusing/)
})
test('all child env is constructed, never inherited', () => {
  const env = cleanEnv({ key: 'rk_test_dummy123', state: temp, home: temp, path: '/safe/bin' })
  assert.equal(env.DATABASE_URL, databaseUrl)
  assert.equal(env.STRIPE_SECRET_TOKEN, 'rk_test_dummy123')
  assert.equal(env.NEXT_PUBLIC_URL, origin)
  for (const name of ['VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'KIT_V4_API_KEY', 'FRONT_DESK_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'DROVR_EXECUTOR_TOKEN', 'SKIP_ENV_VALIDATION']) assert.equal(env[name], undefined)
  assert.equal(env.CONVERTKIT_API_KEY, 'rig-disabled')
  assert.throws(() => cleanEnv({ key: 'sk_live_dummy', state: temp, home: temp }), /test-mode/)
})
test('private key files accept raw and operator assignment; reject public files and symlinks', async () => {
  const raw = join(temp, 'raw.key'), envFile = join(temp, 'operator.env'), link = join(temp, 'link.key')
  await privateWrite(raw, 'sk_test_dummy123\n')
  await privateWrite(envFile, 'AIH_RIG_STRIPE_SECRET_KEY=rk_test_dummy123\n')
  assert.equal(await readPrivateKey(raw), 'sk_test_dummy123')
  assert.equal(await readPrivateKey(envFile), 'rk_test_dummy123')
  await chmod(raw, 0o644)
  await assert.rejects(readPrivateKey(raw), /0600/)
  await symlink(envFile, link)
  await assert.rejects(readPrivateKey(link), /regular/)
  await assert.rejects(privateWrite(link, 'bad'), /symlink/)
})
test('Stripe response guards require explicit livemode=false', () => {
  assert.equal(assertTestObject({ livemode: false }).livemode, false)
  for (const object of [{ livemode: true }, {}, null]) assert.throws(() => assertTestObject(object), /test-mode/)
  const session = publicSession({ livemode: false, id: 'cs_test_dummy', currency: 'usd', amount_subtotal: 100, amount_total: 100, total_details: { amount_discount: 0, amount_tax: 0 }, payment_status: 'unpaid', status: 'open', url: 'secret-capability' })
  assert.equal(session.total, 100)
  assert.equal(session.url, undefined)
  assert.throws(() => publicSession({ livemode: false, currency: 'eur', amount_total: 100 }), /currency/)
})
test('fixture identity and exclusion shapes stay deterministic', () => {
  assert.equal(fixtures.length, 18)
  assert.equal(new Set(fixtures.map(f => f.key)).size, fixtures.length)
  assert.ok(fixtures.every(f => f.email.endsWith('@example.test') && f.userId.startsWith('rig_')))
  assert.deepEqual([99, 199, 299].map(n => fixtureFor(`cc-${n}`).purchases[0].cents), [9900, 19900, 29900])
  assert.equal(fixtureFor('ppp-origin').purchases[0].status, 'Restricted')
  assert.equal(fixtureFor('refunded-cc').purchases[0].status, 'Refunded')
  assert.equal(fixtureFor('team-seat').purchases[0].redeemed, true)
  assert.equal(fixtureFor('team-purchaser').purchases[0].bulk, true)
  assert.ok(fixtureFor('binding-quote').pending)
  assert.ok(fixtureFor('legend').pending)
  assert.throws(() => fixtureFor('real-user'), /Unknown/)
  assert.equal(catalog[0].id, 'product-s00zs')
})
test('seed writes use installed Course Builder column contracts', () => {
  const purchase = getTableColumns(tables.purchases), entitlement = getTableColumns(tables.entitlements)
  for (const column of ['id', 'userId', 'productId', 'merchantChargeId', 'merchantSessionId', 'bulkCouponId', 'redeemedBulkCouponId', 'purchasedByorganizationMembershipId', 'fields']) assert.ok(purchase[column], column)
  for (const column of ['userId', 'sourceId', 'sourceType', 'entitlementType', 'metadata', 'organizationMembershipId', 'deletedAt']) assert.ok(entitlement[column], column)
})
test('proof requires paid, matching webhook, buyer, amount, purchase and C5 access', () => {
  const fixture = fixtureFor('new-buyer'), session = { paymentStatus: 'paid', total: 129500 }
  const valid = { webhooks: [{ id: 'evt_test' }], purchases: [{ id: 'purchase', userId: fixture.userId, productId: catalog[0].id, status: 'Valid', totalAmount: '1295.00' }], access: [{ sourceId: 'purchase', entitlementType: 'cohort_content_access', metadata: { contentIds: ['rig-workshop-c5'] } }] }
  assert.equal(provesAccess(fixture, session, valid), true)
  assert.equal(provesAccess(fixture, { ...session, paymentStatus: 'unpaid' }, valid), false)
  for (const field of ['webhooks', 'purchases', 'access']) assert.equal(provesAccess(fixture, session, { ...valid, [field]: [] }), false)
  assert.equal(provesAccess(fixture, { ...session, total: 100 }, valid), false)
  assert.equal(provesAccess(fixture, session, { ...valid, access: [{ ...valid.access[0], metadata: { contentIds: ['workshop-2ozd9'] } }] }), false)
})
test('network preload blocks provider calls before connection and allows only the slot and Stripe', () => {
  const script = `const {allowed,check}=require(${JSON.stringify(join(import.meta.dirname, 'network-guard.cjs'))}); const assert=require('node:assert/strict'); assert(allowed('api.stripe.com',443)); assert(!allowed('api.convertkit.com',443)); assert(!allowed('api.stripe.com.evil.test',443)); assert(!allowed('127.0.0.1',3306)); assert.throws(()=>check([{host:'api.postmarkapp.com',port:443}])); assert.throws(()=>require('node:net').connect({host:'api.frontapp.com',port:443})); fetch('https://api.convertkit.com/v3/forms').then(()=>process.exit(1),()=>console.log('blocked'));`
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH, RIG_SLOT: '0' } })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /blocked/)
})
test('create-time Stripe metadata preserves attribution and tags nested payment intent', () => {
  const params = new URLSearchParams(metadata.tagBody('/v1/checkout/sessions', 'mode=payment&metadata%5BuserId%5D=rig_buyer', run))
  assert.equal(params.get('metadata[rig]'), 'aihero-commerce')
  assert.equal(params.get('metadata[rig_run]'), run)
  assert.equal(params.get('metadata[userId]'), 'rig_buyer')
  assert.equal(params.get('payment_intent_data[metadata][rig_run]'), run)
  assert.throws(() => metadata.tagBody('/v1/checkout/sessions', '', 'unscoped'), /contract/)
})
test('Stripe transport overlay buffers request writes and repairs content length', () => {
  const original = https.request
  const captured = { chunks: [], headers: {} }
  https.request = () => ({
    write(chunk) { captured.chunks.push(chunk); return true },
    end(callback) { if (callback) callback(); return this },
    setHeader(name, value) { captured.headers[name] = value },
  })
  try {
    metadata.install(run)
    const request = https.request({ hostname: 'api.stripe.com', path: '/v1/coupons', method: 'POST' })
    request.write('amount_off=100&')
    request.end('currency=usd')
    const body = captured.chunks.join(''), params = new URLSearchParams(body)
    assert.equal(params.get('amount_off'), '100')
    assert.equal(params.get('metadata[rig_run]'), run)
    assert.equal(captured.headers['Content-Length'], Buffer.byteLength(body))
  } finally { https.request = original; syncBuiltinESMExports() }
})
test('anonymous provisioning proxy cannot reach account login or dashboard', async () => {
  assert.ok(provisioningHosts.includes('ai.stripe.com'))
  assert.ok(!provisioningHosts.includes('api.stripe.com'))
  assert.ok(!provisioningHosts.includes('dashboard.stripe.com'))
  const proxy = await provisioningProxy(), url = new URL(proxy.url)
  try {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: url.hostname, port: url.port, method: 'CONNECT', path: 'api.stripe.com:443' })
      request.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode) })
      request.on('error', reject)
      request.end()
    })
    assert.equal(status, 403)
  } finally { proxy.close() }
})
test('Stripe journal dedupes and cleanup archives only owned runs, including lost responses', async () => {
  const directory = await mkdtemp(join(temp, 'journal-'))
  await remember(directory, run, 'product', 'prod_owned')
  await remember(directory, run, 'product', 'prod_owned')
  const journal = JSON.parse(await readFile(join(directory, 'artifacts.json'), 'utf8'))
  assert.equal(journal.objects.length, 1)
  const owned = { rig: 'aihero-commerce', rig_run: run }
  const objects = {
    product: [{ id: 'prod_owned', livemode: false, metadata: owned, active: true }, { id: 'prod_foreign', livemode: false, metadata: { rig: 'aihero-commerce', rig_run: 'other' }, active: true }],
    price: [{ id: 'price_lost_response', livemode: false, metadata: owned, active: true }],
    session: [{ id: 'cs_test_owned', livemode: false, metadata: owned, status: 'open' }],
  }
  const calls = []
  const service = kind => ({
    async *list() { yield* objects[kind] },
    async retrieve(id) { return objects[kind].find(item => item.id === id) },
    async update(id, values) { calls.push(id); Object.assign(objects[kind].find(item => item.id === id), values); return this.retrieve(id) },
    async expire(id) { calls.push(id); objects[kind].find(item => item.id === id).status = 'expired'; return this.retrieve(id) },
  })
  const stripe = { products: service('product'), prices: service('price'), checkout: { sessions: service('session') } }
  assert.deepEqual(await archiveRun(stripe, directory, run), { archived: 2, expired: 1 })
  assert.ok(!calls.includes('prod_foreign'))
  assert.deepEqual(await archiveRun(stripe, directory, run), { archived: 0, expired: 0 })
  objects.product[0].metadata = { rig: 'other', rig_run: run }
  await assert.rejects(archiveRun(stripe, directory, run), /unowned/)
})
test('lifecycle has no implicit retry from a failure', () => {
  const values = [], actor = startLifecycle(value => values.push(value))
  actor.send({ type: 'UP' }); actor.send({ type: 'READY' }); actor.send({ type: 'FAIL' }); actor.send({ type: 'UP' })
  assert.equal(actor.getSnapshot().value, 'blocked')
  actor.send({ type: 'DOWN' }); actor.send({ type: 'UP' }); actor.send({ type: 'READY' }); actor.send({ type: 'READY' })
  assert.equal(actor.getSnapshot().value, 'running')
  actor.stop()
})
