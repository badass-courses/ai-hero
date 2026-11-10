import { describe, expect, it } from 'vitest'

import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'

import { providerIdentity, contactState, stateTransition } from './schema'

const SHAPE = /^[0-9a-z]{16}$/

describe('16-character identity ids', () => {
	it.each(['provider_identity', 'state_transition', 'state'])(
		'newId(%s) yields 16 lowercase alphanumeric characters',
		(kind) => {
			const repository = new DrizzleCaptureMarketingRepository({} as never)
			for (let i = 0; i < 200; i++) expect(repository.newId(kind)).toMatch(SHAPE)
		},
	)

	it.each([
		['ProviderIdentity', providerIdentity],
		['ContactState', contactState],
		['StateTransition', stateTransition],
	])('%s column default yields 16 characters', (_name, table) => {
		for (let i = 0; i < 200; i++) expect(table.id.defaultFn?.()).toMatch(SHAPE)
	})
})
