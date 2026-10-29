import { NextResponse } from 'next/server'
import { getUser } from '@/app/oauth/userinfo/get-user'
import { db } from '@/db'
import { deviceAccessToken, deviceVerifications } from '@/db/schema'
import {
	LEARNER_READ_SCOPE,
	LEARNER_TOKEN_TTL_MS,
} from '@/lib/learner-agent/identity'
import { eq } from 'drizzle-orm'

/**
 * Scopes a client may narrow a device token to at exchange. Narrowing only:
 * without `scope` the token keeps today's full owner ability.
 */
const NARROWING_SCOPES = new Set([LEARNER_READ_SCOPE])

export async function POST(request: Request) {
	const formData = await request.formData()
	const device_code = formData.get('device_code')
	const requestedScope = formData.get('scope')
	// A scope is a set: dedupe and sort, so the stored string is canonical and
	// `/api/learner/token` finds the token by exact match.
	const scope =
		typeof requestedScope === 'string' && requestedScope.trim()
			? [...new Set(requestedScope.trim().split(/\s+/))].sort()
			: null

	if (scope && !scope.every((entry) => NARROWING_SCOPES.has(entry))) {
		return NextResponse.json(
			{
				error: 'invalid_scope',
				error_description: `Supported scopes: ${[...NARROWING_SCOPES].join(' ')}`,
			},
			{ status: 400 },
		)
	}

	const deviceVerification = await db.query.deviceVerifications.findFirst({
		where: eq(deviceVerifications.deviceCode, device_code as string),
	})

	if (deviceVerification) {
		if (
			!deviceVerification.verifiedAt &&
			new Date() > deviceVerification.expires
		) {
			return NextResponse.json(
				{
					error: 'expired_token',
					error_description: 'The device verification has expired',
				},
				{ status: 403 },
			)
		}

		if (!deviceVerification.verifiedAt) {
			return NextResponse.json(
				{
					error: 'authorization_pending',
					error_description: 'The device verification is pending',
				},
				{ status: 403 },
			)
		}

		const user = await getUser(deviceVerification.verifiedByUserId)

		if (user) {
			const newToken = crypto.randomUUID()
			await db.insert(deviceAccessToken).values({
				userId: user.id,
				token: newToken,
				...(scope
					? {
							scope: scope.join(' '),
							expiresAt: new Date(Date.now() + LEARNER_TOKEN_TTL_MS),
						}
					: {}),
			})

			const deviceToken = await db.query.deviceAccessToken.findFirst({
				where: eq(deviceAccessToken.token, newToken),
			})

			await db
				.delete(deviceVerifications)
				.where(
					eq(deviceVerifications.deviceCode, deviceVerification.deviceCode),
				)

			if (!deviceToken) {
				return NextResponse.json(
					{
						error: 'access_denied',
						error_description: 'Device token not found',
					},
					{ status: 403 },
				)
			}

			return NextResponse.json({
				access_token: deviceToken.token,
				token_type: 'bearer',
				scope: scope ? scope.join(' ') : 'content:read progress',
			})
		} else {
			return NextResponse.json(
				{
					error: 'access_denied',
					error_description: 'User not found',
				},
				{ status: 403 },
			)
		}
	} else {
		return NextResponse.json(
			{
				error: 'access_denied',
				error_description: 'The device code is invalid',
			},
			{ status: 403 },
		)
	}
}
