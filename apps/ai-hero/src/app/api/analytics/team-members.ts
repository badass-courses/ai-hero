import { NextResponse } from 'next/server'
import { catalog } from '@/lib/analytics/catalog'
import { LearningTeamNotFoundError } from '@/lib/analytics/learning-teams-query'
import type { LearningTeamMembers } from '@/lib/analytics/learning-teams'
import { log } from '@/server/logger'

import {
	ANALYTICS_AGENT_INSTRUCTIONS,
	getRevenueSurfaceSchema,
} from './agent-contract'

/**
 * PII responses are private and uncached, and carry no CORS allowance, so
 * no shared cache or third-party page can hold learner emails.
 */
const PII_HEADERS = { 'Cache-Control': 'private, no-store' }

const surface = 'learning/team-members' as const

type ReadMembers = (
	teamId: string,
	options: { includeUserIds: true },
) => Promise<LearningTeamMembers>

/** Loaded on use, so the route module never pulls in the database client. */
const readMembers: ReadMembers = async (teamId, options) => {
	const { readLearningTeamMembersUncached } =
		await import('@/lib/analytics/providers/database')
	return readLearningTeamMembersUncached(teamId, options)
}

/**
 * learning/team-members: AI Hero admins only. Analytics-only roles see the
 * aggregate team surfaces but never member rows. Every attempt is logged
 * with the actor and team; member emails never reach the log.
 */
export async function learningTeamMembersResponse({
	isAdmin,
	actorId,
	authMethod,
	teamId,
	read = readMembers,
}: {
	isAdmin: boolean
	actorId: string | null
	authMethod: 'device_token' | 'session'
	teamId: string
	read?: ReadMembers
}) {
	if (!isAdmin) {
		await log.warn('api.analytics.team-members.denied', {
			actorId,
			authMethod,
			teamId,
		})
		return NextResponse.json(
			{
				ok: false,
				endpoint: '/api/analytics',
				surface,
				error: {
					message: 'learning/team-members is limited to AI Hero admins',
					code: 'ADMIN_REQUIRED',
				},
				fix: 'Use learning/team for the same team without member rows.',
				next_actions: [
					{
						command: `GET /api/analytics?surface=learning/team&teamId=${encodeURIComponent(teamId)}`,
						description: "The team's aggregate summary and funnel",
					},
				],
			},
			{ status: 403, headers: PII_HEADERS },
		)
	}
	try {
		const data = await read(teamId, { includeUserIds: true })
		await log.info('api.analytics.team-members.read', {
			actorId,
			authMethod,
			teamId: data.team.teamId,
			requestedTeamId: teamId,
			memberCount: data.members.length,
		})
		return NextResponse.json(
			{
				ok: true,
				endpoint: '/api/analytics',
				surface,
				pii: true,
				description: catalog[surface].description,
				agent_instructions: ANALYTICS_AGENT_INSTRUCTIONS,
				schema: getRevenueSurfaceSchema(surface),
				data,
			},
			{ headers: PII_HEADERS },
		)
	} catch (error) {
		const notFound = error instanceof LearningTeamNotFoundError
		await log[notFound ? 'warn' : 'error'](
			'api.analytics.team-members.failed',
			{
				actorId,
				authMethod,
				teamId,
				code: notFound ? 'TEAM_NOT_FOUND' : 'QUERY_FAILED',
				...(notFound ? {} : { error }),
			},
		)
		return NextResponse.json(
			{
				ok: false,
				endpoint: '/api/analytics',
				surface,
				error: notFound
					? {
							message: 'No active team purchase has that teamId.',
							code: 'TEAM_NOT_FOUND',
						}
					: { message: 'Could not read team members.', code: 'QUERY_FAILED' },
				fix: notFound
					? 'GET /api/analytics?surface=learning/teams lists team ids.'
					: 'Retry shortly.',
			},
			{ status: notFound ? 404 : 500, headers: PII_HEADERS },
		)
	}
}
