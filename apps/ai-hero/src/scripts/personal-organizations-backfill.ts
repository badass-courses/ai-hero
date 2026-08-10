/**
 * Stamps `personalOrganizationUserId` on legacy personal organizations and
 * their owner memberships.
 *
 * Core 2's adapter bridge created personal organizations without the durable
 * identity column; core 3 looks personal organizations up by that column and
 * nothing else, so every pre-core-3 user would get a duplicate organization
 * the first time an `ensurePersonalOrganization*` path runs for them. This
 * backfill closes that gap for existing rows.
 *
 * The `Personal (<email>)` name only nominates candidates. Identity is taken
 * from the owner membership: the single member holding an active `owner` role,
 * falling back to the sole member of a single-membership organization. A name
 * that no longer matches the member's current email is recorded but does not
 * block the stamp.
 *
 * Run order: after `pnpm db:push` has added the columns, before the core-3
 * app code deploys. Idempotent — stamped rows are filtered out on read and
 * guarded again on write.
 *
 * Usage (from `apps/ai-hero`):
 *   dotenv tsx src/scripts/personal-organizations-backfill.ts --dry-run
 *   dotenv tsx src/scripts/personal-organizations-backfill.ts --allow-write
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { db } from '@/db'
import { organization, organizationMemberships } from '@/db/schema'
import { log, serializeError } from '@/server/logger'
import { and, asc, eq, gt, inArray, isNotNull, isNull, like } from 'drizzle-orm'

import { getPersonalOrganizationName } from '@coursebuilder/organizations'

const DEFAULT_RECEIPT_DIRECTORY =
	'/Users/joel/Code/badass-courses/aihero-support/.brain/data/crm/receipts'

const PAGE_SIZE = 500

type Mode = 'dry-run' | 'allow-write'

type Candidate = {
	organizationId: string
	organizationName: string | null
	organizationCreatedAt: Date | null
	membershipId: string
	membershipAlreadyStamped: boolean
	userId: string
	resolvedByOwnerRole: boolean
	nameMatchesCurrentEmail: boolean
}

type AggregateReceipt = {
	version: 1
	task: 'personal-organization-durable-id-backfill'
	mode: Mode
	startedAt: string
	completedAt: string
	counts: {
		candidateOrganizations: number
		resolvedByOwnerRole: number
		resolvedBySoleMembership: number
		organizationsStampedOrPlanned: number
		membershipsStampedOrPlanned: number
		nameMismatchesStamped: number
		duplicateCandidatesSkipped: number
		unresolvedOrganizations: number
		writeErrors: number
	}
	writesPerformed: boolean
	unresolvedReasons: Record<string, number>
	notes: string[]
}

function parseArgs(argv: string[]): { mode: Mode; receiptPath: string } {
	const allowWrite = argv.includes('--allow-write')
	const dryRun = argv.includes('--dry-run')
	if (allowWrite && dryRun) {
		throw new Error('Choose either --dry-run or --allow-write, not both')
	}

	const mode: Mode = allowWrite ? 'allow-write' : 'dry-run'
	const receiptFlagIndex = argv.indexOf('--receipt')
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
	const receiptPath =
		receiptFlagIndex >= 0
			? argv[receiptFlagIndex + 1]
			: `${DEFAULT_RECEIPT_DIRECTORY}/personal-organization-backfill-${mode}-${timestamp}.json`

	if (!receiptPath || receiptPath.startsWith('--')) {
		throw new Error('--receipt requires a path')
	}

	// Fail before any database work when the receipt cannot land — the default
	// directory is the aihero-support receipts convention (as in
	// billing-admins-backfill.ts) and only exists on the operator's machine;
	// pass --receipt anywhere else.
	mkdirSync(dirname(receiptPath), { recursive: true })

	return { mode, receiptPath }
}

function incrementReason(reasons: Record<string, number>, reason: string) {
	reasons[reason] = (reasons[reason] ?? 0) + 1
}

type MembershipRow = {
	id: string
	organizationId: string | null
	userId: string
	personalOrganizationUserId: string | null
	user: { id: string; email: string | null } | null
	organizationMembershipRoles: {
		active: boolean
		deletedAt: Date | null
		role: { active: boolean; deletedAt: Date | null; name: string } | null
	}[]
}

function hasActiveOwnerRole(membership: MembershipRow): boolean {
	return membership.organizationMembershipRoles.some(
		(membershipRole) =>
			membershipRole.active &&
			!membershipRole.deletedAt &&
			membershipRole.role?.active &&
			!membershipRole.role.deletedAt &&
			membershipRole.role.name === 'owner',
	)
}

async function loadStampedUserIds(): Promise<{
	organizationUserIds: Set<string>
	membershipUserIds: Set<string>
}> {
	const stampedOrganizations = await db
		.select({ userId: organization.personalOrganizationUserId })
		.from(organization)
		.where(isNotNull(organization.personalOrganizationUserId))
	const stampedMemberships = await db
		.select({ userId: organizationMemberships.personalOrganizationUserId })
		.from(organizationMemberships)
		.where(isNotNull(organizationMemberships.personalOrganizationUserId))

	return {
		organizationUserIds: new Set(
			stampedOrganizations.flatMap((row) => (row.userId ? [row.userId] : [])),
		),
		membershipUserIds: new Set(
			stampedMemberships.flatMap((row) => (row.userId ? [row.userId] : [])),
		),
	}
}

async function collectCandidates(
	unresolvedReasons: Record<string, number>,
): Promise<{ candidates: Candidate[]; candidateOrganizations: number }> {
	const candidates: Candidate[] = []
	let candidateOrganizations = 0
	let cursor: string | undefined

	for (;;) {
		const organizations = await db.query.organization.findMany({
			where: and(
				isNull(organization.personalOrganizationUserId),
				like(organization.name, 'Personal (%)'),
				cursor ? gt(organization.id, cursor) : undefined,
			),
			orderBy: asc(organization.id),
			limit: PAGE_SIZE,
		})
		if (organizations.length === 0) break
		cursor = organizations[organizations.length - 1]?.id
		candidateOrganizations += organizations.length

		const memberships = (await db.query.organizationMemberships.findMany({
			where: inArray(
				organizationMemberships.organizationId,
				organizations.map((candidateOrganization) => candidateOrganization.id),
			),
			with: {
				user: true,
				organizationMembershipRoles: {
					with: {
						role: true,
					},
				},
			},
		})) as MembershipRow[]

		const membershipsByOrganization = new Map<string, MembershipRow[]>()
		for (const membership of memberships) {
			if (!membership.organizationId) continue
			const rows = membershipsByOrganization.get(membership.organizationId)
			if (rows) rows.push(membership)
			else membershipsByOrganization.set(membership.organizationId, [membership])
		}

		for (const candidateOrganization of organizations) {
			const members =
				membershipsByOrganization.get(candidateOrganization.id) ?? []
			if (members.length === 0) {
				incrementReason(unresolvedReasons, 'organization-has-no-memberships')
				continue
			}

			const owners = members.filter(hasActiveOwnerRole)
			let membership: MembershipRow | undefined
			let resolvedByOwnerRole = false
			if (owners.length === 1) {
				membership = owners[0]
				resolvedByOwnerRole = true
			} else if (owners.length === 0 && members.length === 1) {
				membership = members[0]
			} else {
				incrementReason(
					unresolvedReasons,
					owners.length > 1
						? 'multiple-owner-memberships'
						: 'no-owner-and-multiple-memberships',
				)
				continue
			}
			if (!membership) continue

			if (
				membership.personalOrganizationUserId &&
				membership.personalOrganizationUserId !== membership.userId
			) {
				incrementReason(
					unresolvedReasons,
					'membership-stamped-for-different-user',
				)
				continue
			}

			candidates.push({
				organizationId: candidateOrganization.id,
				organizationName: candidateOrganization.name ?? null,
				organizationCreatedAt: candidateOrganization.createdAt ?? null,
				membershipId: membership.id,
				membershipAlreadyStamped:
					membership.personalOrganizationUserId === membership.userId,
				userId: membership.userId,
				resolvedByOwnerRole,
				nameMatchesCurrentEmail:
					!!membership.user?.email &&
					candidateOrganization.name ===
						getPersonalOrganizationName(membership.user.email),
			})
		}
	}

	return { candidates, candidateOrganizations }
}

/**
 * Picks the one organization allowed to carry the durable id when a user has
 * several unstamped `Personal (…)` organizations: the one whose membership
 * already carries the durable id (at most one exists — the column is uniquely
 * indexed), else the single one whose name matches the current email,
 * otherwise the oldest.
 */
function chooseCandidate(candidates: Candidate[]): {
	chosen: Candidate
	skipped: Candidate[]
} {
	const sorted = [...candidates].sort((a, b) => {
		const aTime = a.organizationCreatedAt?.getTime() ?? 0
		const bTime = b.organizationCreatedAt?.getTime() ?? 0
		if (aTime !== bTime) return aTime - bTime
		return a.organizationId.localeCompare(b.organizationId)
	})
	const membershipStamped = sorted.find(
		(candidate) => candidate.membershipAlreadyStamped,
	)
	const nameMatches = sorted.filter(
		(candidate) => candidate.nameMatchesCurrentEmail,
	)
	const chosen = (membershipStamped ??
		(nameMatches.length === 1 ? nameMatches[0] : sorted[0])) as Candidate
	return {
		chosen,
		skipped: sorted.filter((candidate) => candidate !== chosen),
	}
}

async function run() {
	const { mode, receiptPath } = parseArgs(process.argv.slice(2))
	const allowWrite = mode === 'allow-write'
	const startedAt = new Date().toISOString()
	const unresolvedReasons: Record<string, number> = {}
	let writeErrors = 0

	const stamped = await loadStampedUserIds()
	const { candidates, candidateOrganizations } =
		await collectCandidates(unresolvedReasons)

	const candidatesByUser = new Map<string, Candidate[]>()
	for (const candidate of candidates) {
		const rows = candidatesByUser.get(candidate.userId)
		if (rows) rows.push(candidate)
		else candidatesByUser.set(candidate.userId, [candidate])
	}

	const toStamp: Candidate[] = []
	let duplicateCandidatesSkipped = 0
	for (const [userId, userCandidates] of candidatesByUser) {
		if (stamped.organizationUserIds.has(userId)) {
			incrementReason(unresolvedReasons, 'user-already-has-durable-personal-org')
			continue
		}
		const { chosen, skipped } = chooseCandidate(userCandidates)
		// A stamped membership elsewhere (with this organization still
		// unstamped) means stamping this candidate's membership would violate
		// the unique index; a membership stamped on the candidate itself is the
		// org-row-only repair case and proceeds.
		if (
			!chosen.membershipAlreadyStamped &&
			stamped.membershipUserIds.has(userId)
		) {
			incrementReason(
				unresolvedReasons,
				'membership-stamped-for-a-different-membership',
			)
			continue
		}
		duplicateCandidatesSkipped += skipped.length
		for (const _ of skipped) {
			incrementReason(unresolvedReasons, 'duplicate-personal-org-candidates')
		}
		toStamp.push(chosen)
	}

	let organizationsStamped = 0
	let membershipsStamped = 0
	for (const candidate of toStamp) {
		organizationsStamped += 1
		if (!candidate.membershipAlreadyStamped) membershipsStamped += 1
		if (!allowWrite) continue

		try {
			// One transaction per candidate: a stamped organization with an
			// unstamped membership would be filtered out of every future run,
			// so the pair must land together or not at all. Zero affected rows
			// means the IS NULL guard lost a race — roll back and recount.
			await db.transaction(async (tx) => {
				const organizationResult = await tx
					.update(organization)
					.set({ personalOrganizationUserId: candidate.userId })
					.where(
						and(
							eq(organization.id, candidate.organizationId),
							isNull(organization.personalOrganizationUserId),
						),
					)
				if ((organizationResult.rowsAffected ?? 0) === 0) {
					throw new Error('organization-stamp-affected-no-rows')
				}
				if (!candidate.membershipAlreadyStamped) {
					const membershipResult = await tx
						.update(organizationMemberships)
						.set({ personalOrganizationUserId: candidate.userId })
						.where(
							and(
								eq(organizationMemberships.id, candidate.membershipId),
								isNull(organizationMemberships.personalOrganizationUserId),
							),
						)
					if ((membershipResult.rowsAffected ?? 0) === 0) {
						throw new Error('membership-stamp-affected-no-rows')
					}
				}
			})
		} catch (error) {
			writeErrors += 1
			incrementReason(unresolvedReasons, 'stamp-write-failed')
			await log.error('personal-org-backfill.stamp-failed', {
				mode,
				receiptPath,
				organizationId: candidate.organizationId,
				membershipId: candidate.membershipId,
				userId: candidate.userId,
				error: serializeError(error),
			})
		}
	}

	const unresolvedOrganizations = Object.values(unresolvedReasons).reduce(
		(total, count) => total + count,
		0,
	)
	const receipt: AggregateReceipt = {
		version: 1,
		task: 'personal-organization-durable-id-backfill',
		mode,
		startedAt,
		completedAt: new Date().toISOString(),
		counts: {
			candidateOrganizations,
			resolvedByOwnerRole: toStamp.filter(
				(candidate) => candidate.resolvedByOwnerRole,
			).length,
			resolvedBySoleMembership: toStamp.filter(
				(candidate) => !candidate.resolvedByOwnerRole,
			).length,
			organizationsStampedOrPlanned: organizationsStamped,
			membershipsStampedOrPlanned: membershipsStamped,
			nameMismatchesStamped: toStamp.filter(
				(candidate) => !candidate.nameMatchesCurrentEmail,
			).length,
			duplicateCandidatesSkipped,
			unresolvedOrganizations,
			writeErrors,
		},
		writesPerformed: allowWrite,
		unresolvedReasons,
		notes: [
			'Aggregate receipt only; organization, membership, and user identifiers are omitted.',
			'Candidates are unstamped organizations named "Personal (%"; identity comes from the owner membership, with the sole membership as fallback.',
			'A name that no longer matches the current email is stamped anyway and counted in nameMismatchesStamped.',
			'Organizations renamed away from "Personal (…)" are not selected; those users get a fresh durable org from ensurePersonalOrganization instead.',
			'Run after db:push has added the columns and before the core-3 app deploy; safe to re-run.',
		],
	}

	writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
	console.log(JSON.stringify({ receiptPath, ...receipt }, null, 2))

	if (unresolvedOrganizations > 0 || writeErrors > 0) process.exitCode = 1
}

run().catch(async (error) => {
	await log.error('personal-org-backfill.fatal', {
		error: serializeError(error),
	})
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})
