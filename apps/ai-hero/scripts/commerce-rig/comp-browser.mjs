// @ts-nocheck: Node-only commerce rig, not part of the app runtime.
// Offline browser lane: generated app schema + Next production server, no Stripe key.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import mysql from 'mysql2/promise'
import { chromium } from '@playwright/test'

const dbUrl = new URL(process.env.DATABASE_URL)
assert.equal(dbUrl.protocol, 'mysql:')
assert.equal(dbUrl.hostname, '127.0.0.1')
assert(['3307', '13316'].includes(dbUrl.port))
assert(dbUrl.pathname === '/ai_hero_build' || /^\/ai_hero_comp_fixture(?:_[a-z0-9]+)?$/.test(dbUrl.pathname))
assert.equal(dbUrl.search, '')
const url = 'http://127.0.0.1:3310'
const path = '/cohorts/synthetic-c5-header-proof'
const selector = `c5comp_${'a'.repeat(40)}`
const digest = `c5hash_${createHash('sha256').update(selector).digest('hex')}`
const couponId = `batch-coupon-${randomUUID()}`
const email = `comp-${randomUUID()}@example.test`
const signedIn = { id: randomUUID(), email: `signed-in-${randomUUID()}@example.test`, token: randomUUID(), selector: `c5comp_${'b'.repeat(40)}`, couponId: `batch-coupon-${randomUUID()}` }
const db = await mysql.createConnection(dbUrl.toString())
let app, browser
let appError = ''
let redeemedEvents = 0
const jobs = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/e/')) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (body.includes(selector) || body.includes(signedIn.selector)) { res.writeHead(400).end(); return }
    if (body.includes('commerce/full-price-coupon-redeemed')) redeemedEvents++
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":200,"ids":["fixture-event"]}')
  })
})
try {
  const [[existing]] = await db.query("SELECT COUNT(*) AS n FROM AI_Product WHERE id = 'product-s00zs'")
  assert.equal(existing.n, 0, 'comp browser rig requires a fresh fixture schema')
  await db.query(`INSERT INTO AI_Product (id,name,type,status,quantityAvailable,fields) VALUES
    ('product-s00zs','Synthetic C5 Header Proof','cohort',1,0,JSON_OBJECT('slug','synthetic-c5-header-proof','state','published','openEnrollment','2025-01-01T00:00:00Z','closeEnrollment','2025-02-01T00:00:00Z'))`)
  await db.query("INSERT INTO AI_Price (id,productId,status,unitAmount) VALUES ('comp-browser-price','product-s00zs',1,299.00)")
  await db.query(`INSERT INTO AI_ContentResource (id,type,createdById,fields) VALUES
    ('comp-browser-cohort','cohort','comp-browser-owner',JSON_OBJECT('slug','synthetic-c5-header-proof','title','Synthetic C5 Header Proof','description','Synthetic route fixture','body','<Enroll />','state','published','visibility','public','startsAt','2027-01-02T00:00:00Z','endsAt','2027-01-09T00:00:00Z'))`)
  await db.query("INSERT INTO AI_ContentResourceProduct (productId,resourceId) VALUES ('product-s00zs','comp-browser-cohort')")
  await db.query("INSERT INTO AI_CouponBatchControl (id,enabled,claimsEnabled) VALUES ('ai-hero-claims',0,1)")
  // Keep UI proof away from the expiry boundary even on non-UTC fixture servers.
  await db.query(`INSERT INTO AI_Coupon (id,code,restrictedToProductId,percentageDiscount,status,maxUses,expires,fields)
    VALUES (?,?,'product-s00zs',1,1,1,DATE_ADD(NOW(),INTERVAL 2 DAY),JSON_OBJECT('couponBatchTemplate','c5-comp-v1','bypassSoldOut',true))`, [couponId, digest])
  await db.query(`INSERT INTO AI_Coupon (id,code,restrictedToProductId,percentageDiscount,status,maxUses,expires,fields)
    VALUES (?,?,'product-s00zs',1,1,1,DATE_ADD(NOW(),INTERVAL 2 DAY),JSON_OBJECT('couponBatchTemplate','c5-comp-v1','bypassSoldOut',true))`,
    [signedIn.couponId, `c5hash_${createHash('sha256').update(signedIn.selector).digest('hex')}`])
  await db.query('INSERT INTO AI_User (id,email,name) VALUES (?,?,?)', [signedIn.id, signedIn.email, 'Synthetic signed-in claimant'])
  const org = 'comp-signed-in-personal-org', member = 'comp-signed-in-membership', role = 'comp-signed-in-owner'
  await db.query('INSERT INTO AI_Organization (id,name,personalOrganizationUserId) VALUES (?,?,?)', [org, `Personal organization for ${signedIn.email}`, signedIn.id])
  await db.query("INSERT INTO AI_OrganizationMembership (id,organizationId,userId,personalOrganizationUserId,invitedById,role) VALUES (?,?,?,?,?,'owner')",
    [member, org, signedIn.id, signedIn.id, signedIn.id])
  await db.query("INSERT INTO AI_Role (id,name,organizationId,active) VALUES (?,'owner',?,1)", [role, org])
  await db.query('INSERT INTO AI_OrganizationMembershipRole (organizationMembershipId,roleId,organizationId) VALUES (?,?,?)', [member, role, org])
  await db.query('INSERT INTO AI_Session (sessionToken,userId,expires) VALUES (?,?,DATE_ADD(NOW(),INTERVAL 2 DAY))',
    [signedIn.token, signedIn.id])
  await new Promise((resolve, reject) => jobs.once('error', reject).listen(18288, '127.0.0.1', resolve))
  app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3310'], {
    env: { ...process.env, COURSEBUILDER_URL: url, AUTH_URL: url, NEXTAUTH_URL: url, AUTH_TRUST_HOST: 'true', AUTH_SECRET: 'comp-browser-fixture-secret',
      AIH_COUPON_BATCH_ENABLED: 'true', SKIP_EMAIL: 'true', INNGEST_DEV: '1', INNGEST_EVENT_KEY: 'fixture', INNGEST_EVENT_API_BASE_URL: 'http://127.0.0.1:18288',
      RIG_COMP_ONLY_DB_PORT: dbUrl.port, STRIPE_SECRET_TOKEN: 'sk_test_never_connected', STRIPE_WEBHOOK_SECRET: 'whsec_fixture_never_connected',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${process.cwd()}/scripts/commerce-rig/network-guard.cjs` },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  app.stderr.on('data', (chunk) => { appError = (appError + chunk).slice(-8192) })
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/test-cohort-bearer-headers.mjs', url])
  process.stdout.write(stdout)
  browser = await chromium.launch({ headless: true, executablePath: process.env.RIG_COMP_CHROMIUM, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  let urlOrBodyLeak = false
  let checkedOut = false
  const entry = `${url}${path}?code=${selector}`
  const signedEntry = `${url}${path}?code=${signedIn.selector}`
  await page.route('**/*', (route) => {
    const req = route.request()
    for (const [link, secret] of [[entry, selector], [signedEntry, signedIn.selector]]) {
      if ((req.url() !== link && req.url().includes(secret)) || req.postData()?.includes(secret) || req.headers().referer?.includes(secret)) urlOrBodyLeak = true
    }
    if (req.url().includes('/checkout/stripe') || req.url().includes('stripe.com')) checkedOut = true
    return new URL(req.url()).origin === url ? route.continue() : route.abort()
  })
  await page.goto(entry)
  const offer = page.locator('[data-private-comp-offer]')
  await offer.getByText('$0', { exact: true }).waitFor()
  assert.equal(page.url(), `${url}${path}`)
  assert(!(await page.evaluate(() => document.cookie)).includes(selector))
  const rsc = await page.request.get(`${url}${path}`, { headers: { RSC: '1' } })
  assert.equal(rsc.status(), 200)
  assert.match(rsc.headers()['content-type'] ?? '', /text\/x-component/)
  const rscCache = (rsc.headers()['cache-control'] ?? '').split(',').map((directive) => directive.trim().toLowerCase())
  assert(rscCache.includes('private') && rscCache.includes('no-store') && !rscCache.includes('public'))
  assert.equal(await page.locator('#buy').count(), 1)
  assert.equal(await page.locator('#buy [data-private-comp-offer]').count(), 1)
  assert(await page.locator('a[href="#buy"]').count() > 0, 'the cohort CTA links to the offer rail')
  assert(!(await rsc.text()).includes(selector))
  const login = offer.getByRole('link', { name: 'Sign in' })
  const callback = new URL(await login.getAttribute('href'), url).searchParams.get('callbackUrl')
  assert.equal(callback, path)
  await login.click()
  await page.waitForURL((location) => location.pathname === '/login')
  assert.equal(new URL(page.url()).searchParams.get('callbackUrl'), path)
  await page.goto(`${url}${path}`)
  await offer.getByLabel('Email address').fill(email)
  const redeemed = page.waitForResponse((response) => response.url().endsWith('/api/coursebuilder/redeem/coupon') && response.request().method() === 'POST')
  await offer.getByRole('button', { name: 'Claim your seat' }).click()
  const response = await redeemed
  assert.equal(response.status(), 200)
  const { purchase, error } = await response.json()
  assert(purchase?.id, error?.message === 'coupon-is-invalid'
    ? 'browser claim was refused as an invalid coupon' : 'browser redeem must create a purchase')
  await page.waitForURL((location) => location.pathname === '/thanks/redeem' && location.searchParams.get('purchaseId') === purchase.id)
  const [[record]] = await db.query('SELECT status, couponId, totalAmount, merchantChargeId FROM AI_Purchase WHERE id = ?', [purchase.id])
  assert.equal(record.status, 'Valid')
  assert.equal(record.couponId, couponId)
  assert.equal(Number(record.totalAmount), 0)
  assert.equal(record.merchantChargeId, null)
  const [[coupon]] = await db.query('SELECT usedCount FROM AI_Coupon WHERE id = ?', [couponId])
  assert.equal(coupon.usedCount, 1)
  assert.equal(redeemedEvents, 1)

  await page.context().addCookies([{ name: 'authjs.session-token', value: signedIn.token, url }])
  await page.goto(signedEntry)
  assert.equal(page.url(), `${url}${path}`)
  await offer.getByText('$0', { exact: true }).waitFor()
  assert.equal(await offer.getByLabel('Email address').inputValue(), signedIn.email)
  assert(!(await page.content()).includes(signedIn.selector))
  const signedRedeem = page.waitForResponse((response) => response.url().endsWith('/api/coursebuilder/redeem/coupon') && response.request().method() === 'POST')
  const sessionUpdate = page.waitForResponse((response) => response.url() === `${url}/api/auth/session?update`)
  await offer.getByRole('button', { name: 'Claim your seat' }).click()
  const signedResponse = await signedRedeem
  assert.equal(signedResponse.status(), 200)
  const signedResult = await signedResponse.json()
  assert.equal(signedResult.redeemingForCurrentUser, true)
  assert(signedResult.purchase?.id)
  assert.equal((await sessionUpdate).status(), 200)
  await page.waitForURL((location) => location.pathname === '/welcome' && location.searchParams.get('purchaseId') === signedResult.purchase.id)
  const [[signedPurchase]] = await db.query('SELECT userId, status, totalAmount, merchantChargeId FROM AI_Purchase WHERE couponId = ?', [signedIn.couponId])
  assert.equal(signedPurchase.userId, signedIn.id)
  assert.equal(signedPurchase.status, 'Valid')
  assert.equal(Number(signedPurchase.totalAmount), 0)
  assert.equal(signedPurchase.merchantChargeId, null)
  const [[signedCoupon]] = await db.query('SELECT usedCount FROM AI_Coupon WHERE id = ?', [signedIn.couponId])
  assert.equal(signedCoupon.usedCount, 1)
  assert.equal(redeemedEvents, 2)
  assert.equal(urlOrBodyLeak, false)
  assert.equal(checkedOut, false)
  console.log('Browser: $0 offer, clean sign-in return URL, anonymous and signed-in claims, session refresh and welcome, no Stripe checkout')
} catch (error) {
  process.stderr.write(appError.replaceAll(selector, '[fixture selector]').replaceAll(signedIn.selector, '[fixture selector]').replaceAll(signedIn.token, '[fixture session]'))
  throw error
} finally {
  await browser?.close()
  app?.kill()
  jobs.closeAllConnections()
  jobs.close()
  await db.end()
}
