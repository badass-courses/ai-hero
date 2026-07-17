import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/db'
import { personalAccessToken } from '@/db/schema'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { and, eq } from 'drizzle-orm'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
	return NextResponse.json({}, { headers: corsHeaders })
}

const revokePersonalAccessTokenHandler = async (
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) => {
	const { id } = await params

	try {
		const { ability, user } = await getUserAbilityForRequest(request)

		if (!user) {
			await log.warn('api.personal-access-tokens.access-denied', {
				action: 'revoke',
				outcome: 'unauthorized',
				tokenId: id,
			})
			return NextResponse.json(
				{ error: 'Unauthorized' },
				{ status: 401, headers: corsHeaders },
			)
		}

		if (!ability.can('manage', 'all')) {
			await log.warn('api.personal-access-tokens.access-denied', {
				action: 'revoke',
				outcome: 'forbidden',
				tokenId: id,
				userId: user.id,
			})
			return NextResponse.json(
				{ error: 'Forbidden: Admin access required' },
				{ status: 403, headers: corsHeaders },
			)
		}

		const token = await db.query.personalAccessToken.findFirst({
			where: and(
				eq(personalAccessToken.id, id),
				eq(personalAccessToken.userId, user.id),
			),
			columns: {
				id: true,
				name: true,
				publicId: true,
				tokenPrefix: true,
				scopes: true,
				createdAt: true,
				lastUsedAt: true,
				expiresAt: true,
				revokedAt: true,
			},
		})

		if (!token) {
			return NextResponse.json(
				{ error: 'Personal access token not found' },
				{ status: 404, headers: corsHeaders },
			)
		}

		const alreadyRevoked = token.revokedAt !== null
		const revokedAt = token.revokedAt ?? new Date()

		if (!alreadyRevoked) {
			await db
				.update(personalAccessToken)
				.set({ revokedAt, updatedAt: revokedAt })
				.where(
					and(
						eq(personalAccessToken.id, token.id),
						eq(personalAccessToken.userId, user.id),
					),
				)
		}

		await log.info('api.personal-access-tokens.revoked', {
			userId: user.id,
			tokenId: token.id,
			publicIdPrefix: token.publicId.slice(0, 8),
			alreadyRevoked,
			revokedAt: revokedAt.toISOString(),
		})

		return NextResponse.json(
			{
				id: token.id,
				name: token.name,
				tokenPrefix: token.tokenPrefix,
				scopes: token.scopes,
				createdAt: token.createdAt ?? null,
				lastUsedAt: token.lastUsedAt ?? null,
				expiresAt: token.expiresAt,
				revokedAt,
			},
			{ headers: corsHeaders },
		)
	} catch (error) {
		await log.error('api.personal-access-tokens.revoke.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			tokenId: id,
		})
		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500, headers: corsHeaders },
		)
	}
}

export const DELETE = withSkill(revokePersonalAccessTokenHandler)
