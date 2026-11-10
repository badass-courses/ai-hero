import { db } from '@/db'
import { deviceAccessToken } from '@/db/schema'
import {
	LEARNER_READ_SCOPE,
	learnerTokenId,
} from '@/lib/learner-agent/identity'
import {
	corsPreflight,
	OAUTH_NO_STORE_HEADERS,
} from '@/lib/learner-agent/oauth/metadata'
import { log } from '@/server/logger'
import { and, eq, isNull } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

const done = () =>
	new Response(null, { status: 200, headers: OAUTH_NO_STORE_HEADERS })

/**
 * RFC 7009 token revocation, so a client can sign out. Holding the token is
 * the proof. It only ever revokes `learner:read` rows; any other token, or
 * none, still answers 200, so the endpoint tells a caller nothing.
 */
export async function POST(request: Request) {
	const form = await request.formData().catch(() => null)
	const token = form?.get('token')
	if (typeof token !== 'string' || !token || token.length > 255) return done()

	const row = await db.query.deviceAccessToken.findFirst({
		where: eq(deviceAccessToken.token, token),
		columns: { userId: true, scope: true, revokedAt: true },
	})
	if (!row || row.scope !== LEARNER_READ_SCOPE || row.revokedAt) return done()

	await db
		.update(deviceAccessToken)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(deviceAccessToken.token, token),
				eq(deviceAccessToken.scope, LEARNER_READ_SCOPE),
				isNull(deviceAccessToken.revokedAt),
			),
		)
	void log.info('learner_agent.oauth', {
		outcome: 'token_revoked',
		userId: row.userId,
		tokenId: learnerTokenId(token),
	})
	return done()
}

export const OPTIONS = corsPreflight
