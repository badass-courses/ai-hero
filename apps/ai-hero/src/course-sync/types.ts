import type {
	CourseJsonDocumentV3,
	CourseSyncResourceAction,
	CourseSyncRunState,
} from '@ai-hero/course-sync-schema'

export type CourseSyncBinding = {
	contractVersion: 2
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
			visibility: 'unlisted'
		}
		relation: { position: 0; exclusiveProduct: true }
	}
	managedChildContract: {
		state: 'draft'
		visibility: 'unlisted'
	}
	applyPolicy: 'auto' | 'operator'
	sectionMappingPolicy: 'sections-in-anchor-workshop'
	assetConnector: 'dropbox-shared-link'
	sharedLinkSecretRef: 'DROPBOX_SYNC_SHARED_LINK'
	status: 'active' | 'suspended' | 'revoked'
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

export const AI_HERO_COURSE_SYNC_BINDING = {
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
} as const satisfies CourseSyncBinding

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
	sourceKind: 'section' | 'lesson' | 'question' | 'video'
	sourceId: string
	targetResourceId: string
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
	persistence: CourseSyncPersistence
	muxSourceResolver: CourseSyncMuxSourceResolver
	muxClient: CourseSyncMuxClient
	clock?: () => Date
	makeId?: (prefix: string) => string
	createdById: string
}
