// @ts-nocheck: untyped Node operator tooling, covered by rig.test.mjs; not app code.
// Test-only transport overlay, loaded by the private Next process preload.
// Keep ordinary app attribution fields, and tag objects at CREATE time.
const https = require('node:https')
const { syncBuiltinESMExports } = require('node:module')
const createPaths = new Set(['/v1/checkout/sessions', '/v1/customers', '/v1/coupons', '/v1/products', '/v1/prices', '/v1/payment_intents', '/v1/refunds'])
function tagBody(path, body, run) {
  if (!createPaths.has(path) || !/^[a-f0-9-]{36}$/.test(run || '')) throw new Error('commerce-rig: invalid Stripe create tagging contract')
  const params = new URLSearchParams(body)
  params.set('metadata[rig]', 'aihero-commerce')
  params.set('metadata[rig_run]', run)
  if (path === '/v1/checkout/sessions' && (params.get('mode') || 'payment') === 'payment') {
    params.set('payment_intent_data[metadata][rig]', 'aihero-commerce')
    params.set('payment_intent_data[metadata][rig_run]', run)
  }
  return params.toString()
}
function install(run) {
  const request = https.request
  https.request = function (...args) {
    const options = typeof args[0] === 'object' && !(args[0] instanceof URL) ? args[0] : { ...args[1], hostname: new URL(args[0]).hostname, path: new URL(args[0]).pathname }
    const req = request.apply(this, args)
    const path = (options.path || '').split('?')[0]
    if (options.hostname !== 'api.stripe.com' && options.host !== 'api.stripe.com' || String(options.method || 'GET').toUpperCase() !== 'POST' || !createPaths.has(path)) return req
    const write = req.write.bind(req), end = req.end.bind(req)
    const chunks = []
    req.write = function (chunk, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined))
      const cb = typeof encoding === 'function' ? encoding : callback
      if (cb) process.nextTick(cb)
      return true
    }
    req.end = function (chunk, encoding, callback) {
      if (typeof chunk === 'function') { callback = chunk; chunk = undefined }
      if (typeof encoding === 'function') { callback = encoding; encoding = undefined }
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
      const body = tagBody(path, Buffer.concat(chunks).toString('utf8'), run)
      req.setHeader('Content-Length', Buffer.byteLength(body))
      write(body)
      return end(callback)
    }
    return req
  }
  syncBuiltinESMExports()
}
module.exports = { tagBody, install }
