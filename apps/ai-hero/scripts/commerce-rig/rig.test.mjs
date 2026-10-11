// @ts-nocheck: untyped Node operator tooling, covered by rig.test.mjs; not app code.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { getTableColumns } from 'drizzle-orm'
import { applyCatalogOverlay, catalog, fixtures, fixtureFor } from './fixtures.mjs'
import { assertDatabase, assertTestKey, assertTestObject, cleanEnv, databaseUrl, origin, privateWrite, readCatalogOverlay, readPrivateKey, publicSession } from './safety.mjs'
import { provesAccess, checkoutHandoffRefusal, payHostedCheckout } from './checkout.mjs'

test('provider refusal is not misdiagnosed as a login failure or persisted as a capability', () => {
  const base = 'http://127.0.0.1:3350'
  const handoff = nested => `${base}/subscribe/verify-login?checkoutUrl=${encodeURIComponent(nested)}`
  assert.equal(checkoutHandoffRefusal('https://checkout.stripe.com/c/pay/cs_test_fixture', base), null)
  assert.equal(checkoutHandoffRefusal(handoff('https://checkout.stripe.com/c/pay/cs_test_fixture?secret=synthetic'), base), null)
  assert.equal(checkoutHandoffRefusal(`${base}/subscribe/verify-login?productId=fixture`, base), null)
  assert.deepEqual(checkoutHandoffRefusal(handoff(`${base}/?secret=synthetic`), base), { classification: 'checkout-refused-before-login', checkoutHost: '127.0.0.1' })
  assert.deepEqual(checkoutHandoffRefusal(handoff('invalid'), base), { classification: 'checkout-refused-before-login', checkoutHost: null })
})
import { tables } from './seed.mjs'

test('the owned listener forwards reservation expiry and dispute lifecycle events', async () => {
  const source = await readFile(new URL('./serve.mjs', import.meta.url), 'utf8')
  for (const event of ['checkout.session.expired', 'charge.dispute.created', 'charge.dispute.closed']) assert.ok(source.includes(event))
})

test('unknown payment-card scenarios fail before opening a browser', async () => {
  await assert.rejects(payHostedCheckout('https://checkout.stripe.com/test', {}, { testCard: 'unknown' }), /Unknown Stripe test-card scenario/)
})
import { missingSchema, overlay, splitStatements } from './schema.mjs'
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
  assert.throws(() => keySource({}), /not configured; set RIG_STRIPE_KEY_SOURCE/)
  assert.throws(() => keySource({ RIG_STRIPE: 'named' }), /not configured/)
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
  assert.equal(fixtures.length, 22)
  assert.equal(new Set(fixtures.map(f => f.key)).size, fixtures.length)
  assert.ok(fixtures.every(f => f.email.endsWith('@example.test') && f.userId.startsWith('rig_')))
  assert.deepEqual([99, 199, 299].map(n => fixtureFor(`cc-${n}`).purchases[0].cents), [9900, 19900, 29900])
  assert.equal(fixtureFor('ppp-origin').purchases[0].status, 'Restricted')
  assert.equal(fixtureFor('refunded-cc').purchases[0].status, 'Refunded')
  assert.equal(fixtureFor('team-seat').purchases[0].redeemed, true)
  assert.equal(fixtureFor('team-purchaser').purchases[0].bulk, true)
  assert.ok(fixtureFor('binding-quote').pending)
  assert.ok(fixtureFor('legend').pending)
  // A legend owns all six paid courses, not just the cohorts and Crash Course.
  assert.deepEqual(fixtureFor('legend').purchases.map(p => catalog.find(c => c.key === p.product).id).sort(), ['product-3vfob', 'product-7t9ek', 'product-9wdta', 'product-ma254', 'product-pqkk5', 'product-wdhub'])
  assert.deepEqual([2, 5, 10, 30].map(n => fixtureFor(`team-${n}`)).map(f => [f.quantity, f.purchases.length]), [[2, 0], [5, 0], [10, 0], [30, 0]])
  assert.throws(() => fixtureFor('real-user'), /Unknown/)
  assert.equal(catalog[0].id, 'product-s00zs')
  // Public fixtures carry a synthetic list price; real amounts come only from a private overlay.
  assert.equal(catalog[0].cents, 100000)
})
test('catalog overlay replaces list prices and rejects bad input', () => {
  const measured = applyCatalogOverlay(catalog, { amounts: { c5: 123400 } })
  assert.equal(measured[0].cents, 123400)
  assert.equal(catalog[0].cents, 100000)
  assert.deepEqual(measured.slice(1), catalog.slice(1))
  assert.throws(() => applyCatalogOverlay(catalog, {}), /amounts object/)
  assert.throws(() => applyCatalogOverlay(catalog, { amounts: { nope: 100 } }), /unknown catalog key/)
  assert.throws(() => applyCatalogOverlay(catalog, { amounts: { c5: 12.5 } }), /positive integer cents/)
  assert.throws(() => applyCatalogOverlay(catalog, { amounts: { c5: 0 } }), /positive integer cents/)
})
test('catalog overlay path must be absolute and a regular file', async () => {
  assert.equal(await readCatalogOverlay(undefined), null)
  await assert.rejects(readCatalogOverlay('relative/overlay.json'), /absolute/)
  const dir = await mkdtemp(join(temp, 'overlay-'))
  const file = join(dir, 'overlay.json')
  await writeFile(file, JSON.stringify({ amounts: { c5: 123400 } }))
  assert.deepEqual(await readCatalogOverlay(file), { amounts: { c5: 123400 } })
  await assert.rejects(readCatalogOverlay(dir), /regular file/)
})
test('schema overlay pins ON UPDATE precision only where MySQL rejects it', () => {
  const ddl = 'CREATE TABLE `AI_X` (\n\t`updatedAt` timestamp(3) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,\n\t`plain` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP\n);'
  const fixed = overlay(ddl)
  assert.match(fixed, /`updatedAt` timestamp\(3\)[^\n]*ON UPDATE CURRENT_TIMESTAMP\(3\),/)
  assert.match(fixed, /`plain` timestamp NOT NULL DEFAULT \(now\(\)\) ON UPDATE CURRENT_TIMESTAMP\n/)
  assert.equal(overlay(fixed), fixed)
  assert.deepEqual(splitStatements('A;\n--> statement-breakpoint\nB;\n'), ['A;', 'B;'])
})
test('schema check fails closed on any missing table or column', () => {
  const snapshot = { tables: { AI_A: { columns: { id: {}, name: {} } }, AI_B: { columns: { id: {} } } } }
  assert.deepEqual(missingSchema(snapshot, [{ table: 'AI_A', column: 'id' }, { table: 'AI_A', column: 'name' }, { table: 'AI_B', column: 'id' }]), [])
  assert.deepEqual(missingSchema(snapshot, [{ table: 'AI_A', column: 'id' }]), ['AI_A.name', 'AI_B'])
})
test('seed writes use installed Course Builder column contracts', () => {
  const purchase = getTableColumns(tables.purchases), entitlement = getTableColumns(tables.entitlements)
  for (const column of ['id', 'userId', 'productId', 'merchantChargeId', 'merchantSessionId', 'bulkCouponId', 'redeemedBulkCouponId', 'purchasedByorganizationMembershipId', 'fields']) assert.ok(purchase[column], column)
  for (const column of ['userId', 'sourceId', 'sourceType', 'entitlementType', 'metadata', 'organizationMembershipId', 'deletedAt']) assert.ok(entitlement[column], column)
})
test('proof requires paid, matching webhook, buyer, amount, purchase and C5 access', () => {
  const fixture = fixtureFor('new-buyer'), session = { paymentStatus: 'paid', total: 100000 }
  const valid = { webhooks: [{ id: 'evt_test' }], purchases: [{ id: 'purchase', userId: fixture.userId, productId: catalog[0].id, status: 'Valid', totalAmount: '1000.00' }], access: [{ sourceId: 'purchase', entitlementType: 'cohort_content_access', metadata: { contentIds: ['rig-workshop-c5'] } }] }
  assert.equal(provesAccess(fixture, session, valid), true)
  assert.equal(provesAccess(fixture, { ...session, paymentStatus: 'unpaid' }, valid), false)
  for (const field of ['webhooks', 'purchases', 'access']) assert.equal(provesAccess(fixture, session, { ...valid, [field]: [] }), false)
  assert.equal(provesAccess(fixture, { ...session, total: 100 }, valid), false)
  assert.equal(provesAccess(fixture, session, { ...valid, access: [{ ...valid.access[0], metadata: { contentIds: ['workshop-2ozd9'] } }] }), false)
  // A cents price: the stored total equals the charge to the cent, and a saved
  // decision must be the one for this session.
  const cents = { id: 'cs_test_cents', paymentStatus: 'paid', total: 123456 }
  const decided = (decision, totalAmount = '1234.56') => ({ ...valid, purchases: [{ ...valid.purchases[0], totalAmount, decision }] })
  const saved = { checkoutSessionId: 'cs_test_cents', expectedTotalCents: 123456 }
  assert.equal(provesAccess(fixture, cents, decided(saved)), true)
  assert.equal(provesAccess(fixture, cents, decided(null)), true)
  const authoritative = { ...cents, decisionRef: 'c5d1.0123456789abcdef.-' }
  assert.equal(provesAccess(fixture, authoritative, decided(null)), false)
  assert.equal(provesAccess(fixture, authoritative, decided({ ...saved, decisionRef: authoritative.decisionRef })), true)
  assert.equal(provesAccess(fixture, authoritative, decided({ ...saved, decisionRef: 'different' })), false)
  // A whole-dollar total for a cents charge is the rounding bug, whatever the decision says.
  assert.equal(provesAccess(fixture, cents, decided(saved, '1235.00')), false)
  assert.equal(provesAccess(fixture, cents, decided(saved, '1235')), false)
  assert.equal(provesAccess(fixture, cents, decided(saved, '1234.560000000000000000000000000000')), true)
  assert.equal(provesAccess(fixture, cents, decided(saved, '1234.560')), true)
  assert.equal(provesAccess(fixture, cents, decided(saved, '1234.565')), false)
  assert.equal(provesAccess(fixture, cents, decided(saved, '1234.55')), false)
  assert.equal(provesAccess(fixture, cents, decided(saved, '')), false)
  assert.equal(provesAccess(fixture, cents, decided({ ...saved, checkoutSessionId: 'cs_test_other' })), false)
  assert.equal(provesAccess(fixture, cents, decided({ ...saved, expectedTotalCents: 123400 })), false)
})
test('network preload blocks provider calls before connection and allows only the slot and Stripe', () => {
  const script = `const {allowed,check}=require(${JSON.stringify(join(import.meta.dirname, 'network-guard.cjs'))}); const assert=require('node:assert/strict'); assert(allowed('api.stripe.com',443)); assert(!allowed('api.convertkit.com',443)); assert(!allowed('api.stripe.com.evil.test',443)); assert(!allowed('127.0.0.1',3306)); assert.throws(()=>check([{host:'api.postmarkapp.com',port:443}])); assert.throws(()=>require('node:net').connect({host:'api.frontapp.com',port:443})); fetch('https://api.convertkit.com/v3/forms').then(()=>process.exit(1),()=>console.log('blocked'));`
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH, RIG_SLOT: '0' } })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /blocked/)
})
test('Turbopack loader IPC is allowed only for the rig build and its argv port', () => {
  // The guard patches sockets on load, so exercise it in a child process.
  const script = `const {turbopackIpcPort:p}=require(${JSON.stringify(join(import.meta.dirname, 'network-guard.cjs'))}); const assert=require('node:assert/strict'); const d='/rig/app/.next';
assert.equal(p(['node','/rig/app/.next/dev/build/chunks/runtime.js','51234'],d),51234); assert.equal(p(['node','/elsewhere/runtime.js','51234'],d),null); assert.equal(p(['node','/rig/app/.next-evil/x.js','51234'],d),null); assert.equal(p(['node','/rig/app/.next/x.js','api.stripe.com'],d),null); assert.equal(p(['node','/rig/app/.next/x.js','51234'],undefined),null); console.log('ok')`
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH, RIG_SLOT: '0' } })
  assert.equal(result.stdout.trim(), 'ok', result.stderr)
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

test('front-desk stub serves only its private data, behind each route\'s own token', async () => {
  const { frontDeskHandler, readFrontDeskData } = await import('./front-desk-stub.mjs')
  await assert.rejects(readFrontDeskData('relative/front-desk.json'), /absolute/)
  assert.equal(await readFrontDeskData(undefined), null)
  const data = { policy: { version: 'synthetic@1', policy: { product: 'synthetic' } }, quotes: { 'q@example.test': [{ quantity: 1, amount: 1 }, { quantity: 2, amount: 2 }] } }
  const server = http.createServer(frontDeskHandler(data, { pricing: 'p-token', quotes: 'q-token' }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const policy = `${base}/api/pricing/policy?productId=product-s00zs`
    assert.equal((await fetch(policy, { headers: { authorization: 'Bearer q-token' } })).status, 401)
    const first = await fetch(policy, { headers: { authorization: 'Bearer p-token' } })
    assert.deepEqual(await first.json(), data.policy)
    assert.equal(first.headers.get('etag'), '"synthetic@1"')
    assert.equal((await fetch(policy, { headers: { authorization: 'Bearer p-token', 'if-none-match': '"synthetic@1"' } })).status, 304)
    const quotes = body => fetch(`${base}/api/binding-quotes`, { method: 'POST', headers: { authorization: 'Bearer q-token' }, body: JSON.stringify(body) })
    assert.deepEqual(await (await quotes({ email: ' Q@Example.test ', productId: 'product-s00zs', quantity: 2 })).json(), [{ quantity: 2, amount: 2 }])
    assert.deepEqual(await (await quotes({ email: 'other@example.test', productId: 'product-s00zs', quantity: 1 })).json(), [])
    assert.equal((await quotes({ email: 'q@example.test', productId: 'product-ma254', quantity: 1 })).status, 400)
  } finally { server.close() }
})

test('rig Redis stand-in allows only the local C5 flag read, never writes or deployed flags', async () => {
  const { frontDeskHandler } = await import('./front-desk-stub.mjs')
  const { Redis } = await import('@upstash/redis')
  const server = http.createServer(frontDeskHandler({ policy: { version: 'synthetic@1' } }, { pricing: 'p', quotes: 'q' }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const redis = new Redis({ url: base, token: 'rig-disabled', retry: false })
    assert.equal(await redis.get('flag:development:c5-pricing-enabled'), null)
    await assert.rejects(redis.set('flag:development:c5-pricing-enabled', true), /rig-flag-command-refused/)
    await assert.rejects(redis.get('flag:production:c5-pricing-enabled'), /rig-flag-command-refused/)
    const response = await fetch(`${base}/pipeline`, { method: 'POST', headers: { authorization: 'Bearer rig-disabled' }, body: JSON.stringify([['get', 'flag:development:c5-pricing-enabled']]) })
    assert.deepEqual(await response.json(), [{ result: null }])
    assert.equal((await fetch(base, { method: 'POST', body: JSON.stringify(['get', 'flag:development:c5-pricing-enabled']) })).status, 403)
  } finally { server.close() }
})
