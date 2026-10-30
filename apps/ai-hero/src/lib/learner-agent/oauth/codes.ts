import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { env } from '@/env.mjs'
import { redis } from '@/server/redis-client'

import { nowSeconds, seal, unseal } from './sealed'

/**
 * A validated authorization request: everything the consent page shows and
 * the code later binds. Built only by `checkAuthorizeRequest`.
 */
export type AuthorizeRequest = {
	clientId: string
	clientName: string
	clientHost: string
	redirectUri: string
	codeChallenge: string
	state: string | null
	resource: string | null
}

export const CODE_TTL_SECONDS = 60
export const CONSENT_TTL_SECONDS = 10 * 60
/** The Redis claim outlives the code, so a late replay still finds it. */
const CLAIM_TTL_SECONDS = 120

const digest = (value: string) =>
	createHash('sha256').update(value).digest('base64url')

/** PKCE S256: base64url(sha256(verifier)), compared in constant time. */
export function pkceMatches(verifier: unknown, challenge: string) {
	if (
		typeof verifier !== 'string' ||
		!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)
	)
		return false
	const expected = Buffer.from(challenge)
	const actual = Buffer.from(digest(verifier))
	return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** An S256 challenge is a 43-character base64url sha256. */
export const isS256Challenge = (value: unknown): value is string =>
	typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)

type CodePayload = {
	v: 1
	sub: string
	/** sha256 of the client id: DCR ids are long, the code stays short. */
	cid: string
	ch: string
	cn: string
	ru: string
	cc: string
	rs: string | null
	exp: number
	jti: string
}

export type AuthorizationCode = {
	userId: string
	clientName: string
	clientHost: string
	redirectUri: string
	codeChallenge: string
	resource: string | null
	jti: string
	matchesClient: (clientId: unknown) => boolean
}

/** A 60-second, sealed code for one approved request. */
export function mintAuthorizationCode(
	userId: string,
	request: AuthorizeRequest,
) {
	return seal('code', {
		v: 1,
		sub: userId,
		cid: digest(request.clientId),
		ch: request.clientHost,
		cn: request.clientName,
		ru: request.redirectUri,
		cc: request.codeChallenge,
		rs: request.resource,
		exp: nowSeconds() + CODE_TTL_SECONDS,
		jti: randomUUID(),
	} satisfies CodePayload)
}

/** The code's claims, or null when it is malformed, foreign or expired. */
export function openAuthorizationCode(code: unknown): AuthorizationCode | null {
	const value = unseal('code', code) as Partial<CodePayload> | null
	if (
		!value ||
		value.v !== 1 ||
		typeof value.sub !== 'string' ||
		typeof value.cid !== 'string' ||
		typeof value.ru !== 'string' ||
		typeof value.cc !== 'string' ||
		typeof value.jti !== 'string' ||
		typeof value.exp !== 'number' ||
		value.exp < nowSeconds()
	)
		return null
	const cid = value.cid
	return {
		userId: value.sub,
		clientName: typeof value.cn === 'string' ? value.cn : '',
		clientHost: typeof value.ch === 'string' ? value.ch : 'unknown',
		redirectUri: value.ru,
		codeChallenge: value.cc,
		resource: typeof value.rs === 'string' ? value.rs : null,
		jti: value.jti,
		matchesClient: (clientId) =>
			typeof clientId === 'string' && digest(clientId) === cid,
	}
}

type ConsentPayload = AuthorizeRequest & { v: 1; sub: string; exp: number }

/**
 * The consent page's ticket: the validated request, bound to the signed-in
 * learner for ten minutes. The decision route trusts nothing else.
 */
export function mintConsentTicket(userId: string, request: AuthorizeRequest) {
	return seal('consent', {
		...request,
		v: 1,
		sub: userId,
		exp: nowSeconds() + CONSENT_TTL_SECONDS,
	} satisfies ConsentPayload)
}

export function openConsentTicket(
	ticket: unknown,
): { userId: string; request: AuthorizeRequest } | null {
	const value = unseal('consent', ticket) as Partial<ConsentPayload> | null
	if (
		!value ||
		value.v !== 1 ||
		typeof value.sub !== 'string' ||
		typeof value.exp !== 'number' ||
		value.exp < nowSeconds() ||
		typeof value.clientId !== 'string' ||
		typeof value.clientName !== 'string' ||
		typeof value.clientHost !== 'string' ||
		typeof value.redirectUri !== 'string' ||
		typeof value.codeChallenge !== 'string'
	)
		return null
	return {
		userId: value.sub,
		request: {
			clientId: value.clientId,
			clientName: value.clientName,
			clientHost: value.clientHost,
			redirectUri: value.redirectUri,
			codeChallenge: value.codeChallenge,
			state: typeof value.state === 'string' ? value.state : null,
			resource: typeof value.resource === 'string' ? value.resource : null,
		},
	}
}

/** Development has no Redis: claim in memory instead. */
const developmentClaims = new Map<string, { value: string; until: number }>()

const claimKey = (jti: string) => `learner-oauth:code:${jti}`

/**
 * Claims a code's `jti` once (SET NX). A second claim is a replay. Redis
 * failing is `unavailable`: single use is the guard, so the grant fails
 * closed rather than risk a second token.
 */
export async function claimCodeOnce(
	jti: string,
): Promise<'claimed' | 'reused' | 'unavailable'> {
	const key = claimKey(jti)
	if (env.NODE_ENV === 'development') {
		const now = Date.now()
		const held = developmentClaims.get(key)
		if (held && held.until > now) return 'reused'
		developmentClaims.set(key, {
			value: 'pending',
			until: now + CLAIM_TTL_SECONDS * 1000,
		})
		return 'claimed'
	}
	try {
		const set = await redis.set(key, 'pending', {
			nx: true,
			ex: CLAIM_TTL_SECONDS,
		})
		return set === 'OK' ? 'claimed' : 'reused'
	} catch {
		return 'unavailable'
	}
}

/** Remembers which token a code minted, so a replay can revoke it. */
export async function recordCodeToken(jti: string, tokenId: string) {
	const key = claimKey(jti)
	if (env.NODE_ENV === 'development') {
		const held = developmentClaims.get(key)
		if (held) held.value = tokenId
		return
	}
	await redis
		.set(key, tokenId, { xx: true, ex: CLAIM_TTL_SECONDS })
		.catch(() => undefined)
}

/** The token id a claimed code minted, if it got that far. */
export async function tokenIdForCode(jti: string): Promise<string | null> {
	const key = claimKey(jti)
	const value =
		env.NODE_ENV === 'development'
			? (developmentClaims.get(key)?.value ?? null)
			: await redis.get<string>(key).catch(() => null)
	return typeof value === 'string' && value !== 'pending' ? value : null
}
