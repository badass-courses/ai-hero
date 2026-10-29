import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { deviceAccessToken } from '@/db/schema'
import {
	LEARNER_READ_SCOPE,
	LEARNER_TOKEN_TTL_MS,
	learnerTokenId,
} from '@/lib/learner-agent/identity'
import { learnerSiteUrls } from '@/lib/learner-agent/site'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

const respond = (body: unknown, status = 200) =>
	NextResponse.json(body, { status, headers: NO_STORE })

async function signedInUserId() {
	const { session } = await getServerAuthSession()
	return session?.user?.id ?? null
}

const unauthorized = () =>
	respond(
		{ ok: false, error: 'Sign in to aihero.dev to manage agent tokens.' },
		401,
	)

/** Mints a `learner:read` token for the signed-in learner, shown once. */
export async function POST() {
	const userId = await signedInUserId()
	if (!userId) return unauthorized()

	const token = randomUUID()
	const expiresAt = new Date(Date.now() + LEARNER_TOKEN_TTL_MS)
	try {
		await db.insert(deviceAccessToken).values({
			token,
			userId,
			scope: LEARNER_READ_SCOPE,
			expiresAt,
			revokedAt: null,
		})
	} catch {
		void log.error('learner_agent.token.mint_failed', { userId })
		return respond(
			{ ok: false, error: 'Could not create a token. Try again.' },
			500,
		)
	}

	void log.info('learner_agent.token.minted', {
		userId,
		tokenId: learnerTokenId(token),
	})
	const site = learnerSiteUrls()
	return respond({
		ok: true,
		token,
		id: learnerTokenId(token),
		scope: LEARNER_READ_SCOPE,
		expiresAt: expiresAt.toISOString(),
		mcpUrl: site.mcpUrl,
		next_actions: [
			{
				description:
					'Give your agent this token as `Authorization: Bearer <token>` and point it at the MCP URL.',
				href: site.mcpUrl,
			},
		],
	})
}

/** Lists the signed-in learner's agent tokens, without the tokens. */
export async function GET() {
	const userId = await signedInUserId()
	if (!userId) return unauthorized()

	const rows = await db.query.deviceAccessToken.findMany({
		where: and(
			eq(deviceAccessToken.userId, userId),
			eq(deviceAccessToken.scope, LEARNER_READ_SCOPE),
		),
		columns: {
			token: true,
			scope: true,
			createdAt: true,
			expiresAt: true,
			revokedAt: true,
		},
	})

	return respond({
		ok: true,
		tokens: rows.map((row) => ({
			id: learnerTokenId(row.token),
			scope: row.scope,
			createdAt: row.createdAt?.toISOString() ?? null,
			expiresAt: row.expiresAt?.toISOString() ?? null,
			revokedAt: row.revokedAt?.toISOString() ?? null,
		})),
	})
}

const RevokeSchema = z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) })

/** Revokes one of the signed-in learner's agent tokens by its listed id. */
export async function DELETE(request: Request) {
	const userId = await signedInUserId()
	if (!userId) return unauthorized()

	const parsed = RevokeSchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success)
		return respond({ ok: false, error: 'Send { "id": "<token id>" }.' }, 400)

	const rows = await db.query.deviceAccessToken.findMany({
		where: and(
			eq(deviceAccessToken.userId, userId),
			eq(deviceAccessToken.scope, LEARNER_READ_SCOPE),
			isNull(deviceAccessToken.revokedAt),
		),
		columns: { token: true },
	})
	const match = rows.find((row) => learnerTokenId(row.token) === parsed.data.id)
	if (!match)
		return respond({ ok: false, error: 'No active token with that id.' }, 404)

	await db
		.update(deviceAccessToken)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(deviceAccessToken.token, match.token),
				eq(deviceAccessToken.userId, userId),
			),
		)

	void log.info('learner_agent.token.revoked', {
		userId,
		tokenId: parsed.data.id,
	})
	return respond({ ok: true, id: parsed.data.id })
}
