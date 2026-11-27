// Run against a production build served by next start, not next dev.
import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:3000')
assert(origin.protocol === 'http:' && origin.hostname === '127.0.0.1')
assert(!origin.username && !origin.password)
const page = new URL('/cohorts/synthetic-c5-header-proof', origin)
const selector = `c5comp_${'a'.repeat(40)}`
/** @param {URL} url */
const request = (url) => fetch(url, { redirect: 'manual' })

/** @param {Response} response */
async function check(response) {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/html/)
  assert((await response.text()).includes('Synthetic C5 Header Proof'))
}

let ordinary
for (let i = 0; i < 40; i++) {
  try { ordinary = await request(page); break } catch { await setTimeout(250) }
}
assert(ordinary, 'next start did not answer')
await check(ordinary)
assert.notEqual(ordinary.headers.get('referrer-policy'), 'no-referrer')

page.searchParams.set('code', 'ordinary-free')
const ordinaryCode = await request(page)
await check(ordinaryCode)
assert.notEqual(ordinaryCode.headers.get('referrer-policy'), 'no-referrer')

page.searchParams.set('code', selector)
const reserved = await request(page)
await check(reserved)
assert.match(reserved.headers.get('cache-control') ?? '', /(?:^|,\s*)no-store\b/)
assert.equal(reserved.headers.get('referrer-policy'), 'no-referrer')
console.log(`Built cohort HTML: ${reserved.status}, ${reserved.headers.get('cache-control')}, ${reserved.headers.get('referrer-policy')}`)
