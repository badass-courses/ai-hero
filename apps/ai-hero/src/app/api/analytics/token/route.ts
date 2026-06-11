import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db'
import { deviceAccessToken } from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { and, eq, lt } from 'drizzle-orm'

const TTL_HOURS = 90 * 24
const TTL_LABEL = '90 days'

export async function POST(request: NextRequest) {
	const { ability, session } = await getServerAuthSession()

	if (
		!session?.user?.id ||
		(ability.cannot('manage', 'all') && ability.cannot('view', 'Analytics'))
	) {
		return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
	}

	const userId = session.user.id
	const token = randomUUID()

	// Clean up any expired agent tokens for this user (best-effort)
	// Agent tokens are identified by having been created by this endpoint
	// We can't distinguish them from device-flow tokens without a field,
	// so we just create the new one and let the old ones age out.

	await db.insert(deviceAccessToken).values({
		token,
		userId,
	})

	void log.info('api.analytics.token-generated', {
		userId,
		email: (session.user as any)?.email ?? null,
		ttlHours: TTL_HOURS,
	})

	return NextResponse.json({
		token,
		ttl: `${TTL_HOURS}h`,
		ttlLabel: TTL_LABEL,
		expiresAt: new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000).toISOString(),
	})
}
