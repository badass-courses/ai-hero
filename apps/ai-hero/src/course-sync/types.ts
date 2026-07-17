import type {
	CourseJsonDocumentV3,
	CourseSyncResourceAction,
	CourseSyncRunState,
} from '@ai-hero/course-sync-schema'

export const AI_HERO_DRAFT_SYNC_BINDING = {
	bindingId: 'csb_ai_coding_crash_course',
	sourceCourseId: '50385098-a712-486f-b777-1f76ef31e9e5',
	productId: 'product-ma254',
	anchorWorkshopId: 'workshop-2ozd9',
	productType: 'self-paced',
	requiredState: 'draft',
	requiredVisibility: 'unlisted',
	sectionMappingPolicy: 'two-sections-in-anchor-workshop',
	assetConnector: 'dropbox-shared-link',
	sharedLinkSecretRef: 'DROPBOX_SYNC_SHARED_LINK',
	status: 'active',
} as const satisfies CourseSyncBinding

export type CourseSyncBinding = {
	bindingId: string
	sourceCourseId: string
	productId: string
	anchorWorkshopId: string
	productType: 'self-paced'
	requiredState: 'draft'
	requiredVisibility: 'unlisted'
	sectionMappingPolicy: 'two-sections-in-anchor-workshop'
	assetConnector: 'dropbox-shared-link'
	sharedLinkSecretRef: 'DROPBOX_SYNC_SHARED_LINK'
	status: 'active' | 'suspended' | 'revoked'
}

export type FrozenSourceAsset = {
	sourceVideoId: string
	relativePath: string
	providerRevision: string
	producerSha256: string
	bytes: number
	snapshotUri: string
}

export type SourceRevisionRecord = {
	sourceRevisionId: string
	bindingId: string
	courseVersionId: string
	providerRevision: string
	manifestSha256: string
	manifestSnapshotUri: string
	manifest: CourseJsonDocumentV3
	assets: ReadonlyArray<FrozenSourceAsset>
	stagedAt: Date
}

export type ResourcePlanItem = {
	sourceKind: 'section' | 'lesson'
	sourceId: string
	targetResourceId: string
	parentResourceId: string
	position: number
	previousParentResourceId: string | null
	previousPosition: number | null
	action: CourseSyncResourceAction
	fields: Record<string, unknown>
	previousVersionId: string | null
}

export type MediaPlanItem = {
	sourceVideoId: string
	providerRevision: string
	sha256: string
	bytes: number
	action: 'update' | 'retain'
	snapshotUri: string
}

export type SyncPlan = {
	bindingId: string
	sourceRevisionId: string
	courseVersionId: string
	resources: ReadonlyArray<ResourcePlanItem>
	media: ReadonlyArray<MediaPlanItem>
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
	createStaged(input: {
		revision: SourceRevisionRecord
		run: SyncRunRecord
	}): Promise<SyncRunRecord>
	getRun(runId: string): Promise<SyncRunRecord | null>
	getRevision(sourceRevisionId: string): Promise<SourceRevisionRecord | null>
	getLastAppliedRun(bindingId: string): Promise<SyncRunRecord | null>
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
	): Promise<SyncRunRecord>
	rollbackAtomically(input: {
		runId: string
		idempotencyKey: string
		compensatingRunId: string
		createdById: string
	}): Promise<SyncRunRecord>
}

export type CourseSyncControlPlaneDependencies = {
	persistence: CourseSyncPersistence
	assetReader: CourseSyncAssetReader
	snapshotStore: CourseSyncSnapshotStore
	clock?: () => Date
	makeId?: (prefix: string) => string
	createdById: string
}
