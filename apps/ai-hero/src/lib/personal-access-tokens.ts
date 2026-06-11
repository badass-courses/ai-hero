import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from 'node:crypto'

import { guid } from '@coursebuilder/utils/guid'

export const PERSONAL_ACCESS_TOKEN_PREFIX = 'aih_pat' as const
export const ANALYTICS_READ_SCOPE = 'analytics:read' as const

export type PersonalAccessTokenScope =
	| typeof ANALYTICS_READ_SCOPE
	| 'analytics:chat'
	| 'content:read'

export type PersonalAccessTokenRecord = {
	id: string
	userId: string
	name: string
	publicId: string
	tokenPrefix: string
	tokenHash: string
	scopes: string[]
	expiresAt: Date | null
	lastUsedAt?: Date | null
	revokedAt: Date | null
	createdAt?: Date | null
	updatedAt?: Date | null
}

export type CreatedPersonalAccessToken = {
	rawToken: string
	record: PersonalAccessTokenRecord
}

export type ParsedPersonalAccessToken = {
	publicId: string
	secret: string
	tokenPrefix: string
}

export type VerifyPersonalAccessTokenResult =
	| { ok: true; record: PersonalAccessTokenRecord }
	| {
			ok: false
			reason:
				| 'malformed'
				| 'mismatched-id'
				| 'wrong-hash'
				| 'expired'
				| 'revoked'
				| 'missing-scope'
	  }

/**
 * Creates a raw Personal Access Token plus the database record to persist.
 *
 * Store `record` in `PersonalAccessToken` and show `rawToken` to the operator
 * once. Optional `now`, `publicId`, `secret`, and `id` are test hooks, normal
 * callers should omit them. `hashSecret` is the server-side HMAC key or pepper.
 *
 * @param input - User, display name, scopes, hash secret, optional expiration,
 * and optional test overrides.
 * @returns The one-time raw token and the safe record to persist.
 * @throws When `hashSecret` is empty.
 *
 * @example
 * ```ts
 * const { rawToken, record } = createPersonalAccessToken({
 * 	userId,
 * 	name: 'Analytics API token',
 * 	scopes: [ANALYTICS_READ_SCOPE],
 * 	hashSecret: env.PERSONAL_ACCESS_TOKEN_SECRET,
 * 	expiresAt,
 * })
 * await db.insert(personalAccessToken).values(record)
 * return rawToken
 * ```
 */
export function createPersonalAccessToken(input: {
	userId: string
	name: string
	scopes: PersonalAccessTokenScope[]
	hashSecret: string
	expiresAt?: Date | null
	now?: Date
	publicId?: string
	secret?: string
	id?: string
}): CreatedPersonalAccessToken {
	const publicId = input.publicId ?? randomTokenPart(16)
	const secret = input.secret ?? randomTokenPart(32)
	const rawToken = `${PERSONAL_ACCESS_TOKEN_PREFIX}_${publicId}_${secret}`
	const tokenPrefix = buildTokenPrefix(publicId)
	const now = input.now ?? new Date()

	return {
		rawToken,
		record: {
			id: input.id ?? guid(),
			userId: input.userId,
			name: input.name,
			publicId,
			tokenPrefix,
			tokenHash: hashPersonalAccessTokenSecret(secret, input.hashSecret),
			scopes: input.scopes,
			expiresAt: input.expiresAt ?? null,
			lastUsedAt: null,
			revokedAt: null,
			createdAt: now,
			updatedAt: now,
		},
	}
}

/**
 * Parses an `aih_pat_<public_id>_<secret>` token without verifying it.
 *
 * Use the returned `publicId` or `tokenPrefix` to find a candidate database
 * record, then verify the secret hash with `verifyPersonalAccessToken`.
 *
 * @param rawToken - Bearer token string supplied by an operator or agent.
 * @returns Parsed token parts, or null when the token shape is invalid.
 *
 * @example
 * ```ts
 * const parsed = parsePersonalAccessToken(rawToken)
 * const record = parsed
 * 	? await db.query.personalAccessToken.findFirst({ where: eq(personalAccessToken.publicId, parsed.publicId) })
 * 	: null
 * ```
 */
export function parsePersonalAccessToken(
	rawToken: string,
): ParsedPersonalAccessToken | null {
	const parts = rawToken.split('_')

	if (parts.length !== 4) {
		return null
	}

	const [prefix, tokenType, publicId, secret] = parts

	if (`${prefix}_${tokenType}` !== PERSONAL_ACCESS_TOKEN_PREFIX) {
		return null
	}

	if (!isTokenPart(publicId) || !isTokenPart(secret)) {
		return null
	}

	return {
		publicId,
		secret,
		tokenPrefix: buildTokenPrefix(publicId),
	}
}

/**
 * Derives the stored token hash from a raw PAT secret.
 *
 * Uses HMAC-SHA-256 with a server-side secret so database rows do not contain
 * reusable raw token material.
 *
 * @param secret - The random secret segment from the raw PAT.
 * @param hashSecret - Server-side HMAC key or pepper.
 * @returns Hex encoded HMAC-SHA-256 digest for storage and comparison.
 * @throws When `hashSecret` is empty.
 *
 * @example
 * ```ts
 * const tokenHash = hashPersonalAccessTokenSecret(parsed.secret, env.PERSONAL_ACCESS_TOKEN_SECRET)
 * ```
 */
export function hashPersonalAccessTokenSecret(
	secret: string,
	hashSecret: string,
) {
	if (hashSecret.length === 0) {
		throw new Error('Personal access token hash secret is required')
	}

	return createHmac('sha256', hashSecret).update(secret).digest('hex')
}

/**
 * Verifies a raw PAT against a candidate persisted record and required scope.
 *
 * Checks token shape, revocation, expiration, required scope, and HMAC hash.
 * The optional `now` parameter is a test hook for deterministic expiration
 * checks.
 *
 * @param input - Raw token, candidate record, required scope, hash secret, and
 * optional current time override.
 * @returns Success with the record, or a stable rejection reason.
 * @throws When `hashSecret` is empty.
 *
 * @example
 * ```ts
 * const result = verifyPersonalAccessToken({
 * 	rawToken,
 * 	record,
 * 	requiredScope: ANALYTICS_READ_SCOPE,
 * 	hashSecret: env.PERSONAL_ACCESS_TOKEN_SECRET,
 * })
 * if (!result.ok) return unauthorized(result.reason)
 * ```
 */
export function verifyPersonalAccessToken(input: {
	rawToken: string
	record: PersonalAccessTokenRecord | null | undefined
	requiredScope: PersonalAccessTokenScope
	hashSecret: string
	now?: Date
}): VerifyPersonalAccessTokenResult {
	const parsed = parsePersonalAccessToken(input.rawToken)

	if (!parsed || !input.record) {
		return { ok: false, reason: 'malformed' }
	}

	if (parsed.publicId !== input.record.publicId) {
		return { ok: false, reason: 'mismatched-id' }
	}

	if (input.record.revokedAt) {
		return { ok: false, reason: 'revoked' }
	}

	const now = input.now ?? new Date()
	if (input.record.expiresAt && input.record.expiresAt <= now) {
		return { ok: false, reason: 'expired' }
	}

	if (!input.record.scopes.includes(input.requiredScope)) {
		return { ok: false, reason: 'missing-scope' }
	}

	const tokenHash = hashPersonalAccessTokenSecret(
		parsed.secret,
		input.hashSecret,
	)

	if (!safeEqual(tokenHash, input.record.tokenHash)) {
		return { ok: false, reason: 'wrong-hash' }
	}

	return { ok: true, record: input.record }
}

function buildTokenPrefix(publicId: string) {
	return `${PERSONAL_ACCESS_TOKEN_PREFIX}_${publicId}`
}

function randomTokenPart(bytes: number) {
	return randomBytes(bytes).toString('hex')
}

function isTokenPart(value: string | undefined): value is string {
	return Boolean(value && /^[A-Za-z0-9-]+$/.test(value))
}

function safeEqual(left: string, right: string) {
	const leftDigest = createHash('sha256').update(left).digest()
	const rightDigest = createHash('sha256').update(right).digest()
	return timingSafeEqual(leftDigest, rightDigest)
}
