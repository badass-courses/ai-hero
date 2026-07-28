import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db'
import { personalAccessToken } from '@/db/schema'
import { env } from '@/env.mjs'
import {
	createPersonalAccessToken,
	type PersonalAccessTokenScope,
} from '@/lib/personal-access-tokens'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const personalAccessTokenScopes = [
	'analytics:read',
	'analytics:chat',
	'content:read',
] as const satisfies readonly PersonalAccessTokenScope[]

const MintPersonalAccessTokenSchema = z.object({
	name: z.string().trim().min(1).max(100),
	scopes: z.array(z.enum(personalAccessTokenScopes)).min(1),
	expiresAt: z
		.string()
		.datetime({ offset: true })
		.transform((value) => new Date(value))
		.refine((value) => value > new Date(), {
			message: 'expiresAt must be in the future',
		})
		.optional(),
})

type PublicPersonalAccessToken = {
	id: string
	name: string
	tokenPrefix: string
	scopes: string[]
	createdAt?: Date | null
	lastUsedAt?: Date | null
	expiresAt: Date | null
	revokedAt: Date | null
}

export async function OPTIONS() {
	return NextResponse.json({}, { headers: corsHeaders })
}

const mintPersonalAccessTokenHandler = async (request: NextRequest) => {
	try {
		const { ability, user } = await getUserAbilityForRequest(request)

		if (!user) {
			await log.warn('api.personal-access-tokens.access-denied', {
				action: 'mint',
				outcome: 'unauthorized',
			})
			return NextResponse.json(
				{ error: 'Unauthorized', docs: '/api' },
				{ status: 401, headers: corsHeaders },
			)
		}

		if (!ability.can('manage', 'all')) {
			await log.warn('api.personal-access-tokens.access-denied', {
				action: 'mint',
				outcome: 'forbidden',
				userId: user.id,
			})
			return NextResponse.json(
				{ error: 'Forbidden: Admin access required', docs: '/api' },
				{ status: 403, headers: corsHeaders },
			)
		}

		const parsed = MintPersonalAccessTokenSchema.safeParse(await request.json())
		if (!parsed.success) {
			return NextResponse.json(
				{ error: 'Invalid input', details: parsed.error.format() },
				{ status: 400, headers: corsHeaders },
			)
		}

		const hashSecret = env.PERSONAL_ACCESS_TOKEN_SECRET
		if (!hashSecret) {
			await log.error('api.personal-access-tokens.mint.unconfigured', {
				userId: user.id,
			})
			return NextResponse.json(
				{ error: 'Personal access tokens are not configured' },
				{ status: 503, headers: corsHeaders },
			)
		}

		const { rawToken, record } = createPersonalAccessToken({
			userId: user.id,
			name: parsed.data.name,
			scopes: parsed.data.scopes,
			hashSecret,
			expiresAt: parsed.data.expiresAt,
		})

		await db.insert(personalAccessToken).values(record)

		await log.info('api.personal-access-tokens.minted', {
			userId: user.id,
			tokenId: record.id,
			publicIdPrefix: record.publicId.slice(0, 8),
			scopes: record.scopes,
			expiresAt: record.expiresAt?.toISOString() ?? null,
		})

		return NextResponse.json(
			{ token: rawToken, ...toPublicPersonalAccessToken(record) },
			{ status: 201, headers: corsHeaders },
		)
	} catch (error) {
		await log.error('api.personal-access-tokens.mint.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
		})
		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500, headers: corsHeaders },
		)
	}
}

export const POST = withSkill(mintPersonalAccessTokenHandler)

const listPersonalAccessTokensHandler = async (request: NextRequest) => {
	try {
		const { ability, user } = await getUserAbilityForRequest(request)

		if (!user) {
			await log.warn('api.personal-access-tokens.access-denied', {
				action: 'list',
				outcome: 'unauthorized',
			})
			return NextResponse.json(
				{ error: 'Unauthorized', docs: '/api' },
				{ status: 401, headers: corsHeaders },
			)
		}

		if (!ability.can('manage', 'all')) {
			await log.warn('api.personal-access-tokens.access-denied', {
				action: 'list',
				outcome: 'forbidden',
				userId: user.id,
			})
			return NextResponse.json(
				{ error: 'Forbidden: Admin access required', docs: '/api' },
				{ status: 403, headers: corsHeaders },
			)
		}

		const tokens = await db.query.personalAccessToken.findMany({
			where: eq(personalAccessToken.userId, user.id),
			columns: {
				id: true,
				name: true,
				tokenPrefix: true,
				scopes: true,
				createdAt: true,
				lastUsedAt: true,
				expiresAt: true,
				revokedAt: true,
			},
			orderBy: desc(personalAccessToken.createdAt),
		})

		return NextResponse.json(tokens.map(toPublicPersonalAccessToken), {
			headers: corsHeaders,
		})
	} catch (error) {
		await log.error('api.personal-access-tokens.list.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
		})
		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500, headers: corsHeaders },
		)
	}
}

export const GET = withSkill(listPersonalAccessTokensHandler)

function toPublicPersonalAccessToken(record: PublicPersonalAccessToken) {
	return {
		id: record.id,
		name: record.name,
		tokenPrefix: record.tokenPrefix,
		scopes: record.scopes,
		createdAt: record.createdAt ?? null,
		lastUsedAt: record.lastUsedAt ?? null,
		expiresAt: record.expiresAt,
		revokedAt: record.revokedAt,
	}
}
