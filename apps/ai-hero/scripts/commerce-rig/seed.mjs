import { join } from 'node:path'
import mysql from 'mysql2/promise'
import { drizzle } from 'drizzle-orm/mysql2'
import { mysqlTableCreator } from 'drizzle-orm/mysql-core'
import { eq } from 'drizzle-orm'
import { getCourseBuilderSchema } from '@coursebuilder/adapter-drizzle/mysql'
import { getBulkDiscountPercent } from '@coursebuilder/commerce/bulk-coupon'
import Stripe from 'stripe'
import { applyCatalogOverlay, catalog as baseCatalog, fixtures } from './fixtures.mjs'
import { remember } from './stripe-state.mjs'
import { assertDatabase, assertTestKey, assertTestObject, privateWrite, readCatalogOverlay } from './safety.mjs'

export const tables = getCourseBuilderSchema(mysqlTableCreator(name => `AI_${name}`))
export async function connect() {
  const pool = mysql.createPool({ uri: assertDatabase(process.env.DATABASE_URL), timezone: 'Z', connectionLimit: 2 })
  return { db: drizzle(pool, { schema: tables, mode: 'default' }), close: () => pool.end() }
}
const date = new Date('2026-01-01T00:00:00Z')
// Course Builder treats status 0 as inactive; seeded commerce rows are live, like production.
const resourceId = key => key === 'cc' ? 'workshop-2ozd9' : `rig-resource-${key}`
// List prices for this run: the synthetic catalog, or a private overlay when RIG_CATALOG_OVERLAY names one.
export async function seedCatalog(env = process.env) {
  const overlay = await readCatalogOverlay(env.RIG_CATALOG_OVERLAY)
  return { catalog: overlay ? applyCatalogOverlay(baseCatalog, overlay) : baseCatalog, catalogOverlay: Boolean(overlay) }
}
export async function seed(state, generation) {
  const { catalog, catalogOverlay } = await seedCatalog()
  const { db, close } = await connect()
  const key = process.env.STRIPE_SECRET_TOKEN
  const stripe = key === 'sk_test_RigPlaceholder' ? null : new Stripe(assertTestKey(key))
  const mappings = {}
  const metadata = { rig_run: generation, rig: 'aihero-commerce' }
  const account = stripe ? await stripe.accounts.retrieve() : null
  // accounts have no livemode; every created payment/catalog object below must have false.
  try {
    await db.insert(tables.merchantAccount).values({ id: 'rig_stripe', status: 1, label: 'stripe', identifier: account?.id ?? 'rig_pending', createdAt: date })
    await db.insert(tables.entitlementTypes).values([
      { id: 'rig_workshop_type', name: 'workshop_content_access' },
      { id: 'rig_cohort_type', name: 'cohort_content_access' },
    ])
    for (const product of catalog) {
      // New sandbox artifacts per reset. Never use production identifiers or import a dump.
      const providerProduct = stripe && assertTestObject(await stripe.products.create({ name: product.name, metadata: { ...metadata, appProductId: product.id } }, { idempotencyKey: `rig-${generation}-${product.key}-product` }))
      if (providerProduct) await remember(state, generation, 'product', providerProduct.id)
      const providerPrice = stripe && assertTestObject(await stripe.prices.create({ product: providerProduct.id, unit_amount: product.cents, currency: 'usd', metadata }, { idempotencyKey: `rig-${generation}-${product.key}-price` }))
      if (providerPrice) await remember(state, generation, 'price', providerPrice.id)
      mappings[product.key] = { product: providerProduct?.id ?? null, price: providerPrice?.id ?? null }
      // Self-paced products own workshop resources; post-purchase fulfillment ignores a 'workshop' product type.
      await db.insert(tables.products).values({ id: product.id, status: 1, name: product.name, type: product.type === 'workshop' ? 'self-paced' : product.type, fields: { slug: `rig-${product.key}`, defaultPriceId: `rig_price_${product.key}`, stripeLivemode: false }, createdAt: date })
      await db.insert(tables.prices).values({ id: `rig_price_${product.key}`, status: 1, productId: product.id, unitAmount: (product.cents / 100).toFixed(2), fields: { offer: { offered: true, position: 0 } }, createdAt: date })
      await db.insert(tables.merchantProduct).values({ id: `rig_mp_${product.key}`, status: 1, merchantAccountId: 'rig_stripe', productId: product.id, identifier: providerProduct?.id ?? null, createdAt: date })
      await db.insert(tables.merchantPrice).values({ id: `rig_mprice_${product.key}`, status: 1, merchantAccountId: 'rig_stripe', merchantProductId: `rig_mp_${product.key}`, priceId: `rig_price_${product.key}`, identifier: providerPrice?.id ?? null, createdAt: date })
    }
    // Course Builder looks bulk coupons up by type and its own tier percentages.
    // Tiers come from the installed package, so the rig mirrors that generic setup.
    const bulkTiers = [...new Set(Array.from({ length: 100 }, (_, index) => getBulkDiscountPercent(index + 1)))].filter(percent => percent > 0)
    for (const percent of bulkTiers) {
      const label = String(Math.round(percent * 100))
      const providerCoupon = stripe && assertTestObject(await stripe.coupons.create({ percent_off: Math.round(percent * 100), duration: 'once', name: `Rig bulk ${label}`, metadata }, { idempotencyKey: `rig-${generation}-bulk-${label}` }))
      if (providerCoupon) await remember(state, generation, 'coupon', providerCoupon.id)
      await db.insert(tables.merchantCoupon).values({ id: `rig_bulk_${label}`, identifier: providerCoupon?.id ?? null, status: 1, merchantAccountId: 'rig_stripe', percentageDiscount: percent.toFixed(2), type: 'bulk' })
    }
    for (const fixture of fixtures) {
      await db.insert(tables.users).values({ id: fixture.userId, name: `Rig ${fixture.key}`, email: fixture.email, emailVerified: date, createdAt: date, fields: { commerceRig: generation } })
      const org = `rig_org_${fixture.key}`, member = `rig_member_${fixture.key}`
      await db.insert(tables.organization).values({ id: org, name: `Rig ${fixture.key}`, personalOrganizationUserId: fixture.userId, createdAt: date })
      await db.insert(tables.organizationMemberships).values({ id: member, organizationId: org, userId: fixture.userId, personalOrganizationUserId: fixture.userId, invitedById: fixture.userId, role: 'owner', createdAt: date })
      // Same shape as app personal-org provisioning; without an owner role the proxy sends buyers to /organization-list.
      await db.insert(tables.roles).values({ id: `rig_role_${fixture.key}`, name: 'owner', organizationId: org, active: true, createdAt: date })
      await db.insert(tables.organizationMembershipRoles).values({ organizationMembershipId: member, roleId: `rig_role_${fixture.key}`, organizationId: org, active: true, createdAt: date })
      const customer = stripe && assertTestObject(await stripe.customers.create({ email: fixture.email, metadata: { ...metadata, userId: fixture.userId } }, { idempotencyKey: `rig-${generation}-${fixture.key}-customer` }))
      if (customer) await db.insert(tables.merchantCustomer).values({ id: `rig_customer_${fixture.key}`, status: 1, userId: fixture.userId, merchantAccountId: 'rig_stripe', identifier: customer.id, createdAt: date })
      for (const [index, purchase] of fixture.purchases.entries()) {
        const id = `rig_purchase_${fixture.key}_${index}`
        let chargeId = null
        if (stripe && purchase.cents > 0) {
          const intent = assertTestObject(await stripe.paymentIntents.create({ amount: purchase.cents, currency: 'usd', customer: customer.id, payment_method: 'pm_card_visa', payment_method_types: ['card'], confirm: true, metadata: { ...metadata, fixture: fixture.key } }, { idempotencyKey: `${generation}-${id}` }))
          if (intent.status !== 'succeeded' || typeof intent.latest_charge !== 'string') throw new Error('Historical test payment did not settle')
          const charge = assertTestObject(await stripe.charges.retrieve(intent.latest_charge))
          if (charge.amount !== purchase.cents || charge.currency !== 'usd') throw new Error('Historical payment evidence mismatch')
          assertTestObject(await stripe.charges.update(charge.id, { metadata }))
          if (purchase.status === 'Refunded') {
            await stripe.refunds.create({ charge: charge.id, metadata }, { idempotencyKey: `${generation}-${id}-refund` })
            const refunded = assertTestObject(await stripe.charges.retrieve(charge.id))
            if (!refunded.refunded || refunded.amount_refunded !== purchase.cents) throw new Error('Historical refund evidence mismatch')
          }
          chargeId = `rig_charge_${fixture.key}_${index}`
          await db.insert(tables.merchantCharge).values({ id: chargeId, status: 1, identifier: charge.id, userId: fixture.userId, merchantCustomerId: `rig_customer_${fixture.key}`, merchantProductId: `rig_mp_${purchase.product}`, merchantAccountId: 'rig_stripe', createdAt: date })
        }
        let couponId = null
        if (purchase.bulk || purchase.redeemed || purchase.ppp) {
          couponId = `rig_coupon_${fixture.key}_${index}`
          await db.insert(tables.coupon).values({ id: couponId, status: 1, code: couponId, restrictedToProductId: catalog.find(p => p.key === purchase.product).id, maxUses: purchase.seats ?? 1, fields: { commerceRig: generation, pppOrigin: Boolean(purchase.ppp) }, createdAt: date })
        }
        await db.insert(tables.purchases).values({ id, userId: fixture.userId, organizationId: org, purchasedByorganizationMembershipId: member, productId: catalog.find(p => p.key === purchase.product).id, totalAmount: (purchase.cents / 100).toFixed(2), status: purchase.status ?? 'Valid', merchantChargeId: chargeId, bulkCouponId: purchase.bulk ? couponId : null, redeemedBulkCouponId: purchase.redeemed ? couponId : null, couponId: purchase.ppp ? couponId : null, fields: { commerceRig: generation, ...(purchase.seats ? { seats: purchase.seats } : {}) }, createdAt: date })
        const workshop = catalog.find(p => p.key === purchase.product).type === 'workshop'
        if (purchase.status !== 'Refunded') await db.insert(tables.entitlements).values({ id: `rig_access_${fixture.key}_${index}`, userId: fixture.userId, organizationId: org, organizationMembershipId: member, entitlementType: workshop ? 'rig_workshop_type' : 'rig_cohort_type', sourceType: 'PURCHASE', sourceId: id, metadata: { contentIds: [workshop ? resourceId(purchase.product) : `rig-workshop-${purchase.product}`] }, createdAt: date, updatedAt: date })
      }
    }
    for (const product of catalog) {
      await db.insert(tables.contentResource).values({ id: resourceId(product.key), type: product.type, createdById: 'rig_new-buyer', slug: `rig-${product.key}`, fields: { title: product.name, slug: `rig-${product.key}`, state: 'published', ...(product.type === 'cohort' ? { startsAt: '2027-01-01T00:00:00Z', endsAt: '2027-02-01T00:00:00Z' } : {}) }, createdAt: date, updatedAt: date })
      await db.insert(tables.contentResourceProduct).values({ productId: product.id, resourceId: resourceId(product.key), createdAt: date, updatedAt: date })
      if (product.type === 'cohort') {
        const child = `rig-workshop-${product.key}`
        await db.insert(tables.contentResource).values({ id: child, type: 'workshop', createdById: 'rig_new-buyer', slug: child, fields: { title: `${product.name} Workshop`, slug: child, state: 'published' }, createdAt: date, updatedAt: date })
        await db.insert(tables.contentResourceResource).values({ resourceOfId: resourceId(product.key), resourceId: child, createdAt: date, updatedAt: date })
      }
    }
    await privateWrite(join(state, 'seed.json'), JSON.stringify({ generation, catalog, catalogOverlay, mappings, fixtures, stripeSeeded: Boolean(stripe), bulkTiers: bulkTiers.length, policy: `${catalogOverlay ? 'Synthetic catalog with private list-price overlay' : 'Synthetic bare catalog'} plus Course Builder generic bulk tiers; no production discount configuration imported` }, null, 2) + '\n')
    return { fixtureCount: fixtures.length, stripeSeeded: Boolean(stripe) }
  } finally { await close() }
}

export async function authenticate(fixture, token) {
  const { db, close } = await connect()
  try {
    const user = await db.query.users.findFirst({ where: eq(tables.users.id, fixture.userId) })
    if (user?.email !== fixture.email || !user.email.endsWith('@example.test')) throw new Error('Fixture user is missing or not synthetic')
    await db.insert(tables.sessions).values({ sessionToken: token, userId: fixture.userId, expires: new Date(Date.now() + 3600000) })
  } finally { await close() }
}
export async function evidence(fixture, sessionId) {
  const { db, close } = await connect()
  try {
    const session = await db.query.merchantSession.findFirst({ where: eq(tables.merchantSession.identifier, sessionId) })
    const purchases = session ? await db.query.purchases.findMany({ where: eq(tables.purchases.merchantSessionId, session.id) }) : []
    const access = await db.query.entitlements.findMany({ where: eq(tables.entitlements.userId, fixture.userId) })
    const events = await db.query.merchantEvents.findMany()
    const webhooks = events.filter(event => {
      const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload
      return payload?.type === 'checkout.session.completed' && payload?.data?.object?.id === sessionId
    }).map(event => ({ id: event.id, identifier: event.identifier }))
    const sourceIds = new Set(purchases.map(purchase => purchase.id))
    const typeNames = new Map((await db.query.entitlementTypes.findMany()).map(type => [type.id, type.name]))
    return {
      webhooks,
      purchases: purchases.map(p => ({ id: p.id, userId: p.userId, productId: p.productId, status: p.status, totalAmount: p.totalAmount })),
      access: access.filter(a => sourceIds.has(a.sourceId) && !a.deletedAt && (!a.expiresAt || a.expiresAt > new Date())).map(a => ({ id: a.id, sourceId: a.sourceId, entitlementType: typeNames.get(a.entitlementType) ?? 'unknown', metadata: a.metadata })),
    }
  } finally { await close() }
}
if (process.argv[1]?.endsWith('/seed.mjs')) {
  try { console.log(JSON.stringify(await seed(process.argv[2], process.argv[3]))) }
  catch { console.error('Fixture seed failed; no credentials printed. Reset before retry.'); process.exitCode = 1 }
}
