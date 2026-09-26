import { describe, expect, it, vi } from 'vitest'

import {
	AI_HERO_COURSE_SYNC_BINDING,
	type CohortCourseSyncBinding,
} from './types'

const links = vi.hoisted(() => ({
	DROPBOX_SYNC_SHARED_LINK: undefined as string | undefined,
	DROPBOX_SYNC_SHARED_LINK_COHORT_005: undefined as string | undefined,
}))
vi.mock('@/env.mjs', () => ({ env: links }))

import { sharedLinkFor } from './dropbox-binding-config'

const cohortBinding = {
	contractVersion: 5,
	bindingId: 'synthetic-cohort',
	status: 'active',
	sourceCourseId: 'synthetic-course',
	productId: 'synthetic-product',
	anchorCohortId: 'synthetic-anchor',
	targetContract: {
		product: { type: 'cohort', state: 'draft', visibility: 'unlisted' },
		cohort: { type: 'cohort', state: 'draft', visibility: 'unlisted' },
		relation: { position: 0, exclusiveProduct: true },
	},
	managedChildContract: {
		workshop: { state: 'draft', visibility: 'unlisted' },
		lesson: { state: 'draft', visibility: 'unlisted' },
	},
	applyPolicy: 'operator',
	initialApplyPolicyOverride: 'operator',
	sectionMappingPolicy: 'sections-as-cohort-workshops',
	sharedLinkSecretRef: 'DROPBOX_SYNC_SHARED_LINK_COHORT_005',
	assetConnector: 'dropbox-shared-link',
} as const satisfies CohortCourseSyncBinding

describe('binding-scoped Dropbox environment', () => {
	it('maps each explicit ref and returns undefined when unset', () => {
		expect(sharedLinkFor(AI_HERO_COURSE_SYNC_BINDING)).toBeUndefined()
		expect(sharedLinkFor(cohortBinding)).toBeUndefined()
		links.DROPBOX_SYNC_SHARED_LINK = 'https://www.dropbox.com/crash'
		links.DROPBOX_SYNC_SHARED_LINK_COHORT_005 = 'https://www.dropbox.com/cohort'
		expect(sharedLinkFor(AI_HERO_COURSE_SYNC_BINDING)).toBe(
			links.DROPBOX_SYNC_SHARED_LINK,
		)
		expect(sharedLinkFor(cohortBinding)).toBe(
			links.DROPBOX_SYNC_SHARED_LINK_COHORT_005,
		)
	})
})
