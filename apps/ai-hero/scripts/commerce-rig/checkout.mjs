import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import Stripe from 'stripe'
import { catalog, c5WorkshopId, fixtureFor } from './fixtures.mjs'
import { authenticate, evidence } from './seed.mjs'
import { assertTestKey, assertTestObject, freshToken, origin, privateWrite, publicSession } from './safety.mjs'
import { remember } from './stripe-state.mjs'

export function provesAccess(fixture, session, result) {
  const c5 = catalog[0].id
  const purchases = result.purchases.filter(p => p.userId === fixture.userId && p.productId === c5 && p.status === 'Valid' && Math.round(Number(p.totalAmount) * 100) === session.total)
  return session.paymentStatus === 'paid' && result.webhooks.length > 0 && purchases.some(p => result.access.some(a => a.sourceId === p.id && a.entitlementType === 'cohort_content_access' && a.metadata?.contentIds?.includes(c5WorkshopId)))
}
async function complete(url, state) {
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch({ headless: true, env: { PATH: process.env.PATH, HOME: process.env.HOME } })
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => {
      const host = new URL(route.request().url()).hostname
      // Hosted Checkout loads its own assets from stripecdn.com.
      if (host === '127.0.0.1' || ['stripe.com', 'stripe.network', 'stripecdn.com'].some(domain => host === domain || host.endsWith(`.${domain}`))) return route.continue()
      return route.abort()
    })
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    // Stripe-hosted UI changes independently of this repo. Never submit a live card.
    const fill = async (selector, value) => {
      // The hosted page renders after load; poll every frame rather than checking once.
      const deadline = Date.now() + 60000
      do {
        for (const frame of page.frames()) {
          const input = frame.locator(selector).first()
          if (await input.count() && await input.isVisible()) { await input.fill(value); return }
        }
        await page.waitForTimeout(500)
      } while (Date.now() < deadline)
      throw new Error('Stripe test checkout field not found; inspect private screenshot')
    }
    try {
      // Newer hosted pages hide the card form behind a payment-method accordion. Its button
      // is 0x0 with a CSS click area, so dispatch the click to the React handler directly.
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
      const cardChoice = page.locator('[data-testid="card-accordion-item-button"]').first()
      if (await cardChoice.count()) await cardChoice.dispatchEvent('click')
      await fill('[name="cardNumber"], [name="cardnumber"]', '4242424242424242')
      await fill('[name="cardExpiry"], [name="exp-date"]', '1230')
      await fill('[name="cardCvc"], [name="cvc"]', '123')
      const name = page.locator('[name="billingName"]').first()
      if (await name.count()) await name.fill('Rig Test Buyer')
      const zip = page.locator('[name="billingPostalCode"], [name="postal"]').first()
      if (await zip.count()) await zip.fill('94107')
      // Link's "save my information" asks for a phone number; the test buyer opts out.
      const saveInfo = page.locator('#enableStripePass').first()
      if (await saveInfo.count() && await saveInfo.isChecked()) await saveInfo.uncheck({ force: true })
      const submit = page.locator('[data-testid="hosted-payment-submit-button"]').first()
      await (await submit.count() ? submit : page.getByRole('button', { name: /pay|subscribe/i }).last()).click({ timeout: 30000 })
      await page.waitForURL(`${origin}/**`, { timeout: 90000 })
    } catch {
      await privateWrite(join(state, 'checkout-failure.png'), await page.screenshot({ fullPage: true }))
      // Control names only, never values, so selector drift can be fixed from the receipt.
      const controls = await page.locator('input, button, [role=radio]').evaluateAll(nodes => nodes.map(node => ({ tag: node.tagName, type: node.getAttribute('type'), name: node.getAttribute('name'), id: node.id, role: node.getAttribute('role'), label: node.getAttribute('aria-label'), testid: node.getAttribute('data-testid'), checked: node.checked ?? null }))).catch(() => [])
      await privateWrite(join(state, 'checkout-failure-controls.json'), JSON.stringify(controls, null, 2) + '\n')
      throw new Error('Test-card automation failed; no payment proof claimed')
    }
  } finally { await browser.close() }
}
export async function checkout(state, key, fixtureKey, shouldComplete = false) {
  const fixture = fixtureFor(fixtureKey)
  const seed = JSON.parse(await readFile(join(state, 'seed.json'), 'utf8'))
  if (!seed.stripeSeeded) throw new Error('Stripe catalog is not seeded')
  const stripe = new Stripe(assertTestKey(key))
  const token = freshToken()
  await authenticate(fixture, token)
  const cookie = `authjs.session-token=${token}`
  const auth = await fetch(`${origin}/api/auth/session`, { headers: { cookie }, signal: AbortSignal.timeout(60000) })
  const sessionUser = await auth.json()
  if (!auth.ok || sessionUser.user?.id !== fixture.userId) throw new Error('Fixture login did not resolve to the expected user')
  const url = new URL(`${origin}/api/coursebuilder/checkout/stripe`)
  url.searchParams.set('productId', catalog[0].id)
  url.searchParams.set('quantity', String(fixture.quantity))
  url.searchParams.set('cancelUrl', origin)
  if (fixture.quantity > 1) { url.searchParams.set('bulk', 'true'); url.searchParams.set('organizationId', `rig_org_${fixture.key}`) }
  // The buy form POSTs to this path; Course Builder rejects GET as an unknown action.
  let response = await fetch(url, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: '', redirect: 'manual', signal: AbortSignal.timeout(90000) })
  let target = response.headers.get('location')
  const hops = []
  // Cohort checkout goes through the app's /subscribe/verify-login page before Stripe.
  // Follow same-origin hops as the logged-in buyer, never leaving the rig origin.
  for (let hop = 0; hop < 4 && target && new URL(target, origin).origin === new URL(origin).origin; hop++) {
    hops.push(new URL(target, origin).pathname)
    response = await fetch(new URL(target, origin), { headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(90000) })
    target = response.headers.get('location')
    // A streamed page redirect arrives as 200 with Next's refresh meta tag.
    if (!target && response.status === 200) {
      const html = await response.text()
      const meta = html.match(/id="__next-page-redirect"[^>]*content="\d+;url=([^"]+)"/)?.[1]
      target = meta ? meta.replaceAll('&amp;', '&') : null
      if (target) response = { status: 307, headers: response.headers }
    }
  }
  const id = target?.match(/\bcs_test_[A-Za-z0-9]+/)?.[0]
  if (![302, 303, 307].includes(response.status) || !id || new URL(target).hostname !== 'checkout.stripe.com') {
    // Record only the shape: a hosted session URL is a payment capability.
    const shape = target ? { host: new URL(target, origin).hostname, path: new URL(target, origin).pathname.replace(/cs_test_[A-Za-z0-9]+/, 'cs_test_*'), error: new URL(target, origin).searchParams.get('error') } : null
    await privateWrite(join(state, 'checkout-refusal.json'), JSON.stringify({ fixture: fixture.key, at: new Date().toISOString(), status: response.status, hops, location: shape }) + '\n')
    throw new Error(`App checkout did not return a Stripe test session (HTTP ${response.status}); inspect private checkout-refusal.json`)
  }
  const metadata = { rig_run: seed.generation, rig: 'aihero-commerce' }
  let session = assertTestObject(await stripe.checkout.sessions.retrieve(id, { expand: ['discounts.coupon'] }))
  await stripe.checkout.sessions.update(id, { metadata })
  await remember(state, seed.generation, 'session', id)
  if (typeof session.payment_intent === 'string') assertTestObject(await stripe.paymentIntents.update(session.payment_intent, { metadata }))
  for (const discount of session.discounts ?? []) {
    const coupon = typeof discount.coupon === 'string' ? await stripe.coupons.retrieve(discount.coupon) : discount.coupon
    if (coupon) { assertTestObject(coupon); await stripe.coupons.update(coupon.id, { metadata }) }
  }
  await privateWrite(join(state, 'checkout-url.txt'), target + '\n')
  const receipt = { fixture: fixture.key, run: seed.generation, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain', '--', import.meta.dirname], { encoding: 'utf8' }).trim() !== '', catalogBasis: seed.catalogOverlay ? 'synthetic catalog with private list-price overlay; no production discount configuration' : 'synthetic bare catalog; not production configuration', pendingFacts: fixture.pending ?? null, createdAt: new Date().toISOString(), createdSession: publicSession(session), complete: false }
  await privateWrite(join(state, `checkout-${fixture.key}.json`), JSON.stringify(receipt, null, 2) + '\n')
  console.log(`ok checkout ${fixture.key}: USD ${(session.amount_total / 100).toFixed(2)} (${id})`)
  if (!shouldComplete) {
    assertTestObject(await stripe.checkout.sessions.expire(id))
    return receipt
  }
  await complete(target, state)
  const deadline = Date.now() + 180000
  do {
    session = assertTestObject(await stripe.checkout.sessions.retrieve(id))
    const result = await evidence(fixture, id)
    receipt.paidSession = publicSession(session)
    receipt.evidence = result
    receipt.complete = provesAccess(fixture, receipt.paidSession, result)
    await privateWrite(join(state, `checkout-${fixture.key}.json`), JSON.stringify(receipt, null, 2) + '\n')
    if (receipt.complete) {
      const intent = typeof session.payment_intent === 'string' ? assertTestObject(await stripe.paymentIntents.retrieve(session.payment_intent)) : null
      if (intent) {
        assertTestObject(await stripe.paymentIntents.update(intent.id, { metadata }))
        if (typeof intent.latest_charge === 'string') assertTestObject(await stripe.charges.update(intent.latest_charge, { metadata }))
      }
      console.log('ok paid -> webhook -> matching C5 purchase -> matching C5 entitlement')
      return receipt
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  } while (Date.now() < deadline)
  throw new Error('Paid/webhook/purchase/C5-access proof incomplete; inspect private receipt')
}
