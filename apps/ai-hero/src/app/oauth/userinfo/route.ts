import { NextResponse } from 'next/server'
import { db } from '@/db'
import { deviceAccessToken as deviceAccessTokenTable } from '@/db/schema'
import { isDeviceAccessTokenActive } from '@/server/device-access-token'
import { eq } from 'drizzle-orm'

import { getUser } from './get-user'

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' }

function json(body: unknown, status = 200) {
	return NextResponse.json(body, {
		status,
		headers: NO_STORE_HEADERS,
	})
}

export async function GET(request: Request) {
	const [authScheme, deviceAccessToken] =
		request.headers.get('Authorization')?.trim().split(/\s+/) ?? []

	if (deviceAccessToken) {
		const token = await db.query.deviceAccessToken.findFirst({
			where: eq(deviceAccessTokenTable.token, deviceAccessToken),
		})
		if (
			token?.userId &&
			(!token.scope ||
				token.scope === 'analytics:read') &&
			(!token.scope || authScheme?.toLowerCase() === 'bearer') &&
			isDeviceAccessTokenActive(token)
		) {
			const user = await getUser(token.userId)

			return json({ ...user })
		} else {
			return json(
				{
					error: 'not_found',
					error_description: 'User not found.',
				},
				404,
			)
		}
	} else {
		return json(
			{
				error: 'access_denied',
				error_description: 'Nothing to see here.',
			},
			403,
		)
	}
}
