import { describe, expect, it } from 'vitest'

import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'

import { contactEventId } from './contact-event-id'
import { contactEvent } from './schema'

describe('contactEventId', () => {
	it('yields 16 lowercase alphanumeric characters', () => {
		for (let i = 0; i < 1000; i++) {
			expect(contactEventId()).toMatch(/^[0-9a-z]{16}$/)
		}
	})

	it('does not collide across 100k ids', () => {
		const ids = new Set<string>()
		for (let i = 0; i < 100_000; i++) ids.add(contactEventId())
		expect(ids.size).toBe(100_000)
	})

	it('is the ContactEvent column default', () => {
		const make = contactEvent.id.defaultFn
		expect(make?.()).toMatch(/^[0-9a-z]{16}$/)
	})

	it('is what the capture repository assigns to contact events', () => {
		const repository = new DrizzleCaptureMarketingRepository({} as never)
		expect(repository.newId('contact_event')).toMatch(/^[0-9a-z]{16}$/)
	})
})
