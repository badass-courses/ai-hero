import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db'
import { env } from '@/env.mjs'
import { isSyntheticPrincipalId } from '@/lib/synthetic-principal'
import {
	problem,
	testPrincipalAuthProblem,
} from '@/lib/test-principals/test-principal-http'
import { deleteTestPrincipalRecords } from '@/lib/test-principals/test-principal-store'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

/**
 * DELETE /api/drovr/test-principals/{principalId} removes the principal and
 * everything keyed to it. Idempotent: an absent principal answers 204. A
 * non-synthetic id is refused before any read, so it can never touch a
 * real user.
 */
export const DELETE = withSkill(
	async (
		request: NextRequest,
		context: { params: Promise<{ principalId: string }> },
	) => {
		const refused = testPrincipalAuthProblem(
			request.headers.get('authorization'),
			env.AIHERO_TEST_PRINCIPAL_TOKEN,
		)
		if (refused) return refused
		const { principalId } = await context.params
		if (!isSyntheticPrincipalId(principalId)) {
			return problem(
				400,
				'not-a-test-principal',
				'Not a test principal',
				'Only synthetic_ principals can be deleted here.',
				'Use the principalId returned by POST /api/drovr/test-principals.',
			)
		}
		const deleted = await deleteTestPrincipalRecords(db, principalId)
		if (!deleted) return new NextResponse(null, { status: 204 })
		await log.info('drovr.test_principal.deleted', {
			principalId,
			removed: deleted.removed,
			absentTables: deleted.absentTables,
			trigger: 'request',
		})
		return NextResponse.json({
			principalId,
			removed: deleted.removed,
			absentTables: deleted.absentTables,
		})
	},
)
