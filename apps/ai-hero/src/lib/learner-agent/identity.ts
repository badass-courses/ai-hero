import { createHash } from 'crypto'
import { db } from '@/db'
import { deviceAccessToken } from '@/db/schema'
import { PERSONAL_ACCESS_TOKEN_PREFIX } from '@/lib/personal-access-tokens'
import { isDeviceAccessTokenActive } from '@/server/device-access-token'
import { log } from '@/server/logger'
import { eq } from 'drizzle-orm'

import type { Learner } from '@ai-hero/learner-agent'

/** The scope a learner agent token carries. */
export const LEARNER_READ_SCOPE = 'learner:read'

/** Learner tokens live 90 days, like analytics tokens. */
export const LEARNER_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000

/**
 * The listed id of a token. The table keys rows by the raw token, which is
 * a credential and never leaves the server; a short hash names it instead.
 */
export const learnerTokenId = (token: string) =>
	createHash('sha256').update(token).digest('hex').slice(0, 16)

export type LearnerTokenRow = {
	userId: string
	scope: string | null
	createdAt?: Date | null
	expiresAt?: Date | null
	revokedAt?: Date | null
}

/**
 * Which device tokens may act as a learner. A `learner:read` token is made
 * for this; an unscoped device token (the CLI login) already carries the
 * owner's full ability, so reading as that learner is narrower than what it
 * holds. Every other scope (`analytics:read`) and every PAT is refused: those
 * were minted for something else.
 */
export function learnerFromToken(
	row: LearnerTokenRow,
	now = Date.now(),
): Learner | null {
	if (!isDeviceAccessTokenActive(row, now)) return null
	const scopes = (row.scope ?? '').split(/\s+/).filter(Boolean)
	if (scopes.length === 0)
		return { userId: row.userId, tokenKind: 'device-token' }
	if (scopes.includes(LEARNER_READ_SCOPE)) {
		return { userId: row.userId, tokenKind: 'learner-token' }
	}
	return null
}

/**
 * The learner a request speaks for, from its bearer token. Only the user id
 * comes back: roles are never read here, so no token can carry admin rules
 * into the learner surface.
 */
export async function resolveLearner(
	request: Request,
): Promise<Learner | null> {
	const [scheme, token] =
		request.headers.get('authorization')?.trim().split(/\s+/) ?? []
	if (!token || scheme?.toLowerCase() !== 'bearer') return null

	if (token.startsWith(`${PERSONAL_ACCESS_TOKEN_PREFIX}_`)) {
		void log.warn('learner_agent.auth', {
			outcome: 'denied:pat',
			tokenKind: 'personal-access-token',
		})
		return null
	}

	const row = await db.query.deviceAccessToken.findFirst({
		where: eq(deviceAccessToken.token, token),
		columns: {
			userId: true,
			scope: true,
			createdAt: true,
			expiresAt: true,
			revokedAt: true,
		},
	})
	if (!row) {
		void log.warn('learner_agent.auth', { outcome: 'denied:unknown-token' })
		return null
	}

	const learner = learnerFromToken(row)
	if (!learner) {
		void log.warn('learner_agent.auth', {
			outcome: 'denied:scope-or-inactive',
			userId: row.userId,
			scope: row.scope ?? null,
		})
		return null
	}

	void log.info('learner_agent.auth', {
		outcome: 'accepted',
		userId: learner.userId,
		tokenKind: learner.tokenKind,
	})
	return learner
}
