import { db } from '@/db'
import { contentResource, contentResourceResource } from '@/db/schema'
import { getUsersEntitledToWorkshops } from '@/lib/cohort-workshop-emails-query'
import { type Cohort } from '@/lib/cohort'
import { getAllWorkshopsInCohort, getCohort } from '@/lib/cohorts-query'
import { EmailSchema, type NewEmail } from '@/lib/emails'
import { createEmail } from '@/lib/emails-query'
import { log } from '@/server/logger'
import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import type { ContentResourceResource } from '@coursebuilder/core/schemas'

export type CohortReminderSchedule = {
	hoursInAdvance?: number
	sendAt?: string | null
}

export type CohortReminderRecipient = {
	id: string
	email: string
	name?: string | null
}

export type CohortReminderData = {
	cohort: Cohort
	emailResource: {
		id: string
		type: string
		fields: Record<string, any>
	}
	hoursInAdvance?: number
	sendAt?: string | null
	reminderTime: string
	reminderRef: ContentResourceResource
}

const COHORT_REMINDER_TYPE = 'cohort-reminder'

function buildReminderMetadata(schedule?: CohortReminderSchedule) {
	const metadata: Record<string, unknown> = {
		type: COHORT_REMINDER_TYPE,
	}

	if (typeof schedule?.hoursInAdvance === 'number') {
		metadata.hoursInAdvance = schedule.hoursInAdvance
	}

	if (schedule?.sendAt) {
		metadata.sendAt = schedule.sendAt
	}

	if (
		typeof metadata.hoursInAdvance !== 'number' &&
		typeof metadata.sendAt !== 'string'
	) {
		metadata.hoursInAdvance = 24
	}

	return metadata
}

function resolveReminderTime(
	cohort: Cohort,
	metadata: Record<string, any> | null | undefined,
): {
	reminderTime: Date
	hoursInAdvance?: number
	sendAt?: string | null
} | null {
	if (metadata?.sendAt) {
		const exactSendTime = new Date(metadata.sendAt)
		if (Number.isNaN(exactSendTime.getTime())) {
			return null
		}

		return {
			reminderTime: exactSendTime,
			sendAt: metadata.sendAt,
			hoursInAdvance:
				typeof metadata.hoursInAdvance === 'number'
					? metadata.hoursInAdvance
					: undefined,
		}
	}

	if (!cohort.fields.startsAt || typeof metadata?.hoursInAdvance !== 'number') {
		return null
	}

	const cohortStartTime = new Date(cohort.fields.startsAt)
	if (Number.isNaN(cohortStartTime.getTime())) {
		return null
	}

	return {
		reminderTime: new Date(
			cohortStartTime.getTime() - metadata.hoursInAdvance * 60 * 60 * 1000,
		),
		hoursInAdvance: metadata.hoursInAdvance,
		sendAt: null,
	}
}

export async function getCohortReminderEmails(cohortId: string) {
	const reminderRefs = await db.query.contentResourceResource.findMany({
		where: and(
			eq(contentResourceResource.resourceOfId, cohortId),
			eq(
				sql`JSON_EXTRACT(${contentResourceResource.metadata}, "$.type")`,
				COHORT_REMINDER_TYPE,
			),
		),
		with: {
			resource: {
				with: {
					resources: {
						with: {
							resource: true,
						},
						orderBy: asc(contentResourceResource.position),
					},
				},
			},
		},
		orderBy: asc(contentResourceResource.createdAt),
	})

	const emails = reminderRefs.map((ref) => ref.resource)
	const parsedEmails = z.array(EmailSchema).safeParse(emails)

	if (!parsedEmails.success) {
		void log.error('cohort.reminder-emails.parse.error', {
			scope: 'cohort',
			cohortId,
			error: parsedEmails.error.message,
		})
		return []
	}

	return parsedEmails.data
}

export async function getAllCohortReminderEmails() {
	const reminderRefs = await db.query.contentResourceResource.findMany({
		where: eq(
			sql`JSON_EXTRACT(${contentResourceResource.metadata}, "$.type")`,
			COHORT_REMINDER_TYPE,
		),
		with: {
			resource: {
				with: {
					resources: {
						with: {
							resource: true,
						},
						orderBy: asc(contentResourceResource.position),
					},
				},
			},
		},
		orderBy: asc(contentResourceResource.createdAt),
	})

	const emailsMap = new Map()
	for (const ref of reminderRefs) {
		if (ref.resource && !emailsMap.has(ref.resource.id)) {
			emailsMap.set(ref.resource.id, ref.resource)
		}
	}

	const allEmailResources = await db.query.contentResource.findMany({
		where: eq(contentResource.type, 'email'),
		orderBy: asc(contentResource.createdAt),
	})

	for (const emailResource of allEmailResources) {
		if (!emailsMap.has(emailResource.id)) {
			emailsMap.set(emailResource.id, emailResource)
		}
	}

	const emails = Array.from(emailsMap.values())
	const parsedEmails = z.array(EmailSchema).safeParse(emails)

	if (!parsedEmails.success) {
		void log.error('cohort.reminder-emails.parse.error', {
			scope: 'all',
			error: parsedEmails.error.message,
		})
		return { emails: [], refs: reminderRefs }
	}

	const uniqueRefs = reminderRefs.filter(
		(ref, index, self) =>
			index ===
			self.findIndex(
				(r) =>
					r.resourceId === ref.resourceId &&
					r.resourceOfId === ref.resourceOfId,
			),
	)

	return {
		emails: parsedEmails.data,
		refs: uniqueRefs,
	}
}

export async function attachReminderEmailToCohort(
	cohortId: string,
	emailResourceId: string,
	schedule?: CohortReminderSchedule,
	detachExisting: boolean = false,
) {
	const emailResource = await db.query.contentResource.findFirst({
		where: and(
			eq(contentResource.id, emailResourceId),
			eq(contentResource.type, 'email'),
		),
	})

	if (!emailResource) {
		throw new Error('Email resource not found or not of type email')
	}

	let nextSchedule = schedule
	if (!nextSchedule?.sendAt && nextSchedule?.hoursInAdvance === undefined) {
		const existing = await db.query.contentResourceResource.findFirst({
			where: and(
				eq(contentResourceResource.resourceOfId, cohortId),
				eq(contentResourceResource.resourceId, emailResourceId),
				eq(
					sql`JSON_EXTRACT(${contentResourceResource.metadata}, "$.type")`,
					COHORT_REMINDER_TYPE,
				),
			),
		})

		nextSchedule = {
			hoursInAdvance:
				typeof (existing?.metadata as any)?.hoursInAdvance === 'number'
					? (existing?.metadata as any).hoursInAdvance
					: 24,
			sendAt: (existing?.metadata as any)?.sendAt ?? null,
		}
	}

	return await db.transaction(async (tx) => {
		if (detachExisting) {
			await tx
				.delete(contentResourceResource)
				.where(
					and(
						eq(contentResourceResource.resourceOfId, cohortId),
						eq(
							sql`JSON_EXTRACT(${contentResourceResource.metadata}, "$.type")`,
							COHORT_REMINDER_TYPE,
						),
					),
				)
		}

		return await tx.insert(contentResourceResource).values({
			resourceOfId: cohortId,
			resourceId: emailResourceId,
			metadata: buildReminderMetadata(nextSchedule),
		})
	})
}

export async function detachReminderEmailFromCohort(
	cohortId: string,
	emailResourceId: string,
) {
	await db
		.delete(contentResourceResource)
		.where(
			and(
				eq(contentResourceResource.resourceOfId, cohortId),
				eq(contentResourceResource.resourceId, emailResourceId),
				eq(
					sql`JSON_EXTRACT(${contentResourceResource.metadata}, "$.type")`,
					COHORT_REMINDER_TYPE,
				),
			),
		)

	return true
}

export async function createAndAttachReminderEmailToCohort(
	cohortId: string,
	input: NewEmail,
	schedule?: CohortReminderSchedule,
	detachExisting: boolean = false,
) {
	const email = await createEmail(input)

	if (!email) {
		throw new Error('Failed to create email')
	}

	await attachReminderEmailToCohort(
		cohortId,
		email.id,
		schedule,
		detachExisting,
	)

	return email
}

export async function updateReminderEmailScheduleForCohort(
	cohortId: string,
	emailResourceId: string,
	schedule?: CohortReminderSchedule,
) {
	return await db
		.update(contentResourceResource)
		.set({
			metadata: buildReminderMetadata(schedule),
		})
		.where(
			and(
				eq(contentResourceResource.resourceOfId, cohortId),
				eq(contentResourceResource.resourceId, emailResourceId),
				eq(
					sql`JSON_EXTRACT(${contentResourceResource.metadata}, "$.type")`,
					COHORT_REMINDER_TYPE,
				),
			),
		)
}

export async function getCohortReminderRecipients(
	cohortId: string,
): Promise<CohortReminderRecipient[]> {
	const workshops = await getAllWorkshopsInCohort(cohortId)
	const workshopIds = workshops.map((workshop) => workshop.id)

	if (workshopIds.length === 0) {
		return []
	}

	return await getUsersEntitledToWorkshops(workshopIds)
}

export async function getCohortRemindersNeedingScheduling(
	now: Date,
	tomorrow: Date,
): Promise<CohortReminderData[]> {
	const reminderEmailRefs = await db.query.contentResourceResource.findMany({
		where: eq(
			sql`JSON_EXTRACT(${contentResourceResource.metadata}, "$.type")`,
			COHORT_REMINDER_TYPE,
		),
		with: {
			resource: true,
		},
	})

	const remindersNeedingScheduling: CohortReminderData[] = []

	for (const ref of reminderEmailRefs) {
		const cohort = await getCohort(ref.resourceOfId)
		if (!cohort || cohort.fields.state !== 'published') {
			continue
		}

		const metadata = (ref.metadata as Record<string, any> | null) ?? null
		const schedule = resolveReminderTime(cohort, metadata)

		if (!schedule) {
			await log.error('cohort.reminder.invalid-config', {
				cohortId: cohort.id,
				hoursInAdvance: metadata?.hoursInAdvance ?? null,
				sendAt: metadata?.sendAt ?? null,
			})
			continue
		}

		if (schedule.reminderTime >= now && schedule.reminderTime < tomorrow) {
			remindersNeedingScheduling.push({
				cohort,
				emailResource: ref.resource as unknown as {
					id: string
					type: string
					fields: Record<string, any>
				},
				hoursInAdvance: schedule.hoursInAdvance,
				sendAt: schedule.sendAt,
				reminderTime: schedule.reminderTime.toISOString(),
				reminderRef: ref as unknown as ContentResourceResource,
			})
		}
	}

	return remindersNeedingScheduling.sort(
		(a, b) =>
			new Date(a.reminderTime).getTime() - new Date(b.reminderTime).getTime(),
	)
}
