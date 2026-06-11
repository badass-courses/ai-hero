import { NextRequest } from 'next/server'
import { getAbility, UserSchema } from '@/ability'
import { db } from '@/db'
import { deviceAccessToken } from '@/db/schema'
import { log } from '@/server/logger'
import { eq } from 'drizzle-orm'

/** Analytics device tokens are valid for 90 days from creation. */
const TOKEN_TTL_HOURS = 90 * 24

export async function getUserAbilityForRequest(request: NextRequest) {
	const authToken = request.headers.get('Authorization')?.split(' ')[1]

	if (!authToken) {
		return { user: null, ability: getAbility() }
	}

	const deviceToken = await db.query.deviceAccessToken.findFirst({
		where: eq(deviceAccessToken.token, authToken),
		with: {
			verifiedBy: {
				with: {
					roles: {
						with: {
							role: true,
						},
					},
				},
			},
		},
	})

	if (!deviceToken) {
		return { user: null, ability: getAbility() }
	}

	// Enforce token TTL based on createdAt timestamp
	if (deviceToken.createdAt) {
		const ageMs = Date.now() - deviceToken.createdAt.getTime()
		const ttlMs = TOKEN_TTL_HOURS * 60 * 60 * 1000
		if (ageMs > ttlMs) {
			void log.warn('auth.token-expired', {
				token: authToken.slice(0, 8) + '…',
				ageHours: Math.round(ageMs / 3_600_000),
				ttlHours: TOKEN_TTL_HOURS,
			})
			return { user: null, ability: getAbility() }
		}
	}

	const userParsed = UserSchema.safeParse({
		...deviceToken.verifiedBy,
		roles: deviceToken.verifiedBy.roles.map((role) => role.role),
	})

	if (!userParsed.success) {
		await log.error('auth.ability.parse-failed', {
			error: JSON.stringify(userParsed.error.format()),
		})

		return { user: null, ability: getAbility() }
	}

	const user = userParsed.data
	const ability = getAbility({ user })

	void log.info('auth.user-authenticated', {
		userId: user.id,
		email: user.email ?? null,
		role: user.roles?.map((r) => r.name).join(',') ?? null,
	})

	return { user, ability }
}
