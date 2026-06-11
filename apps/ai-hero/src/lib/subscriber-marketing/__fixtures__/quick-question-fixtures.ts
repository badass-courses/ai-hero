import type { FixtureContactEventInput } from '../types'

export const codingWorkflowFixture: FixtureContactEventInput = {
	provider: 'fixture',
	providerEventId: 'fixture-event-001',
	eventType: 'quick-question.reply',
	occurredAt: '2026-05-04T12:00:00.000Z',
	email: 'DEV@example.com',
	name: 'Dev Example',
	externalId: 'fixture-contact-001',
	message:
		'I am a professional software engineer trying to use AI in my real engineering coding workflow so I can ship code in our production codebase.',
}

export const supportFixture: FixtureContactEventInput = {
	provider: 'fixture',
	providerEventId: 'fixture-event-002',
	eventType: 'quick-question.reply',
	occurredAt: '2026-05-04T12:05:00.000Z',
	email: 'help@example.com',
	externalId: 'fixture-contact-002',
	message:
		'I need help because login is broken and I cannot access my purchase.',
}

export const restrictedFixture: FixtureContactEventInput = {
	provider: 'fixture',
	providerEventId: 'fixture-event-003',
	eventType: 'quick-question.reply',
	occurredAt: '2026-05-04T12:10:00.000Z',
	email: 'private@example.com',
	externalId: 'fixture-contact-003',
	privacyLevel: 'restricted',
	message:
		'I am a founder building a product prototype but this reply has restricted payload boundaries.',
}
