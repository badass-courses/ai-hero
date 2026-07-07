'use server'

import { db } from '@/db'
import { contentResourceResource } from '@/db/schema'
import {
	attachReminderEmailToCohort,
	detachReminderEmailFromCohort,
	updateReminderEmailScheduleForCohort,
	type CohortReminderSchedule,
} from '@/lib/cohort-email-reminders-query'
import { getCohort } from '@/lib/cohorts-query'
import { updateResource } from '@/lib/resources-query'
import { getServerAuthSession } from '@/server/auth'
import { and, asc, eq, sql } from 'drizzle-orm'

import type {
	AttachedEmail,
	ContentsItem,
	ContentsTier,
	ResourceAction,
} from '@coursebuilder/ui/cms/manifest'

/**
 * Server actions backing the CMS cohort editor's bindings
 * (`src/lib/cms/cohort-bindings.ts`). The underlying query helpers in
 * `cohort-email-reminders-query.ts` carry no auth gates of their own (the
 * legacy path guarded them behind tRPC protectedProcedures), so every action
 * here re-checks ability before delegating.
 */

const COHORT_REMINDER_TYPE = 'cohort-reminder'

async function assertCanUpdateContent() {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || !ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}
}

/**
 * Cohort-specific update for the CMS editor. Delegates to the generic
 * `updateResource` (which keeps ALL legacy save side-effects: auth, TypeSense
 * upsert, revalidation, and the cohort entitlement-sync trigger) and adds the
 * one thing the CMS needs on top: stamping `fields.publishedAt` on the
 * transition INTO 'published' (or backfilling a missing stamp), detected from
 * state values — same policy as `updatePost`.
 */
export async function updateCohort(
	input: {
		id: string
		fields: Record<string, any>
		createdById?: string
	},
	// Present for verb-level logging parity with updatePost; persistence is
	// state-driven (the editor writes `fields.state` before submitting).
	_action: ResourceAction = 'save',
) {
	const current = await getCohort(input.id)
	if (!current) {
		throw new Error(`Cohort with id ${input.id} not found.`)
	}

	const publishedAtOverride =
		input.fields.state === 'published' &&
		(current.fields.state !== 'published' || !current.fields.publishedAt)
			? { publishedAt: new Date().toISOString() }
			: {}

	return await updateResource({
		id: input.id,
		type: 'cohort',
		fields: { ...input.fields, ...publishedAtOverride },
		createdById: input.createdById || current.createdById,
	})
}

/**
 * The cohort's workshop children as CMS `ContentsItem` rows — join-row
 * position + `metadata.tier` included (the pieces `getAllWorkshopsInCohort`
 * drops). Email-reminder join rows live on the SAME `contentResourceResource`
 * table, so this filters to `type === 'workshop'` (legacy list editor parity:
 * `visibleResourceTypes: ['workshop']`).
 */
export async function listCohortWorkshops(
	cohortId: string,
): Promise<ContentsItem[]> {
	await assertCanUpdateContent()

	const rows = await db.query.contentResourceResource.findMany({
		where: eq(contentResourceResource.resourceOfId, cohortId),
		with: { resource: true },
		orderBy: asc(contentResourceResource.position),
	})

	return rows
		.filter((row) => row.resource?.type === 'workshop' && !row.resource.deletedAt)
		.map((row) => {
			const fields = (row.resource.fields ?? {}) as Record<string, any>
			const tier = (row.metadata as Record<string, any> | null)?.tier
			return {
				id: row.resource.id,
				type: row.resource.type,
				title: fields.title ?? fields.slug ?? row.resource.id,
				slug: fields.slug ?? undefined,
				state: fields.state ?? 'draft',
				visibility: fields.visibility ?? undefined,
				position: row.position,
				...(typeof tier === 'string' ? { tier: tier as ContentsTier } : {}),
			}
		})
}

/**
 * The cohort's attached emails WITH their join-metadata send policy + send log —
 * the shape `EmailsField` renders. Cohorts support an exact `sendAt` (policy
 * `'at'`) in addition to relative `hoursInAdvance`.
 */
export async function listCohortReminders(
	cohortId: string,
): Promise<AttachedEmail[]> {
	await assertCanUpdateContent()

	const refs = await db.query.contentResourceResource.findMany({
		where: and(
			eq(contentResourceResource.resourceOfId, cohortId),
			eq(
				sql`JSON_EXTRACT(${contentResourceResource.metadata}, "$.type")`,
				COHORT_REMINDER_TYPE,
			),
		),
		with: { resource: true },
		orderBy: asc(contentResourceResource.createdAt),
	})

	return refs
		.filter((ref) => ref.resource?.type === 'email' && !ref.resource.deletedAt)
		.map((ref) => {
			const fields = (ref.resource.fields ?? {}) as Record<string, any>
			const metadata = (ref.metadata ?? {}) as Record<string, any>
			const hoursInAdvance =
				typeof metadata.hoursInAdvance === 'number'
					? metadata.hoursInAdvance
					: undefined
			const sendAt =
				typeof metadata.sendAt === 'string' ? metadata.sendAt : null
			// A fired send stamps `policy: null` explicitly (cleared) — honor that;
			// otherwise derive: exact `sendAt` → 'at', else `hoursInAdvance` →
			// 'relative', else nothing scheduled.
			const policy: AttachedEmail['policy'] =
				'policy' in metadata
					? metadata.policy
					: sendAt
						? 'at'
						: hoursInAdvance !== undefined
							? 'relative'
							: null
			return {
				emailId: ref.resource.id,
				title: fields.title ?? ref.resource.id,
				href: fields.slug ? `/admin/emails/${fields.slug}/edit` : undefined,
				// Content for the in-place "Edit email" dialog prefill.
				subject:
					typeof fields.subject === 'string' ? fields.subject : undefined,
				body: typeof fields.body === 'string' ? fields.body : undefined,
				// Gate schedule fields on the resolved policy so a cleared row reads
				// as "Not scheduled" rather than surfacing a stale time.
				hoursInAdvance: policy === 'relative' ? hoursInAdvance : undefined,
				sendAt: policy === 'at' ? sendAt : null,
				policy,
				sends: Array.isArray(metadata.sends) ? metadata.sends : [],
			}
		})
}

/** Auth-gated wrapper — legacy guarded this behind a tRPC protectedProcedure. */
export async function attachCohortReminder(
	cohortId: string,
	emailId: string,
	schedule?: CohortReminderSchedule,
) {
	await assertCanUpdateContent()
	await attachReminderEmailToCohort(cohortId, emailId, schedule)
}

/** Auth-gated wrapper — legacy guarded this behind a tRPC protectedProcedure. */
export async function detachCohortReminder(cohortId: string, emailId: string) {
	await assertCanUpdateContent()
	await detachReminderEmailFromCohort(cohortId, emailId)
}

/** Auth-gated wrapper — legacy guarded this behind a tRPC protectedProcedure. */
export async function updateCohortReminderSchedule(
	cohortId: string,
	emailId: string,
	schedule: CohortReminderSchedule,
) {
	await assertCanUpdateContent()
	await updateReminderEmailScheduleForCohort(cohortId, emailId, schedule)
}
