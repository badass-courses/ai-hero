import type { CohortCourseSyncBinding } from '../types'

/** Test-only cohort contract. No production Cohort 005 identifiers belong here. */
export const syntheticCohortBinding = {
	contractVersion: 5,
	bindingId: 'csb_test_cohort',
	status: 'active',
	sourceCourseId: 'test-course',
	productId: 'test-product',
	anchorCohortId: 'test-cohort',
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
