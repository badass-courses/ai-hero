import { createHash, randomUUID } from 'node:crypto'
import {
	courseJsonVideos,
	decodeCourseJsonDocumentV3,
	type CourseJsonDocumentV3,
	type CourseSyncBindingSummary,
	type CourseSyncRunSummary,
} from '@ai-hero/course-sync-schema'

import { CourseSyncError, asCourseSyncError } from './errors'
import {
	AI_HERO_DRAFT_SYNC_BINDING,
	type CourseSyncBinding,
	type CourseSyncControlPlaneDependencies,
	type FrozenSourceAsset,
	type ResourcePlanItem,
	type SourceRevisionRecord,
	type SyncPlan,
	type SyncRunRecord,
} from './types'

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue)
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, nested]) => [key, stableValue(nested)]),
		)
	}
	return value
}

export function stableJson(value: unknown): string {
	return JSON.stringify(stableValue(value))
}

export function sha256(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex')
}

function targetResourceId(
	bindingId: string,
	kind: 'section' | 'lesson',
	sourceId: string,
): string {
	return `sync_${kind}_${sha256(`${bindingId}:${kind}:${sourceId}`).slice(0, 24)}`
}

function slug(sourceId: string, title: string): string {
	const readable = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 60)
	return `${readable || 'course-content'}-${sha256(sourceId).slice(0, 8)}`
}

async function hashStream(stream: ReadableStream<Uint8Array>) {
	const hash = createHash('sha256')
	let bytes = 0
	const reader = stream.getReader()
	for (;;) {
		const chunk = await reader.read()
		if (chunk.done) break
		hash.update(chunk.value)
		bytes += chunk.value.byteLength
	}
	return { sha256: hash.digest('hex'), bytes }
}

function assertManifestScope(
	binding: CourseSyncBinding,
	manifest: CourseJsonDocumentV3,
) {
	if (manifest.courseId !== binding.sourceCourseId) {
		throw new CourseSyncError(
			'SOURCE_COURSE_MISMATCH',
			'The source course does not match the immutable binding.',
			409,
		)
	}
	if (manifest.sections.length === 0) {
		throw new CourseSyncError(
			'SOURCE_SECTIONS_EMPTY',
			'The bound source must contain at least one section.',
			409,
		)
	}
	const videos = courseJsonVideos(manifest)
	if (videos.length === 0) {
		throw new CourseSyncError(
			'SOURCE_VIDEOS_EMPTY',
			'The bound source must contain at least one video.',
			409,
		)
	}
	const unique = (values: ReadonlyArray<string>, label: string) => {
		if (new Set(values).size !== values.length) {
			throw new CourseSyncError(
				`DUPLICATE_SOURCE_${label.toUpperCase()}_ID`,
				`The manifest contains duplicate ${label} lineage IDs.`,
			)
		}
	}
	unique(
		manifest.sections.map((section) => section.id),
		'section',
	)
	unique(
		manifest.sections.flatMap((section) =>
			section.lessons.map((lesson) => lesson.id),
		),
		'lesson',
	)
	unique(
		videos.map((video) => video.id),
		'video',
	)
	for (const video of videos) {
		if (!video.body.trim()) {
			throw new CourseSyncError(
				'MISSING_VIDEO_BODY',
				`Video ${video.id} has no readable body value.`,
			)
		}
	}
}

function publicBinding(binding: CourseSyncBinding): CourseSyncBindingSummary {
	return {
		bindingId: binding.bindingId,
		status: binding.status,
		sourceCourseId: binding.sourceCourseId,
		target: {
			productType: binding.productType,
			anchorResourceType: 'workshop',
			requiredState: binding.requiredState,
			requiredVisibility: binding.requiredVisibility,
			sectionMappingPolicy: binding.sectionMappingPolicy,
		},
	}
}

function publicRun(run: SyncRunRecord, noOp = false): CourseSyncRunSummary {
	const counts = { create: 0, update: 0, retain: 0 }
	for (const resource of run.plan?.resources ?? []) counts[resource.action] += 1
	return {
		runId: run.runId,
		bindingId: run.bindingId,
		courseVersionId: run.courseVersionId,
		state: run.state,
		planSha256: run.planSha256,
		noOp,
		failureCode: run.failureCode,
		plan: run.plan
			? {
					resources: run.plan.resources.map((item) => ({
						sourceKind: item.sourceKind,
						sourceId: item.sourceId,
						action: item.action,
						position: item.position,
					})),
					media: run.plan.media.map((item) => ({
						sourceVideoId: item.sourceVideoId,
						action: item.action,
					})),
				}
			: null,
		resourceCounts: counts,
	}
}

function sourceResourceFields(
	binding: CourseSyncBinding,
	manifest: CourseJsonDocumentV3,
): Array<
	Omit<
		ResourcePlanItem,
		| 'action'
		| 'previousVersionId'
		| 'previousParentResourceId'
		| 'previousPosition'
	>
> {
	return manifest.sections.flatMap((section, sectionIndex) => {
		const sectionId = targetResourceId(binding.bindingId, 'section', section.id)
		const sectionItem = {
			sourceKind: 'section' as const,
			sourceId: section.id,
			targetResourceId: sectionId,
			parentResourceId: binding.anchorWorkshopId,
			position: sectionIndex,
			fields: {
				title: section.title,
				slug: slug(section.id, section.title),
				state: 'draft',
				visibility: 'unlisted',
				courseSync: {
					bindingId: binding.bindingId,
					sourceCourseId: manifest.courseId,
					sourceSectionId: section.id,
				},
			},
		}
		const lessonItems = section.lessons.map((lesson, lessonIndex) => {
			const videos =
				lesson.type === 'explainer'
					? [lesson.explainer]
					: [lesson.problem, ...(lesson.solution ? [lesson.solution] : [])]
			const primary = videos[0]
			if (!primary) {
				throw new CourseSyncError(
					'SOURCE_LESSON_VIDEO_MISSING',
					`Lesson ${lesson.id} has no importable video.`,
				)
			}
			return {
				sourceKind: 'lesson' as const,
				sourceId: lesson.id,
				targetResourceId: targetResourceId(
					binding.bindingId,
					'lesson',
					lesson.id,
				),
				parentResourceId: sectionId,
				position: lessonIndex,
				fields: {
					title: lesson.title,
					slug: slug(lesson.id, lesson.title),
					body: primary.body,
					description: primary.description,
					state: 'draft',
					visibility: 'unlisted',
					courseSync: {
						bindingId: binding.bindingId,
						sourceCourseId: manifest.courseId,
						sourceSectionId: section.id,
						sourceLessonId: lesson.id,
						lessonType: lesson.type,
						videos: videos.map((video) => ({
							sourceVideoId: video.id,
							sha256: video.sha256,
							bytes: video.bytes,
							exportFingerprint: video.hash,
							chapters: video.chapters,
						})),
					},
				},
			}
		})
		return [sectionItem, ...lessonItems]
	})
}

export function createCourseSyncControlPlane(
	dependencies: CourseSyncControlPlaneDependencies,
) {
	const clock = dependencies.clock ?? (() => new Date())
	const makeId =
		dependencies.makeId ?? ((prefix: string) => `${prefix}_${randomUUID()}`)
	const persistence = dependencies.persistence

	const requireBinding = async (bindingId: string) => {
		if (bindingId !== AI_HERO_DRAFT_SYNC_BINDING.bindingId) {
			throw new CourseSyncError(
				'BINDING_NOT_FOUND',
				'Sync binding not found.',
				404,
			)
		}
		await persistence.assertTarget(AI_HERO_DRAFT_SYNC_BINDING)
		const binding = await persistence.ensureBinding(AI_HERO_DRAFT_SYNC_BINDING)
		if (binding.status !== 'active') {
			throw new CourseSyncError(
				'BINDING_NOT_ACTIVE',
				'Sync binding is not active.',
				409,
			)
		}
		return binding
	}

	return {
		async getBinding(bindingId: string) {
			return publicBinding(await requireBinding(bindingId))
		},

		async getRun(runId: string) {
			const run = await persistence.getRun(runId)
			if (!run)
				throw new CourseSyncError('RUN_NOT_FOUND', 'Sync run not found.', 404)
			await requireBinding(run.bindingId)
			return publicRun(run)
		},

		async stage(input: {
			bindingId: string
			idempotencyKey: string
			manifest: unknown
		}) {
			if (!input.idempotencyKey.trim()) {
				throw new CourseSyncError(
					'IDEMPOTENCY_KEY_REQUIRED',
					'Idempotency-Key is required.',
				)
			}
			const binding = await requireBinding(input.bindingId)

			let manifest: CourseJsonDocumentV3
			try {
				manifest = decodeCourseJsonDocumentV3(input.manifest)
			} catch (error) {
				throw new CourseSyncError(
					'INVALID_V3_MANIFEST',
					error instanceof Error
						? error.message
						: 'Manifest validation failed.',
				)
			}
			assertManifestScope(binding, manifest)
			const manifestBytes = new TextEncoder().encode(stableJson(manifest))
			const manifestSha256 = sha256(manifestBytes)
			const stageFingerprint = sha256(
				stableJson({ bindingId: binding.bindingId, manifestSha256 }),
			)

			const keyedRun = await persistence.findRunByStageKey(
				binding.bindingId,
				input.idempotencyKey,
			)
			if (keyedRun) {
				if (keyedRun.stageFingerprint !== stageFingerprint) {
					throw new CourseSyncError(
						'IDEMPOTENCY_CONFLICT',
						'The idempotency key was already used for different stage input.',
						409,
					)
				}
				return publicRun(keyedRun, true)
			}

			const applied = await persistence.findAppliedRunByRevision(
				binding.bindingId,
				manifest.courseVersionId,
			)
			if (applied) {
				if (applied.stageFingerprint !== stageFingerprint) {
					throw new CourseSyncError(
						'IMMUTABLE_REVISION_CONFLICT',
						'The courseVersionId was already applied with different bytes.',
						409,
					)
				}
				return publicRun(applied, true)
			}

			const sourceRevisionId = makeId('csr')
			const runId = makeId('csr_run')
			const manifestSnapshotUri = await dependencies.snapshotStore.putManifest({
				key: `${binding.bindingId}/${manifest.courseVersionId}/course.json`,
				bytes: manifestBytes,
				sha256: manifestSha256,
			})
			const frozenAssets: FrozenSourceAsset[] = []
			for (const video of courseJsonVideos(manifest)) {
				const resolved = await dependencies.assetReader.read(video.relativePath)
				if (!resolved.providerRevision) {
					throw new CourseSyncError(
						'DROPBOX_REVISION_MISSING',
						`Dropbox did not return a revision for video ${video.id}.`,
					)
				}
				if (resolved.bytes !== video.bytes) {
					throw new CourseSyncError(
						'VIDEO_BYTE_COUNT_MISMATCH',
						`Dropbox byte count did not match the producer receipt for video ${video.id}.`,
					)
				}
				const [hashBranch, snapshotBranch] = resolved.stream.tee()
				const snapshotPromise = dependencies.snapshotStore.putAsset({
					key: `${binding.bindingId}/${manifest.courseVersionId}/${video.id}/${resolved.providerRevision}.mp4`,
					stream: snapshotBranch,
					bytes: video.bytes,
					sha256: video.sha256,
				})
				const [observed, snapshotUri] = await Promise.all([
					hashStream(hashBranch),
					snapshotPromise,
				])
				if (
					observed.bytes !== video.bytes ||
					observed.sha256 !== video.sha256
				) {
					throw new CourseSyncError(
						'VIDEO_SHA256_MISMATCH',
						`Streamed Dropbox bytes did not match the producer receipt for video ${video.id}.`,
					)
				}
				frozenAssets.push({
					sourceVideoId: video.id,
					relativePath: video.relativePath,
					providerRevision: resolved.providerRevision,
					producerSha256: video.sha256,
					bytes: video.bytes,
					snapshotUri,
				})
			}

			const now = clock()
			const revision: SourceRevisionRecord = {
				sourceRevisionId,
				bindingId: binding.bindingId,
				courseVersionId: manifest.courseVersionId,
				providerRevision: manifest.courseVersionId,
				manifestSha256,
				manifestSnapshotUri,
				manifest,
				assets: frozenAssets,
				stagedAt: now,
			}
			const run: SyncRunRecord = {
				runId,
				bindingId: binding.bindingId,
				sourceRevisionId,
				courseVersionId: manifest.courseVersionId,
				state: 'staged',
				stageIdempotencyKey: input.idempotencyKey,
				stageFingerprint,
				applyIdempotencyKey: null,
				rollbackOfRunId: null,
				compensatingRunId: null,
				plan: null,
				planSha256: null,
				failureCode: null,
				failureReason: null,
				createdAt: now,
				updatedAt: now,
			}
			return publicRun(await persistence.createStaged({ revision, run }))
		},

		async preview(runId: string) {
			const run = await persistence.getRun(runId)
			if (!run)
				throw new CourseSyncError('RUN_NOT_FOUND', 'Sync run not found.', 404)
			if (run.state === 'previewed' || run.state === 'applied')
				return publicRun(run, true)
			if (run.state !== 'staged') {
				throw new CourseSyncError(
					'INVALID_RUN_STATE',
					'Only a staged run can be previewed.',
					409,
				)
			}
			const binding = await requireBinding(run.bindingId)
			const revision = await persistence.getRevision(run.sourceRevisionId)
			if (!revision)
				throw new CourseSyncError(
					'REVISION_NOT_FOUND',
					'Source revision not found.',
					500,
				)
			const previousRun = await persistence.getLastAppliedRun(binding.bindingId)
			const previousByTarget = new Map(
				(previousRun?.plan?.resources ?? []).map((item) => [
					item.targetResourceId,
					item,
				]),
			)
			const desired = sourceResourceFields(binding, revision.manifest)
			const snapshots = await persistence.getTargetResources(
				desired.map((item) => item.targetResourceId),
			)
			const resources: ResourcePlanItem[] = desired.map((item) => {
				const previous = previousByTarget.get(item.targetResourceId)
				const snapshot = snapshots.get(item.targetResourceId)
				const action = !snapshot
					? 'create'
					: !previous ||
						  stableJson(previous.fields) !== stableJson(item.fields) ||
						  stableJson(snapshot.fields) !== stableJson(item.fields) ||
						  previous.parentResourceId !== item.parentResourceId ||
						  previous.position !== item.position
						? 'update'
						: 'retain'
				return {
					...item,
					action,
					previousVersionId: snapshot?.currentVersionId ?? null,
					previousParentResourceId: previous?.parentResourceId ?? null,
					previousPosition: previous?.position ?? null,
				}
			})
			const previousRevision = previousRun
				? await persistence.getRevision(previousRun.sourceRevisionId)
				: null
			const previousAssets = new Map(
				(previousRevision?.assets ?? []).map((asset) => [
					asset.sourceVideoId,
					asset,
				]),
			)
			const media = revision.assets.map((asset) => {
				const previous = previousAssets.get(asset.sourceVideoId)
				return {
					sourceVideoId: asset.sourceVideoId,
					providerRevision: asset.providerRevision,
					sha256: asset.producerSha256,
					bytes: asset.bytes,
					action:
						previous?.producerSha256 === asset.producerSha256 &&
						previous.providerRevision === asset.providerRevision
							? ('retain' as const)
							: ('update' as const),
					snapshotUri: asset.snapshotUri,
				}
			})
			const planInput = {
				bindingId: binding.bindingId,
				sourceRevisionId: revision.sourceRevisionId,
				courseVersionId: revision.courseVersionId,
				resources,
				media,
			}
			const plan: SyncPlan = {
				...planInput,
				planSha256: sha256(stableJson(planInput)),
			}
			return publicRun(await persistence.savePreview(runId, plan))
		},

		async apply(input: { runId: string; idempotencyKey: string }) {
			if (!input.idempotencyKey.trim()) {
				throw new CourseSyncError(
					'IDEMPOTENCY_KEY_REQUIRED',
					'Idempotency-Key is required.',
				)
			}
			const run = await persistence.getRun(input.runId)
			if (!run)
				throw new CourseSyncError('RUN_NOT_FOUND', 'Sync run not found.', 404)
			if (run.state === 'applied') {
				if (run.applyIdempotencyKey !== input.idempotencyKey) {
					throw new CourseSyncError(
						'IDEMPOTENCY_CONFLICT',
						'Apply already completed with another key.',
						409,
					)
				}
				return publicRun(run, true)
			}
			if (run.state !== 'previewed' || !run.plan) {
				throw new CourseSyncError(
					'INVALID_RUN_STATE',
					'Only a previewed run can be applied.',
					409,
				)
			}
			await requireBinding(run.bindingId)
			try {
				return publicRun(
					await persistence.applyAtomically({
						runId: run.runId,
						plan: run.plan,
						idempotencyKey: input.idempotencyKey,
						createdById: dependencies.createdById,
					}),
				)
			} catch (error) {
				const failure = asCourseSyncError(error)
				await persistence.markFailed(run.runId, failure.code, failure.message)
				throw failure
			}
		},

		async rollback(input: { runId: string; idempotencyKey: string }) {
			if (!input.idempotencyKey.trim()) {
				throw new CourseSyncError(
					'IDEMPOTENCY_KEY_REQUIRED',
					'Idempotency-Key is required.',
				)
			}
			const run = await persistence.getRun(input.runId)
			if (!run)
				throw new CourseSyncError('RUN_NOT_FOUND', 'Sync run not found.', 404)
			if (run.state === 'rolled_back') return publicRun(run, true)
			if (run.state !== 'applied') {
				throw new CourseSyncError(
					'INVALID_RUN_STATE',
					'Only an applied run can be rolled back.',
					409,
				)
			}
			await requireBinding(run.bindingId)
			return publicRun(
				await persistence.rollbackAtomically({
					runId: run.runId,
					idempotencyKey: input.idempotencyKey,
					compensatingRunId: makeId('csr_run'),
					createdById: dependencies.createdById,
				}),
			)
		},
	}
}
