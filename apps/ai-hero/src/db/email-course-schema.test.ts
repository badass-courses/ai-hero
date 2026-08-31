import { describe, expect, it } from 'vitest'
import { getTableConfig } from 'drizzle-orm/mysql-core'

import {
	automationControl,
	emailCourseCommit,
} from './email-course-schema'
import { evergreenOfferJourneyIntent } from './evergreen-offer-journey-schema'
import { contactEvent, sideEffectIntent } from './schema'

describe('dormant Email Course and Evergreen schema', () => {
	it('stores authoritative Email Course snapshots and stimulus replay', () => {
		const config = getTableConfig(emailCourseCommit)

		expect(config.name).toBe('AI_EmailCourseCommit')
		expect(config.columns.map((column) => column.name)).toEqual([
			'runId',
			'actorVersion',
			'stimulusId',
			'snapshot',
			'decision',
			'events',
			'receipt',
			'decidedAt',
			'committedAt',
		])
		expect(
			config.primaryKeys.map((key) =>
				key.columns.map((column) => column.name),
			),
		).toEqual([['runId', 'actorVersion']])
		expect(config.indexes.map((index) => index.config.name)).toContain(
			'EmailCourseCommit_stimulusId_uq',
		)
	})

	it('stores one typed control value per automation id', () => {
		const config = getTableConfig(automationControl)

		expect(config.name).toBe('AI_AutomationControl')
		expect(config.columns.map((column) => column.name)).toEqual([
			'automationId',
			'control',
			'updatedAt',
		])
	})

	it('adds only the course ownership and due-work columns to the outbox', () => {
		const config = getTableConfig(sideEffectIntent)
		const columns = config.columns.map((column) => column.name)
		const indexes = config.indexes.map((index) => index.config.name)

		expect(columns).toContain('courseRunId')
		expect(columns).toContain('availableAt')
		expect(columns).toContain('activeSlot')
		expect(columns).not.toContain('courseStepId')
		expect(indexes).toContain(
			'SideEffectIntent_provider_type_status_availableAt_idx',
		)
		expect(indexes).toContain('SideEffectIntent_courseRun_activeSlot_uq')
	})

	it('reuses Contact Event facts and adds only the bounded read index', () => {
		const config = getTableConfig(contactEvent)
		const columns = config.columns.map((column) => column.name)
		const indexes = config.indexes.map((index) => index.config.name)

		expect(columns).not.toContain('domainFactKey')
		expect(columns).not.toContain('payloadFormat')
		expect(columns).not.toContain('domainPayload')
		expect(indexes).toContain('ContactEvent_eventType_occurredAt_id_idx')
	})

	it('indexes Evergreen intents by status and available time', () => {
		const config = getTableConfig(evergreenOfferJourneyIntent)
		const indexes = config.indexes.map((index) => index.config.name)

		expect(config.columns.map((column) => column.name)).toContain('availableAt')
		expect(indexes).toContain(
			'EvergreenOfferJourneyIntent_status_availableAt_idx',
		)
	})
})
