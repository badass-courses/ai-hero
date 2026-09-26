import { CourseSyncError } from './errors'

import type {
	CourseJsonDocumentV3,
	CourseSyncResourceAction,
	CourseSyncRunState,
} from '@ai-hero/course-sync-schema'

export type WorkshopCourseSyncBinding = {
	contractVersion: 4
	bindingId: string
	sourceCourseId: string
	productId: string
	anchorWorkshopId: string
	targetContract: {
		product: {
			type: 'self-paced'
			state: 'published'
			visibility: 'public'
		}
		workshop: {
			type: 'workshop'
			state: 'published'
			visibility: 'public'
		}
		relation: { position: 0; exclusiveProduct: true }
	}
	managedChildContract: {
		state: 'draft'
		visibility: 'unlisted'
	}
	applyPolicy: 'bounded-auto' | 'operator'
	sectionMappingPolicy: 'sections-in-anchor-workshop'
	assetConnector: 'dropbox-shared-link'
	sharedLinkSecretRef: 'DROPBOX_SYNC_SHARED_LINK'
	status: 'active' | 'suspended' | 'revoked'
}

/** Cohort-anchored syllabus: each section is a managed workshop. */
export type CohortCourseSyncBinding = {
	contractVersion: 5
	bindingId: string
	status: 'active' | 'suspended' | 'revoked'
	sourceCourseId: string
	productId: string
	anchorCohortId: string
	targetContract: {
		product: {
			type: 'cohort'
			state: 'draft' | 'published'
			visibility: 'unlisted' | 'public'
		}
		cohort: {
			type: 'cohort'
			state: 'draft' | 'published'
			visibility: 'unlisted' | 'public'
		}
		relation: { position: 0; exclusiveProduct: true }
	}
	managedChildContract: {
		workshop: { state: 'draft' | 'published'; visibility: 'unlisted' }
		lesson: { state: 'draft'; visibility: 'unlisted' }
	}
	applyPolicy: 'bounded-auto' | 'operator'
	initialApplyPolicyOverride: 'operator' | null
	sectionMappingPolicy: 'sections-as-cohort-workshops'
	sharedLinkSecretRef: 'DROPBOX_SYNC_SHARED_LINK_COHORT_005'
	assetConnector: WorkshopCourseSyncBinding['assetConnector']
}

export type CourseSyncBinding =
	| WorkshopCourseSyncBinding
	| CohortCourseSyncBinding

export function anchorResourceId(binding: CourseSyncBinding): string {
	return binding.contractVersion === 4
		? binding.anchorWorkshopId
		: binding.anchorCohortId
}

export function managedSectionKind(
	binding: CourseSyncBinding,
): 'section' | 'workshop' {
	return binding.contractVersion === 4 ? 'section' : 'workshop'
}

export function managedChildContractFor(
	binding: CourseSyncBinding,
	kind: 'section' | 'workshop' | 'lesson',
) {
	if (binding.contractVersion === 4) {
		return kind === 'section' ? binding.managedChildContract : null
	}
	return kind === 'workshop'
		? binding.managedChildContract.workshop
		: kind === 'lesson'
			? binding.managedChildContract.lesson
			: null
}

/** The only stored v1 value that may be migrated in place. */
export const AI_HERO_COURSE_SYNC_BINDING_V1 = {
	bindingId: 'csb_ai_coding_crash_course',
	sourceCourseId: '50385098-a712-486f-b777-1f76ef31e9e5',
	productId: 'product-ma254',
	anchorWorkshopId: 'workshop-2ozd9',
	productType: 'self-paced',
	requiredState: 'draft',
	requiredVisibility: 'unlisted',
	sectionMappingPolicy: 'sections-in-anchor-workshop',
	assetConnector: 'dropbox-shared-link',
	sharedLinkSecretRef: 'DROPBOX_SYNC_SHARED_LINK',
	status: 'active',
} as const

export const AI_HERO_COURSE_SYNC_BINDING_V2_OPERATOR = {
	contractVersion: 2,
	bindingId: AI_HERO_COURSE_SYNC_BINDING_V1.bindingId,
	sourceCourseId: AI_HERO_COURSE_SYNC_BINDING_V1.sourceCourseId,
	productId: AI_HERO_COURSE_SYNC_BINDING_V1.productId,
	anchorWorkshopId: AI_HERO_COURSE_SYNC_BINDING_V1.anchorWorkshopId,
	targetContract: {
		product: {
			type: 'self-paced',
			state: 'published',
			visibility: 'public',
		},
		workshop: {
			type: 'workshop',
			state: 'published',
			visibility: 'unlisted',
		},
		relation: { position: 0, exclusiveProduct: true },
	},
	managedChildContract: { state: 'draft', visibility: 'unlisted' },
	applyPolicy: 'operator',
	sectionMappingPolicy: 'sections-in-anchor-workshop',
	assetConnector: 'dropbox-shared-link',
	sharedLinkSecretRef: 'DROPBOX_SYNC_SHARED_LINK',
	status: 'active',
} as const

/**
 * The stored v3 value from before the Crash Course launch published the
 * anchor workshop. Only this exact literal may migrate to v4.
 */
export const AI_HERO_COURSE_SYNC_BINDING_V3_UNLISTED = {
	contractVersion: 3,
	bindingId: AI_HERO_COURSE_SYNC_BINDING_V1.bindingId,
	sourceCourseId: AI_HERO_COURSE_SYNC_BINDING_V1.sourceCourseId,
	productId: AI_HERO_COURSE_SYNC_BINDING_V1.productId,
	anchorWorkshopId: AI_HERO_COURSE_SYNC_BINDING_V1.anchorWorkshopId,
	targetContract: {
		product: {
			type: 'self-paced',
			state: 'published',
			visibility: 'public',
		},
		workshop: {
			type: 'workshop',
			state: 'published',
			visibility: 'unlisted',
		},
		relation: { position: 0, exclusiveProduct: true },
	},
	managedChildContract: { state: 'draft', visibility: 'unlisted' },
	applyPolicy: 'bounded-auto',
	sectionMappingPolicy: 'sections-in-anchor-workshop',
	assetConnector: 'dropbox-shared-link',
	sharedLinkSecretRef: 'DROPBOX_SYNC_SHARED_LINK',
	status: 'active',
} as const

/** Freeze every nested contract; `as const` alone does not protect runtime imports. */
function deepFreeze<T extends object>(value: T): T {
	for (const nested of Object.values(value)) {
		if (nested !== null && typeof nested === 'object') deepFreeze(nested)
	}
	return Object.freeze(value)
}

export const AI_HERO_COURSE_SYNC_BINDING = deepFreeze({
	contractVersion: 4,
	bindingId: AI_HERO_COURSE_SYNC_BINDING_V1.bindingId,
	sourceCourseId: AI_HERO_COURSE_SYNC_BINDING_V1.sourceCourseId,
	productId: AI_HERO_COURSE_SYNC_BINDING_V1.productId,
	anchorWorkshopId: AI_HERO_COURSE_SYNC_BINDING_V1.anchorWorkshopId,
	targetContract: {
		product: {
			type: 'self-paced',
			state: 'published',
			visibility: 'public',
		},
		workshop: {
			type: 'workshop',
			state: 'published',
			visibility: 'public',
		},
		relation: { position: 0, exclusiveProduct: true },
	},
	managedChildContract: { state: 'draft', visibility: 'unlisted' },
	applyPolicy: 'bounded-auto',
	sectionMappingPolicy: 'sections-in-anchor-workshop',
	assetConnector: 'dropbox-shared-link',
	sharedLinkSecretRef: 'DROPBOX_SYNC_SHARED_LINK',
	status: 'active',
} as const satisfies WorkshopCourseSyncBinding)

/** S5: production Cohort 005, with an operator gate on its first revision. */
export const AI_HERO_COURSE_SYNC_BINDING_COHORT_005 = deepFreeze({
	contractVersion: 5,
	bindingId: 'csb_ai_hero_cohort_005',
	status: 'active',
	sourceCourseId: '4cc62b33-db58-455d-83cb-94f680b119e4',
	productId: 'product-s00zs',
	anchorCohortId: 'cohort-xdy1m',
	targetContract: {
		product: { type: 'cohort', state: 'draft', visibility: 'unlisted' },
		cohort: { type: 'cohort', state: 'draft', visibility: 'unlisted' },
		relation: { position: 0, exclusiveProduct: true },
	},
	managedChildContract: {
		workshop: { state: 'draft', visibility: 'unlisted' },
		lesson: { state: 'draft', visibility: 'unlisted' },
	},
	applyPolicy: 'bounded-auto',
	initialApplyPolicyOverride: 'operator',
	sectionMappingPolicy: 'sections-as-cohort-workshops',
	sharedLinkSecretRef: 'DROPBOX_SYNC_SHARED_LINK_COHORT_005',
	assetConnector: 'dropbox-shared-link',
} as const satisfies CohortCourseSyncBinding)

export const COURSE_SYNC_BINDINGS = deepFreeze({
	[AI_HERO_COURSE_SYNC_BINDING.bindingId]: AI_HERO_COURSE_SYNC_BINDING,
	[AI_HERO_COURSE_SYNC_BINDING_COHORT_005.bindingId]:
		AI_HERO_COURSE_SYNC_BINDING_COHORT_005,
} as const satisfies Record<string, CourseSyncBinding>)

export function getServerCourseSyncBinding(
	bindingId: string,
	registry: Readonly<Record<string, CourseSyncBinding>> = COURSE_SYNC_BINDINGS,
): CourseSyncBinding {
	const binding = Object.hasOwn(registry, bindingId)
		? registry[bindingId]
		: undefined
	if (!binding) {
		throw new CourseSyncError(
			'BINDING_NOT_FOUND',
			'Sync binding not found.',
			404,
		)
	}
	return binding
}

export function activeCourseSyncBindings(): CourseSyncBinding[] {
	return Object.values(COURSE_SYNC_BINDINGS).filter(
		(binding) => binding.status === 'active',
	)
}

export type FrozenSourceAsset = {
	sourceVideoId: string
	relativePath: string
	providerRevision: string
	providerContentHash: string | null
	producerSha256: string
	bytes: number
	snapshotUri: string | null
	muxAssetId: string | null
	muxPlaybackId: string | null
	duration: number | null
	freezeEffects?: {
		sourceAssetsRead: number
		muxAssetsCreated: number
	}
}

export type SourceRevisionRecord = {
	sourceRevisionId: string
	bindingId: string
	courseVersionId: string
	providerRevision: string
	manifestSha256: string
	manifestSnapshotUri: string | null
	manifest: CourseJsonDocumentV3
	assets: ReadonlyArray<FrozenSourceAsset>
	stagedAt: Date
}

export type ResourcePlanItem = {
	sourceKind:
		| 'section'
		| 'workshop'
		| 'lesson'
		| 'solution'
		| 'question'
		| 'video'
	sourceId: string
	targetResourceId: string
	/**
	 * Present when the 2026-08-17 repair's manual `solution_*` resource is the
	 * physical target for a deterministic `sync_solution_*` lineage id.
	 */
	solutionAdoption?: {
		canonicalTargetResourceId: string
		baselineVersionId: string
		createBaselineVersion: boolean
	}
	parentResourceId: string
	position: number
	detached: boolean
	previousDetached: boolean
	previousParentResourceId: string | null
	previousPosition: number | null
	action: CourseSyncResourceAction
	fields: Record<string, unknown>
	previousVersionId: string | null
	previousFieldsSha256: string | null
}

export type MediaPlanItem = {
	sourceVideoId: string
	providerRevision: string
	sha256: string
	bytes: number
	action: 'update' | 'retain'
	muxAssetId: string
	muxPlaybackId: string
	duration: number
}

export type SyncPlan = {
	bindingId: string
	sourceRevisionId: string
	courseVersionId: string
	resources: ReadonlyArray<ResourcePlanItem>
	media: ReadonlyArray<MediaPlanItem>
	lessonRegressions?: ReadonlyArray<string>
	planSha256: string
}

export type SyncRunRecord = {
	runId: string
	bindingId: string
	sourceRevisionId: string
	courseVersionId: string
	state: CourseSyncRunState
	stageIdempotencyKey: string
	stageFingerprint: string
	applyIdempotencyKey: string | null
	rollbackOfRunId: string | null
	compensatingRunId: string | null
	plan: SyncPlan | null
	planSha256: string | null
	failureCode: string | null
	failureReason: string | null
	createdAt: Date
	updatedAt: Date
}

export type TargetResourceSnapshot = {
	resourceId: string
	currentVersionId: string | null
	fields: Record<string, unknown>
}

export type SolutionResourceAdoptionCandidate = {
	canonicalTargetResourceId: string
	lessonResourceId: string
	solutionVideoResourceId: string
	sourceLessonId: string
}

export type SolutionResourceAdoption = {
	canonicalTargetResourceId: string
	resourceId: string
	lessonResourceId: string
	solutionVideoResourceId: string
	currentVersionId: string | null
	fields: Record<string, unknown>
	position: number
}

export type ResolvedDropboxAsset = {
	providerRevision: string
	bytes: number
	stream: ReadableStream<Uint8Array>
}

export interface CourseSyncAssetReader {
	read(relativePath: string): Promise<ResolvedDropboxAsset>
}

export interface CourseSyncSnapshotStore {
	putManifest(input: {
		key: string
		bytes: Uint8Array
		sha256: string
	}): Promise<string>
	putAsset(input: {
		key: string
		stream: ReadableStream<Uint8Array>
		bytes: number
		sha256: string
	}): Promise<string>
}

export type CourseSyncMuxAsset = {
	id: string
	status: 'preparing' | 'ready' | 'errored'
	playbackId: string | null
	duration: number | null
}

export type CourseSyncMuxInput = {
	url: string
	passthrough: string
}

export interface CourseSyncMuxClient {
	getAsset(assetId: string): Promise<CourseSyncMuxAsset | null>
	createAsset(input: CourseSyncMuxInput): Promise<CourseSyncMuxAsset>
	waitForReady(assetId: string): Promise<CourseSyncMuxAsset>
}

export type DropboxMuxSource = {
	url: string
	providerRevision: string
	providerContentHash: string | null
	bytes: number
}

export interface CourseSyncMuxSourceResolver {
	resolve(input: {
		bindingId: string
		courseVersionId: string
		sourceVideoId: string
		relativePath: string
	}): Promise<DropboxMuxSource>
}

export interface CourseSyncPersistence {
	ensureBinding(binding: CourseSyncBinding): Promise<CourseSyncBinding>
	getBinding(bindingId: string): Promise<CourseSyncBinding | null>
	assertTarget(binding: CourseSyncBinding): Promise<void>
	findRunByStageKey(
		bindingId: string,
		key: string,
	): Promise<SyncRunRecord | null>
	findAppliedRunByRevision(
		bindingId: string,
		courseVersionId: string,
	): Promise<SyncRunRecord | null>
	findFrozenAsset(
		bindingId: string,
		producerSha256: string,
		bytes: number,
	): Promise<FrozenSourceAsset | null>
	findFrozenAssetReceipt(receiptKey: string): Promise<FrozenSourceAsset | null>
	saveFrozenAssetReceipt(input: {
		receiptKey: string
		bindingId: string
		courseVersionId: string
		asset: FrozenSourceAsset
	}): Promise<FrozenSourceAsset>
	createStaged(input: {
		revision: SourceRevisionRecord
		run: SyncRunRecord
	}): Promise<SyncRunRecord>
	getRun(runId: string): Promise<SyncRunRecord | null>
	getRevision(sourceRevisionId: string): Promise<SourceRevisionRecord | null>
	getLastAppliedRun(bindingId: string): Promise<SyncRunRecord | null>
	findSolutionResourceAdoptions(
		bindingId: string,
		candidates: ReadonlyArray<SolutionResourceAdoptionCandidate>,
	): Promise<ReadonlyMap<string, SolutionResourceAdoption>>
	getTargetResources(
		resourceIds: ReadonlyArray<string>,
	): Promise<ReadonlyMap<string, TargetResourceSnapshot>>
	savePreview(runId: string, plan: SyncPlan): Promise<SyncRunRecord>
	applyAtomically(input: {
		runId: string
		plan: SyncPlan
		idempotencyKey: string
		createdById: string
	}): Promise<SyncRunRecord>
	markFailed(
		runId: string,
		code: string,
		reason: string,
		applyIdempotencyKey: string,
	): Promise<SyncRunRecord>
	rollbackAtomically(input: {
		runId: string
		bindingId: string
		idempotencyKey: string
		compensatingRunId: string
		createdById: string
	}): Promise<SyncRunRecord>
}

export type CourseSyncControlPlaneDependencies = {
	/** Test-only injection; production always uses COURSE_SYNC_BINDINGS. */
	bindingRegistry?: Readonly<Record<string, CourseSyncBinding>>
	persistence: CourseSyncPersistence
	muxSourceResolver: CourseSyncMuxSourceResolver
	muxClient: CourseSyncMuxClient
	clock?: () => Date
	makeId?: (prefix: string) => string
	createdById: string
}
