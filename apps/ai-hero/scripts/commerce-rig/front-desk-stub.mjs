// @ts-nocheck: untyped Node operator tooling, covered by rig.test.mjs; not app code.
// A loopback stand-in for front-desk's two pricing data routes, so a rig run can
// price C5 with the in-process engine. It serves only what a private data file
// names: { "policy": { "version", "policy" }, "quotes": { "<email>": [quote] } }.
// No policy or quote lives in this repo; without RIG_FRONT_DESK_DATA it never runs.
import http from 'node:http'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { timingSafeEqual } from 'node:crypto'

export const POLICY_PATH = '/api/pricing/policy'
export const BINDING_QUOTES_PATH = '/api/binding-quotes'
const C5 = 'product-s00zs'

export async function readFrontDeskData(path) {
  if (!path) return null
  if (!isAbsolute(path)) throw new Error('RIG_FRONT_DESK_DATA must be an absolute path')
  const stat = await lstat(path)
  if (!stat.isFile()) throw new Error('Front-desk data must be a regular file')
  let data
  try { data = JSON.parse(await readFile(path, 'utf8')) } catch { throw new Error('Front-desk data is not valid JSON') }
  if (typeof data?.policy?.version !== 'string' || typeof data.policy.policy !== 'object') throw new Error('Front-desk data needs a policy document')
  if (data.quotes !== undefined && (typeof data.quotes !== 'object' || Array.isArray(data.quotes))) throw new Error('Front-desk quotes must be keyed by email')
  return data
}

const same = (given, expected) => {
  const a = Buffer.from(String(given)), b = Buffer.from(String(expected))
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The routes, as front-desk answers them: bearer auth, ETag on the policy, quotes per buyer. */
export function frontDeskHandler(data, tokens) {
  const etag = `"${data.policy.version}"`
  return async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const bearer = (request.headers.authorization ?? '').replace(/^Bearer /, '')
    const send = (status, body, headers = {}) => {
      response.writeHead(status, body === undefined ? headers : { 'content-type': 'application/json', ...headers })
      response.end(body === undefined ? undefined : JSON.stringify(body))
    }
    // Local-only Redis REST read for the C5 flag. Null exercises the
    // development default. Every other command, including writes, is refused.
    if (request.method === 'POST' && ['/', '/pipeline'].includes(url.pathname)) {
      let body = ''
      for await (const chunk of request) body += chunk
      let input
      try { input = JSON.parse(body) } catch { return send(400, { error: 'InvalidInput' }) }
      const commands = url.pathname === '/pipeline' ? input : [input]
      const allowed = same(bearer, 'rig-disabled') && Array.isArray(commands) && commands.length === 1 &&
        Array.isArray(commands[0]) && commands[0].length === 2 &&
        String(commands[0][0]).toLowerCase() === 'get' && commands[0][1] === 'flag:development:c5-pricing-enabled'
      if (!allowed) return send(403, { error: 'rig-flag-command-refused' })
      return send(200, url.pathname === '/pipeline' ? [{ result: null }] : { result: null })
    }
    if (url.pathname === POLICY_PATH && request.method === 'GET') {
      if (!same(bearer, tokens.pricing)) return send(401)
      if (url.searchParams.get('productId') !== C5) return send(400, { error: 'InvalidInput' })
      const cache = { etag, 'cache-control': 'private, max-age=300, stale-while-revalidate=86400' }
      if (request.headers['if-none-match'] === etag) return send(304, undefined, cache)
      return send(200, data.policy, cache)
    }
    if (url.pathname === BINDING_QUOTES_PATH && request.method === 'POST') {
      if (!same(bearer, tokens.quotes)) return send(401)
      let body = ''
      for await (const chunk of request) body += chunk
      let input
      try { input = JSON.parse(body) } catch { return send(400, { error: 'InvalidInput' }) }
      if (input?.productId !== C5 || typeof input.email !== 'string' || !Number.isInteger(input.quantity)) return send(400, { error: 'InvalidInput' })
      const quotes = (data.quotes?.[input.email.trim().toLowerCase()] ?? []).filter(quote => quote.quantity === input.quantity)
      return send(200, quotes, { 'cache-control': 'private, no-store' })
    }
    return send(404)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [path, port] = process.argv.slice(2)
  const data = await readFrontDeskData(path)
  const tokens = { pricing: process.env.FRONT_DESK_STUB_PRICING_TOKEN, quotes: process.env.FRONT_DESK_STUB_QUOTES_TOKEN }
  if (!tokens.pricing || !tokens.quotes) throw new Error('front-desk stub needs both tokens')
  http.createServer(frontDeskHandler(data, tokens)).listen(Number(port), '127.0.0.1', () => console.log(`front-desk stub on 127.0.0.1:${port}`))
}
