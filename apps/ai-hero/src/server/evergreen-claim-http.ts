import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { authSessionCookieNames } from '@/lib/oauth-link-cookie'
import { createAuthenticatedOAuthLinkSessionResolver, type AuthenticatedOAuthLinkSession } from './oauth-link-session'

export type ClaimStatus = 'unavailable' | 'verification-needed' | 'ready' | 'pending' | 'bound'
export type ClaimApplication = {
 status(session: AuthenticatedOAuthLinkSession): Promise<ClaimStatus>
 claim(session: AuthenticatedOAuthLinkSession): Promise<ClaimStatus>
}
type SessionLookup = Parameters<typeof createAuthenticatedOAuthLinkSessionResolver>[0]['getSessionAndUser']

/** Unregistered by default. No client contact/user/journey/coupon selector.
 * The generic URL is navigation, not authority. GET never calls claim/advance. */
export function createEvergreenClaimHttp(options: {
 enabled: boolean
 origin: string
 productPath: string
 secret: string
 getSessionAndUser: SessionLookup
 application: ClaimApplication
 now?: () => Date
}) {
 const origin = new URL(options.origin).origin
 if (!options.productPath.startsWith('/products/') || /[?#\\]/.test(options.productPath)) throw new Error('Invalid claim product path')
 if (options.enabled && !options.secret) throw new Error('Claim CSRF secret required')
 const now = options.now ?? (() => new Date())
 const mac = (session: string, value: string) => createHmac('sha256', options.secret).update(JSON.stringify(['aih:claim:csrf:v1', origin, options.productPath, session, value])).digest('hex')
 const issue = (session: string) => {
  const value = `${now().getTime() + 300_000}.${randomBytes(24).toString('hex')}`
  return `${value}.${mac(session, value)}`
 }
 const valid = (session: string, token: unknown) => {
  if (typeof token !== 'string' || !/^\d{13}\.([a-f0-9]{48})\.([a-f0-9]{64})$/.test(token)) return false
  const [expiry, nonce, signature] = token.split('.')
  const remaining = Number(expiry) - now().getTime()
  return remaining > 0 && remaining <= 300_000 && timingSafeEqual(Buffer.from(signature!, 'hex'), Buffer.from(mac(session, `${expiry}.${nonce}`), 'hex'))
 }
 const reply = (status: ClaimStatus, code = 200, csrf?: string) => Response.json({status, ...(csrf ? {csrf} : {})}, {status: code, headers: {'Cache-Control':'no-store, private', 'Vary':'Cookie', 'Referrer-Policy':'no-referrer'}})
 return async (request: Request): Promise<Response> => {
  if (request.method !== 'GET' && request.method !== 'POST') return reply('unavailable', 405)
  if (!options.enabled) return reply('unavailable', 404)
  const url = new URL(request.url)
  if (url.origin !== origin || url.search) return reply('unavailable', 400)
  if (request.method === 'POST' && (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site')) return reply('unavailable', 403)
  try {
   const cookies = new Map<string,string>()
   for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('='); if (index < 0) continue
    const name = part.slice(0,index).trim()
    if (!(authSessionCookieNames as readonly string[]).includes(name)) continue
    if (cookies.size || cookies.has(name)) return reply('unavailable',403)
    cookies.set(name, decodeURIComponent(part.slice(index+1)))
   }
   const session = await createAuthenticatedOAuthLinkSessionResolver({getCookieStore:()=>({delete:()=>undefined,get:(name)=>cookies.has(name)?{value:cookies.get(name)!}:undefined}), getSessionAndUser: options.getSessionAndUser, now})()
   if (!session) return reply('verification-needed',401)
   if (request.method === 'GET') return reply(await options.application.status(session),200,issue(session.sessionToken))
   if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return reply('unavailable',415)
   // Bound bytes before parsing; no return path or identity fields are accepted.
   const reader = request.body?.getReader(); if (!reader) return reply('unavailable',400)
   const chunks: Uint8Array[] = []; let length = 0
   try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 1024) { await reader.cancel(); return reply('unavailable',413) }; chunks.push(part.value) } } finally { reader.releaseLock() }
   const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
   if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('csrf' in body) || !valid(session.sessionToken,body.csrf)) return reply('unavailable',403)
   return reply(await options.application.claim(session))
  } catch { return reply('unavailable',503) }
 }
}
