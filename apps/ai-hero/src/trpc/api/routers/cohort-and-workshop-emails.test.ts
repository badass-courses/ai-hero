import { createMongoAbility } from '@casl/ability'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	attach: vi.fn(),
	createAndAttach: vi.fn(),
	detach: vi.fn(),
	recipients: vi.fn(),
	schedule: vi.fn(),
	getCohort: vi.fn(),
	workshops: vi.fn(),
	getEmailSimple: vi.fn(),
	updateEmailSimple: vi.fn(),
	createEmail: vi.fn(),
	getEmail: vi.fn(),
	addResourceToWorkshop: vi.fn(),
	dbDelete: vi.fn(),
	send: vi.fn(),
	revalidateTag: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidateTag: mocks.revalidateTag }))
vi.mock('@/db', () => ({ db: { delete: mocks.dbDelete } }))
vi.mock('@/db/schema', () => ({ contentResourceResource: {} }))
vi.mock('@/env.mjs', () => ({
	env: {
		NEXT_PUBLIC_URL: 'https://example.test',
		NEXT_PUBLIC_SITE_TITLE: 'Test',
		NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.test',
	},
}))
vi.mock('@/emails/basic-email', () => ({ default: () => null }))
vi.mock('@/lib/emails-query', () => ({
	createEmail: mocks.createEmail,
	getEmail: mocks.getEmail,
	getEmails: vi.fn(),
	getEmailSimple: mocks.getEmailSimple,
	updateEmailSimple: mocks.updateEmailSimple,
}))
vi.mock('@/lib/cohort-email-reminders-query', () => ({
	attachReminderEmailToCohort: mocks.attach,
	createAndAttachReminderEmailToCohort: mocks.createAndAttach,
	detachReminderEmailFromCohort: mocks.detach,
	getAllCohortReminderEmails: vi.fn(),
	getCohortReminderEmails: vi.fn(),
	getCohortReminderRecipients: mocks.recipients,
	updateReminderEmailScheduleForCohort: mocks.schedule,
}))
vi.mock('@/lib/cohorts-query', () => ({
	getAllWorkshopsInCohort: mocks.workshops,
	getCohort: mocks.getCohort,
}))
vi.mock('@/lib/workshops-query', () => ({
	addResourceToWorkshop: mocks.addResourceToWorkshop,
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))
vi.mock('@/server/logger', () => ({
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))
vi.mock('@coursebuilder/utils/send-an-email', () => ({
	sendAnEmail: mocks.send,
}))

import { cohortsRouter } from './cohorts'
import { emailsRouter } from './emails'

const learnerCtx = {
	session: { user: { id: 'u1' } },
	ability: createMongoAbility([{ action: 'read', subject: 'Content' }]),
	headers: new Headers(),
	db: {},
} as any

const ids = { cohortId: 'cohort-1', emailId: 'email-1' }
const fields = { title: 'Reminder', subject: 'Hello', body: 'Body' }

const cohorts = cohortsRouter.createCaller(learnerCtx)
const emails = emailsRouter.createCaller(learnerCtx)

const calls: Record<string, () => Promise<unknown>> = {
	'cohorts.attachReminderEmailToCohort': () =>
		cohorts.attachReminderEmailToCohort(ids),
	'cohorts.detachReminderEmailFromCohort': () =>
		cohorts.detachReminderEmailFromCohort(ids),
	'cohorts.createAndAttachReminderEmailToCohort': () =>
		cohorts.createAndAttachReminderEmailToCohort({
			cohortId: ids.cohortId,
			input: { fields },
		}),
	'cohorts.updateReminderEmailScheduleForCohort': () =>
		cohorts.updateReminderEmailScheduleForCohort({
			...ids,
			schedule: { hoursInAdvance: 24 },
		}),
	'cohorts.updateReminderEmailForCohort': () =>
		cohorts.updateReminderEmailForCohort({ ...ids, fields }),
	'cohorts.previewReminderEmailForCohort': () =>
		cohorts.previewReminderEmailForCohort(ids),
	'cohorts.sendReminderEmailNowForCohort': () =>
		cohorts.sendReminderEmailNowForCohort(ids),
	'emails.createEmail': () => emails.createEmail({ fields }),
	'emails.addEmailToWorkshop': () =>
		emails.addEmailToWorkshop({ workshopId: 'w1', emailId: 'email-1' }),
	'emails.removeEmailFromWorkshop': () =>
		emails.removeEmailFromWorkshop({ workshopId: 'w1', emailId: 'email-1' }),
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('cohort reminder and workshop email procedures', () => {
	it.each(Object.keys(calls))(
		'%s refuses a logged-in non-editor before reading, writing or sending',
		async (name) => {
			await expect(calls[name]!()).rejects.toMatchObject({ code: 'FORBIDDEN' })
			for (const fn of Object.values(mocks)) {
				expect(fn).not.toHaveBeenCalled()
			}
		},
	)
})
