// Synthetic inputs, not a production catalog or a pricing-policy implementation.
export const c5WorkshopId = 'rig-workshop-c5'
export const catalog = [
  { key: 'c5', id: 'product-s00zs', name: 'Rig C5', type: 'cohort', cents: 100000 },
  { key: 'cc', id: 'product-ma254', name: 'Rig Crash Course', type: 'workshop', cents: 29900 },
  { key: 'c3', id: 'product-7t9ek', name: 'Rig C3', type: 'cohort', cents: 99500 },
  { key: 'c4', id: 'product-pqkk5', name: 'Rig C4', type: 'cohort', cents: 99500 },
  // The rest of the paid catalog a legend owns. Historical amounts are placeholders.
  { key: 'c1', id: 'product-3vfob', name: 'Rig DeepSearch C1', type: 'cohort', cents: 49900 },
  { key: 'c2', id: 'product-wdhub', name: 'Rig Personal Assistant C2', type: 'cohort', cents: 49900 },
  { key: 'sdk', id: 'product-9wdta', name: 'Rig AI SDK v6 Crash Course', type: 'workshop', cents: 9900 },
]
const cc = (cents, extra = {}) => ({ product: 'cc', cents, ...extra })
const alum = (product) => ({ product, cents: 99500 })
export const fixtures = [
  { key: 'new-buyer', purchases: [] },
  ...[99, 199, 299].map(dollars => ({ key: `cc-${dollars}`, purchases: [cc(dollars * 100)] })),
  ...['c3', 'c4'].flatMap(product => [
    { key: `${product}-alum`, purchases: [alum(product)] },
    ...[99, 199, 299].map(dollars => ({ key: `${product}-alum-cc-${dollars}`, purchases: [alum(product), cc(dollars * 100)] })),
  ]),
  { key: 'legend', purchases: [{ product: 'c1', cents: 49900 }, { product: 'sdk', cents: 9900 }, { product: 'c2', cents: 49900 }, alum('c3'), alum('c4'), cc(29900)], pending: 'Reviewed legend manifest and pricing fact adapter' },
  { key: 'ppp-origin', purchases: [cc(9900, { status: 'Restricted', ppp: true })] },
  { key: 'refunded-cc', purchases: [cc(19900, { status: 'Refunded' })] },
  { key: 'team-seat', purchases: [cc(0, { redeemed: true })] },
  { key: 'team-purchaser', quantity: 5, purchases: [cc(59700, { bulk: true, seats: 3 })] },
  // Fresh team orders at the first quantity of each seat band.
  ...[2, 5, 10, 30].map(seats => ({ key: `team-${seats}`, quantity: seats, purchases: [] })),
  { key: 'binding-quote', purchases: [cc(9900)], pending: 'Confirmed quote store and pricing fact adapter', quoteInput: { currency: 'USD', unitAmountCents: 60000, quantity: 1, basis: 'unit' } },
].map(fixture => ({ ...fixture, userId: `rig_${fixture.key}`, email: `${fixture.key}@example.test`, quantity: fixture.quantity ?? 1 }))
// A measurement run may replace list prices from a private overlay: { "amounts": { "<catalog key>": <cents> } }.
export function applyCatalogOverlay(base, overlay) {
  const amounts = overlay?.amounts
  if (!amounts || typeof amounts !== 'object' || Array.isArray(amounts)) throw new Error('Catalog overlay must have an amounts object')
  for (const [key, cents] of Object.entries(amounts)) {
    if (!base.some(product => product.key === key)) throw new Error('Catalog overlay names an unknown catalog key')
    if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('Catalog overlay amounts must be positive integer cents')
  }
  return base.map(product => product.key in amounts ? { ...product, cents: amounts[product.key] } : product)
}
export function fixtureFor(key) {
  const fixture = fixtures.find(item => item.key === key)
  if (!fixture) throw new Error('Unknown fixture. Run rig fixtures.')
  return fixture
}
