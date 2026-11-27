// Run against the fixture cohort in a production build served by next start.
import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:3000')
assert(origin.protocol === 'http:' && origin.hostname === '127.0.0.1')
assert(!origin.username && !origin.password)
const page = new URL('/cohorts/synthetic-c5-header-proof', origin)
const selector = `c5comp_${'a'.repeat(40)}`
/** @param {URL} url @param {HeadersInit} [headers] */
const request = (url, headers) => fetch(url, { redirect: 'manual', headers })
/** @param {Response} response */
async function check(response) {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/html/)
  const html = await response.text()
  assert(html.includes('Synthetic C5 Header Proof'))
  assert(!html.includes(selector), 'selector must not appear in HTML or initial RSC')
}
/** @param {Response} response */
function privateResponse(response) {
  assert.match(response.headers.get('cache-control') ?? '', /(?:^|,\s*)no-store\b/)
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
}

let ordinary
for (let i = 0; i < 40; i++) {
  try { ordinary = await request(page); break } catch { await setTimeout(250) }
}
assert(ordinary, 'next start did not answer')
await check(ordinary)
assert.notEqual(ordinary.headers.get('referrer-policy'), 'no-referrer')

const ordinaryCode = new URL('?code=ordinary-free', page)
const ordinaryResponse = await request(ordinaryCode)
await check(ordinaryResponse)
assert.notEqual(ordinaryResponse.headers.get('referrer-policy'), 'no-referrer')

const entry = await request(new URL(`?code=${selector}`, page))
assert.equal(entry.status, 303)
privateResponse(entry)
assert.equal(new URL(entry.headers.get('location') ?? '', page).href, page.href)
assert(!(await entry.text()).includes(selector))
const cookie = entry.headers.getSetCookie().find((value) => value.startsWith('aih-c5-comp='))
assert(cookie && /; HttpOnly/i.test(cookie) && /; Secure/i.test(cookie) && /; SameSite=Lax/i.test(cookie))
const reserved = await request(page, { cookie: cookie.split(';', 1)[0] ?? '' })
await check(reserved)
privateResponse(reserved)
const outside = await request(new URL(`/?code=${selector}`, page))
assert.equal(outside.status, 303)
privateResponse(outside)
assert.equal(new URL(outside.headers.get('location') ?? '', page).href, origin.href)
assert.equal(outside.headers.get('set-cookie'), null)
console.log('Built cohort: private 303, then private 200 HTML without the selector')
