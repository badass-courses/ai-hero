import { NextRequest } from 'next/server'
import { getAbility, UserSchema, type AppAbility, type User } from '@/ability'
import { db } from '@/db'
import { deviceAccessToken, personalAccessToken } from '@/db/schema'
import { env } from '@/env.mjs'
import {
	parsePersonalAccessToken,
	PERSONAL_ACCESS_TOKEN_PREFIX,
	verifyPersonalAccessToken,
} from '@/lib/personal-access-tokens'
import { log } from '@/server/logger'
import {
	buildPersonalAccessTokenAbility,
	CONTENT_READ_SCOPE,
} from '@/server/pat-scopes'
import { eq } from 'drizzle-orm'

/** Analytics device tokens are valid for 90 days from creation. */
const TOKEN_TTL_HOURS = 90 * 24

export type RequestAuthMethod =
	| 'device-token'
	| 'personal-access-token'
	| 'anonymous'

export type RequestAuth = {
	user: User | null
	ability: AppAbility
	authMethod: RequestAuthMethod
}

export async function getUserAbilityForRequest(
	request: NextRequest,
): Promise<RequestAuth> {
	const [authScheme, authToken] =
		request.headers.get('Authorization')?.trim().split(/\s+/) ?? []

	if (!authToken) {
		return anonymousAuth()
	}

	if (authToken.startsWith(`${PERSONAL_ACCESS_TOKEN_PREFIX}_`)) {
		if (authScheme?.toLowerCase() !== 'bearer') {
			const parsedToken = parsePersonalAccessToken(authToken)
			await logPersonalAccessTokenVerification({
				publicIdPrefix: parsedToken?.publicId.slice(0, 8) ?? 'unknown',
				scopes: [],
				outcome: 'denied:invalid-scheme',
			})
			return anonymousAuth()
		}
		return authenticatePersonalAccessToken(authToken)
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
		return anonymousAuth()
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
			return anonymousAuth()
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

		return anonymousAuth()
	}

	const user = userParsed.data
	const ability = getAbility({ user })

	void log.info('auth.user-authenticated', {
		userId: user.id,
		email: user.email ?? null,
		role: user.roles?.map((r) => r.name).join(',') ?? null,
	})

	return { user, ability, authMethod: 'device-token' }
}

async function authenticatePersonalAccessToken(
	rawToken: string,
): Promise<RequestAuth> {
	const parsedToken = parsePersonalAccessToken(rawToken)
	const publicIdPrefix = parsedToken?.publicId.slice(0, 8) ?? 'unknown'

	if (!parsedToken) {
		await logPersonalAccessTokenVerification({
			publicIdPrefix,
			scopes: [],
			outcome: 'denied:malformed',
		})
		return anonymousAuth()
	}

	const token = await db.query.personalAccessToken.findFirst({
		where: eq(personalAccessToken.publicId, parsedToken.publicId),
		with: {
			user: {
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
	const scopes = token?.scopes ?? []
	const hashSecret = env.PERSONAL_ACCESS_TOKEN_SECRET

	if (!hashSecret) {
		await logPersonalAccessTokenVerification({
			publicIdPrefix,
			scopes,
			outcome: 'denied:missing-secret',
		})
		return anonymousAuth()
	}

	const verification = verifyPersonalAccessToken({
		rawToken,
		record: token,
		requiredScope: CONTENT_READ_SCOPE,
		hashSecret,
	})

	if (!verification.ok) {
		await logPersonalAccessTokenVerification({
			publicIdPrefix,
			scopes,
			outcome: `denied:${verification.reason}`,
		})
		return anonymousAuth()
	}

	const userParsed = UserSchema.safeParse({
		...token?.user,
		roles: token?.user.roles.map((role) => role.role),
	})

	if (!userParsed.success) {
		await logPersonalAccessTokenVerification({
			publicIdPrefix,
			scopes,
			outcome: 'denied:invalid-user',
		})
		return anonymousAuth()
	}

	void stampPersonalAccessTokenLastUsed(verification.record.id)
	await logPersonalAccessTokenVerification({
		publicIdPrefix,
		scopes,
		outcome: 'accepted',
	})

	return {
		user: userParsed.data,
		ability: buildPersonalAccessTokenAbility(scopes),
		authMethod: 'personal-access-token',
	}
}

function anonymousAuth(): RequestAuth {
	return {
		user: null,
		ability: getAbility(),
		authMethod: 'anonymous',
	}
}

async function stampPersonalAccessTokenLastUsed(id: string) {
	try {
		await db
			.update(personalAccessToken)
			.set({ lastUsedAt: new Date() })
			.where(eq(personalAccessToken.id, id))
	} catch (error) {
		await log.error('auth.personal-access-token.last-used.failed', {
			tokenKind: 'personal-access-token',
			error: error instanceof Error ? error.message : 'Unknown error',
		})
	}
}

async function logPersonalAccessTokenVerification({
	publicIdPrefix,
	scopes,
	outcome,
}: {
	publicIdPrefix: string
	scopes: string[]
	outcome: `denied:${string}` | 'accepted'
}) {
	const data = {
		tokenKind: 'personal-access-token',
		publicIdPrefix: publicIdPrefix.slice(0, 8),
		scopes,
		outcome,
	}

	if (outcome === 'accepted') {
		await log.info('auth.personal-access-token.verify', data)
		return
	}

	await log.warn('auth.personal-access-token.verify', data)
}
