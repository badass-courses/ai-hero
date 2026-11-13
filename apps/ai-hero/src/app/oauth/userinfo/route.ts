import { NextResponse } from 'next/server'
import { db } from '@/db'
import { deviceAccessToken as deviceAccessTokenTable } from '@/db/schema'
import { LEARNER_READ_SCOPE } from '@/lib/learner-agent/identity'
import { clientNamesFor } from '@/lib/learner-agent/oauth/client-name'
import {
	isDeviceAccessTokenActive,
	DEVICE_LOGIN_EXPIRED_MESSAGE,
} from '@/server/device-access-token'
import {
	DEVICE_ADMIN_SCOPE,
	DEVICE_CLI_CLIENT,
	deviceOwnerAbility,
} from '@/server/device-token-grant'
import { eq } from 'drizzle-orm'

import { getUser } from './get-user'

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' }

function json(body: unknown, status = 200) {
	return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

export async function GET(request: Request) {
	const [scheme, bearer] =
		request.headers.get('Authorization')?.trim().split(/\s+/) ?? []
	const denied = () =>
		json(
			{
				error: 'access_denied',
				error_description: DEVICE_LOGIN_EXPIRED_MESSAGE,
			},
			401,
		)
	if (scheme?.toLowerCase() !== 'bearer' || !bearer) return denied()
	const token = await db.query.deviceAccessToken.findFirst({
		where: eq(deviceAccessTokenTable.token, bearer),
	})
	if (!token?.userId || !isDeviceAccessTokenActive(token)) return denied()
	if (token.scope === DEVICE_ADMIN_SCOPE) {
		const names = await clientNamesFor(token.userId, [bearer])
		const ability = await deviceOwnerAbility(token.userId)
		if (
			names.get(bearer) !== DEVICE_CLI_CLIENT ||
			!ability?.can('manage', 'all')
		)
			return denied()
	} else if (token.scope !== LEARNER_READ_SCOPE) return denied()
	const user = await getUser(token.userId)
	if (!user) return denied()
	// Identity only, never a database row or role-bearing user record.
	return json({ id: user.id, name: user.name, email: user.email })
}
