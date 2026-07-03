'use server'

import { db } from '@/db'
import { contentResourceResource } from '@/db/schema'
import {
	attachReminderEmailToEvent,
	detachReminderEmailFromEvent,
	getEvent,
	updateReminderEmailHours,
} from '@/lib/events-query'
import { updateResource } from '@/lib/resources-query'
import { getServerAuthSession } from '@/server/auth'
import { and, asc, eq, sql } from 'drizzle-orm'

import type {
	ReminderItem,
	ReminderSchedule,
	ResourceAction,
} from '@coursebuilder/ui/cms/manifest'

/**
 * Server actions backing the CMS event editor's bindings
 * (`src/lib/cms/event-bindings.ts`). The underlying reminder helpers in
 * `events-query.ts` carry no auth gates of their own (the legacy path
 * guarded them behind tRPC protectedProcedures — `api.events.*`), so every
 * action here re-checks ability before delegating. Same shape as
 * `cohort-actions.ts`, with the event-reminder join metadata type.
 */

const EVENT_REMINDER_TYPE = 'event-reminder'

async function assertCanUpdateContent() {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || !ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}
}

/**
 * Event-specific update for the CMS editor (no `updateEvent` existed —
 * the legacy form passed the generic `updateResource` directly). Delegates
 * to `updateResource` (which keeps ALL legacy save side-effects: auth,
 * TypeSense upsert, revalidation) and adds the one thing the CMS needs on
 * top: stamping `fields.publishedAt` on the transition INTO 'published'
 * (or backfilling a missing stamp) — same policy as `updatePost`/`updateCohort`.
 */
export async function updateEvent(
	input: {
		id: string
		fields: Record<string, any>
		createdById?: string
	},
	// Present for verb-level logging parity with updatePost; persistence is
	// state-driven (the editor writes `fields.state` before submitting).
	_action: ResourceAction = 'save',
) {
	const current = await getEvent(input.id)
	if (!current) {
		throw new Error(`Event with id ${input.id} not found.`)
	}

	const publishedAtOverride =
		input.fields.state === 'published' &&
		(current.fields.state !== 'published' || !current.fields.publishedAt)
			? { publishedAt: new Date().toISOString() }
			: {}

	return await updateResource({
		id: input.id,
		type: 'event',
		fields: { ...input.fields, ...publishedAtOverride },
		createdById: input.createdById || current.createdById,
	})
}

/**
 * The event's attached reminder emails WITH their join-metadata schedule —
 * the shape `RemindersField` renders (`getEventReminderEmails` returns the
 * email resources only and drops the schedule). Mirrors `listCohortReminders`
 * with the `event-reminder` metadata type; events store `hoursInAdvance`
 * only (no exact `sendAt` in the event model).
 */
export async function listEventReminders(
	eventId: string,
): Promise<ReminderItem[]> {
	await assertCanUpdateContent()

	const refs = await db.query.contentResourceResource.findMany({
		where: and(
			eq(contentResourceResource.resourceOfId, eventId),
			eq(
				sql`JSON_EXTRACT(${contentResourceResource.metadata}, "$.type")`,
				EVENT_REMINDER_TYPE,
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
			return {
				emailId: ref.resource.id,
				title: fields.title ?? ref.resource.id,
				href: fields.slug ? `/admin/emails/${fields.slug}/edit` : undefined,
				hoursInAdvance:
					typeof metadata.hoursInAdvance === 'number'
						? metadata.hoursInAdvance
						: undefined,
			}
		})
}

/** Auth-gated wrapper — legacy guarded this behind a tRPC protectedProcedure. */
export async function attachEventReminder(
	eventId: string,
	emailId: string,
	schedule?: ReminderSchedule,
) {
	await assertCanUpdateContent()
	await attachReminderEmailToEvent(eventId, emailId, schedule?.hoursInAdvance)
}

/** Auth-gated wrapper — legacy guarded this behind a tRPC protectedProcedure. */
export async function detachEventReminder(eventId: string, emailId: string) {
	await assertCanUpdateContent()
	await detachReminderEmailFromEvent(eventId, emailId)
}

/**
 * Auth-gated wrapper. The event model stores `hoursInAdvance` only —
 * `schedule.sendAt` has no storage here and is ignored (the kit widget only
 * edits hour presets anyway).
 */
export async function updateEventReminderSchedule(
	eventId: string,
	emailId: string,
	schedule: ReminderSchedule,
) {
	await assertCanUpdateContent()
	const updated = await updateReminderEmailHours(
		eventId,
		emailId,
		schedule.hoursInAdvance ?? 24,
	)
	// null means the reminder join row is gone (stale UI) — surface it instead
	// of letting the widget render a schedule the server never persisted.
	if (updated === null) {
		throw new Error('Could not update the reminder schedule')
	}
}
