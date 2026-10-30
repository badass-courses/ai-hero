import { randomUUID } from 'node:crypto'
import { db } from '@/db'
import { deviceAccessToken } from '@/db/schema'
import { log } from '@/server/logger'
import { and, eq, isNull } from 'drizzle-orm'

import {
	LEARNER_READ_SCOPE,
	LEARNER_TOKEN_TTL_MS,
	learnerTokenId,
} from '../identity'
import { requestIp } from '../rate-limit'
import { isLearnerResource } from './authorize'
import { recordClientName } from './client-name'
import {
	claimCodeOnce,
	openAuthorizationCode,
	pkceMatches,
	recordCodeToken,
	tokenIdForCode,
} from './codes'
import {
	LEARNER_TOKEN_TTL_SECONDS,
	learnerOAuthUrls,
	oauthError,
	oauthJson,
} from './metadata'
import { oauthRateLimit } from './rate-limit'

const field = (form: FormData, name: string) => {
	const value = form.get(name)
	return typeof value === 'string' && value ? value : null
}

/** A replayed code revokes the token it minted (OAuth 2.1 §4.1.3). */
async function revokeTokenFromCode(userId: string, jti: string) {
	const tokenId = await tokenIdForCode(jti)
	if (!tokenId) return
	const rows = await db.query.deviceAccessToken.findMany({
		where: and(
			eq(deviceAccessToken.userId, userId),
			eq(deviceAccessToken.scope, LEARNER_READ_SCOPE),
			isNull(deviceAccessToken.revokedAt),
		),
		columns: { token: true },
	})
	const match = rows.find((row) => learnerTokenId(row.token) === tokenId)
	if (!match) return
	await db
		.update(deviceAccessToken)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(deviceAccessToken.token, match.token),
				eq(deviceAccessToken.userId, userId),
			),
		)
	void log.warn('learner_agent.oauth', {
		outcome: 'code_replay_revoked',
		userId,
		tokenId,
	})
}

/**
 * `grant_type=authorization_code`: trades a sealed, single-use code and its
 * PKCE verifier for a `learner:read` token, the same row the token button
 * mints. Every check runs before the code is claimed, so a bad attempt
 * cannot burn a code the real client still holds.
 */
export async function exchangeAuthorizationCode(
	form: FormData,
	request: Request,
): Promise<Response> {
	if (!(await oauthRateLimit('token', requestIp(request))))
		return oauthError(
			'slow_down',
			'Too many requests. Try again in a minute.',
			429,
		)

	const urls = learnerOAuthUrls()
	const code = openAuthorizationCode(field(form, 'code'))
	if (!code) {
		void log.warn('learner_agent.oauth', { outcome: 'denied:bad_code' })
		return oauthError('invalid_grant', 'The code is invalid or expired.')
	}
	const deny = (outcome: string, error: string, description: string) => {
		void log.warn('learner_agent.oauth', {
			outcome: `denied:${outcome}`,
			userId: code.userId,
			clientHost: code.clientHost,
		})
		return oauthError(error, description)
	}

	if (!code.matchesClient(field(form, 'client_id')))
		return deny(
			'client_mismatch',
			'invalid_grant',
			'The code was issued to another client.',
		)
	if (field(form, 'redirect_uri') !== code.redirectUri)
		return deny(
			'redirect_mismatch',
			'invalid_grant',
			'redirect_uri does not match the authorization request.',
		)
	if (!pkceMatches(field(form, 'code_verifier'), code.codeChallenge))
		return deny(
			'pkce_mismatch',
			'invalid_grant',
			'The PKCE code_verifier does not match.',
		)
	const resource = field(form, 'resource')
	if (resource !== null && !isLearnerResource(resource, urls))
		return deny(
			'wrong_resource',
			'invalid_target',
			`The only resource is ${urls.resource}.`,
		)

	const claim = await claimCodeOnce(code.jti)
	if (claim === 'unavailable') {
		void log.error('learner_agent.oauth', {
			outcome: 'code_claim_unavailable',
			userId: code.userId,
			clientHost: code.clientHost,
		})
		return oauthError('temporarily_unavailable', 'Try again in a moment.', 503)
	}
	if (claim === 'reused') {
		await revokeTokenFromCode(code.userId, code.jti).catch(() => undefined)
		return deny('code_reused', 'invalid_grant', 'The code was already used.')
	}

	const token = randomUUID()
	try {
		await db.insert(deviceAccessToken).values({
			token,
			userId: code.userId,
			scope: LEARNER_READ_SCOPE,
			expiresAt: new Date(Date.now() + LEARNER_TOKEN_TTL_MS),
			revokedAt: null,
		})
	} catch {
		void log.error('learner_agent.oauth', {
			outcome: 'token_insert_failed',
			userId: code.userId,
			clientHost: code.clientHost,
		})
		return oauthError(
			'server_error',
			'Could not issue a token. Sign in again.',
			500,
		)
	}
	const tokenId = learnerTokenId(token)
	await recordCodeToken(code.jti, tokenId)
	await recordClientName(token, code.clientName)

	void log.info('learner_agent.oauth', {
		outcome: 'token_issued',
		userId: code.userId,
		clientHost: code.clientHost,
		tokenId,
	})
	return oauthJson({
		access_token: token,
		token_type: 'Bearer',
		expires_in: LEARNER_TOKEN_TTL_SECONDS,
		scope: LEARNER_READ_SCOPE,
	})
}
