import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db'
import { deviceAccessToken } from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'

const TTL_HOURS = 90 * 24
const TTL_LABEL = '90 days'
const TTL_MS = TTL_HOURS * 60 * 60 * 1000
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' }

function response(body: unknown, status = 200) {
	return NextResponse.json(body, {
		status,
		headers: NO_STORE_HEADERS,
	})
}

export async function POST(_request: NextRequest) {
	try {
		const { ability, session } = await getServerAuthSession()

		if (
			!session?.user?.id ||
			(ability.cannot('manage', 'all') && ability.cannot('view', 'Analytics'))
		) {
			return response({ error: 'Unauthorized' }, 401)
		}

		const userId = session.user.id
		const token = randomUUID()
		const expiresAt = new Date(Date.now() + TTL_MS)

		try {
			await db.insert(deviceAccessToken).values({
				token,
				userId,
				scope: 'analytics:read',
				expiresAt,
				revokedAt: null,
			})
		} catch {
			void log.error('api.analytics.token-generation-failed', {
				userId,
				phase: 'persist',
				errorKind: 'database-error',
			})
			return response({ error: 'Unable to generate analytics token' }, 500)
		}

		void log.info('api.analytics.token-generated', {
			userId,
			email: (session.user as any)?.email ?? null,
			ttlHours: TTL_HOURS,
		})

		return response({
			token,
			ttl: `${TTL_HOURS}h`,
			ttlLabel: TTL_LABEL,
			expiresAt: expiresAt.toISOString(),
		})
	} catch {
		void log.error('api.analytics.token-generation-failed', {
			phase: 'request',
			errorKind: 'unexpected-error',
		})
		return response({ error: 'Unable to generate analytics token' }, 500)
	}
}
