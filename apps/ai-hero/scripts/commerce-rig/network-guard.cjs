// Loaded only by rig-owned Node children. No application source changes.
// Fail closed: fixtures must not call email/support/media/analytics providers.
const net = require('node:net')
const tls = require('node:tls')
const { syncBuiltinESMExports } = require('node:module')
const slot = Number(process.env.RIG_SLOT || 0)
if (!Number.isInteger(slot) || slot < 0 || slot > 9) throw new Error('commerce-rig: invalid slot')
const localPorts = new Set([9, 3310 + slot * 10, 8288 + slot * 10, 8289 + slot * 10, 13316 + slot * 10])
function allowed(host, port) {
  host = String(host || 'localhost').toLowerCase()
  return ((host === '127.0.0.1' || host === 'localhost' || host === '::1') && localPorts.has(Number(port))) || (host === 'api.stripe.com' && Number(port) === 443)
}
function check(args) {
  let first = args[0]
  if (Array.isArray(first)) return check(first)
  const options = typeof first === 'object' && first !== null ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' }
  // IPC between Next.js processes is permitted; outbound Unix sockets are not.
  if (options.path || typeof first === 'string' && !/^\d+$/.test(first)) throw new Error('commerce-rig: outbound Unix socket blocked')
  if (!allowed(options.hostname ?? options.host, options.port)) throw new Error('commerce-rig: third-party network call blocked')
}
const socketConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) { check(args); return socketConnect.apply(this, args) }
const tlsConnect = tls.connect
tls.connect = function (...args) { check(args); return tlsConnect.apply(this, args) }
const originalFetch = globalThis.fetch
if (originalFetch) globalThis.fetch = function (input, options) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!allowed(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80))) return Promise.reject(new Error('commerce-rig: third-party fetch blocked'))
  return originalFetch.call(this, input, options)
}
syncBuiltinESMExports()
if (process.env.COMMERCE_RIG_RUN) require('./stripe-metadata.cjs').install(process.env.COMMERCE_RIG_RUN)
module.exports = { allowed, check }
