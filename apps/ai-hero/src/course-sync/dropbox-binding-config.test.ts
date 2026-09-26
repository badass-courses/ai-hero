import { describe, expect, it, vi } from 'vitest'

import {
	AI_HERO_COURSE_SYNC_BINDING,
	AI_HERO_COURSE_SYNC_BINDING_COHORT_005,
} from './types'

const links = vi.hoisted(() => ({
	DROPBOX_SYNC_SHARED_LINK: undefined as string | undefined,
	DROPBOX_SYNC_SHARED_LINK_COHORT_005: undefined as string | undefined,
}))
vi.mock('@/env.mjs', () => ({ env: links }))

import { sharedLinkFor } from './dropbox-binding-config'

describe('binding-scoped Dropbox environment', () => {
	it('maps each explicit ref and returns undefined when unset', () => {
		expect(sharedLinkFor(AI_HERO_COURSE_SYNC_BINDING)).toBeUndefined()
		expect(
			sharedLinkFor(AI_HERO_COURSE_SYNC_BINDING_COHORT_005),
		).toBeUndefined()
		links.DROPBOX_SYNC_SHARED_LINK = 'https://www.dropbox.com/crash'
		links.DROPBOX_SYNC_SHARED_LINK_COHORT_005 = 'https://www.dropbox.com/cohort'
		expect(sharedLinkFor(AI_HERO_COURSE_SYNC_BINDING)).toBe(
			links.DROPBOX_SYNC_SHARED_LINK,
		)
		expect(sharedLinkFor(AI_HERO_COURSE_SYNC_BINDING_COHORT_005)).toBe(
			links.DROPBOX_SYNC_SHARED_LINK_COHORT_005,
		)
	})
})
