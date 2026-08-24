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
	assertCourseSyncLaunchApplyPolicy,
	evaluateCourseSyncBoundedAutoApply,
} from './persistence-invariants'
import { extractQuizQuestions } from './quiz-question-extraction'
import {
	AI_HERO_COURSE_SYNC_BINDING,
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

export function courseSyncRollbackStageIdempotencyKey(
	runId: string,
	idempotencyKey: string,
): string {
	return sha256(stableJson({ operation: 'rollback', runId, idempotencyKey }))
}

export function targetResourceId(
	bindingId: string,
	kind: 'section' | 'lesson' | 'solution' | 'question' | 'video',
	sourceId: string,
): string {
	return `sync_${kind}_${sha256(`${bindingId}:${kind}:${sourceId}`).slice(0, 24)}`
}

function slugifyTitle(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 60) || 'course-content'
	)
}

function slug(sourceId: string, title: string): string {
	return `${slugifyTitle(title)}-${sha256(sourceId).slice(0, 8)}`
}

function solutionSlug(sourceId: string, title: string): string {
	return `${slugifyTitle(title)}~${sha256(`solution:${sourceId}`).slice(0, 12)}`
}

export function solutionAdoptionBaselineVersionId(
	resourceId: string,
	fields: Record<string, unknown>,
): string {
	return `version~${sha256(
		stableJson({ operation: 'adopt-course-sync-solution', resourceId, fields }),
	)}`
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
	const questionLessons = new Map<string, string>()
	for (const section of manifest.sections) {
		for (const lesson of section.lessons) {
			const primary =
				lesson.type === 'explainer' ? lesson.explainer : lesson.problem
			for (const question of extractQuizQuestions(primary.body, lesson.id)) {
				const firstLessonId = questionLessons.get(question.id)
				if (firstLessonId) {
					throw new CourseSyncError(
						'DUPLICATE_QUIZ_QUESTION_ID',
						`Lesson ${lesson.id} has duplicate QuizQuestion id ${question.id}; first used in lesson ${firstLessonId}.`,
					)
				}
				questionLessons.set(question.id, lesson.id)
			}
		}
	}
}

function publicBinding(binding: CourseSyncBinding): CourseSyncBindingSummary {
	return {
		bindingId: binding.bindingId,
		contractVersion: binding.contractVersion,
		status: binding.status,
		sourceCourseId: binding.sourceCourseId,
		applyPolicy: binding.applyPolicy,
		target: {
			product: binding.targetContract.product,
			workshop: binding.targetContract.workshop,
			managedChildren: binding.managedChildContract,
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
					resources: run.plan.resources
						.filter(
							(item) =>
								item.sourceKind === 'section' || item.sourceKind === 'lesson',
						)
						.map((item) => ({
							sourceKind: item.sourceKind as 'section' | 'lesson',
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
	frozenAssets: ReadonlyArray<FrozenSourceAsset>,
): Array<
	Omit<
		ResourcePlanItem,
		| 'action'
		| 'previousVersionId'
		| 'previousFieldsSha256'
		| 'previousParentResourceId'
		| 'previousPosition'
	>
> {
	const frozenByVideo = new Map(
		frozenAssets.map((asset) => [asset.sourceVideoId, asset] as const),
	)
	return manifest.sections.flatMap((section, sectionIndex) => {
		const sectionId = targetResourceId(binding.bindingId, 'section', section.id)
		const sectionItem = {
			sourceKind: 'section' as const,
			sourceId: section.id,
			targetResourceId: sectionId,
			parentResourceId: binding.anchorWorkshopId,
			position: sectionIndex,
			detached: false,
			previousDetached: false,
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
		const lessonItems = section.lessons.flatMap((lesson, lessonIndex) => {
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
			const lessonId = targetResourceId(binding.bindingId, 'lesson', lesson.id)
			const solutionId =
				lesson.type === 'problem' && lesson.solution
					? targetResourceId(binding.bindingId, 'solution', lesson.id)
					: null
			const lessonItem = {
				sourceKind: 'lesson' as const,
				sourceId: lesson.id,
				targetResourceId: lessonId,
				parentResourceId: sectionId,
				position: lessonIndex,
				detached: false,
				previousDetached: false,
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
			const videoItems = videos.map((video, videoIndex) => {
				const asset = frozenByVideo.get(video.id)
				if (
					!asset?.muxAssetId ||
					!asset.muxPlaybackId ||
					asset.duration === null
				) {
					throw new CourseSyncError(
						'FROZEN_MUX_ASSET_MISSING',
						`Frozen Mux asset is missing for video ${video.id}.`,
					)
				}
				const isSolutionVideo = videoIndex === 1 && solutionId !== null
				return {
					sourceKind: 'video' as const,
					sourceId: video.id,
					targetResourceId: targetResourceId(
						binding.bindingId,
						'video',
						video.id,
					),
					parentResourceId: isSolutionVideo ? solutionId : lessonId,
					position: 0,
					detached: false,
					previousDetached: false,
					fields: {
						title:
							videos.length === 1
								? lesson.title
								: `${lesson.title} ${videoIndex + 1}`,
						state: 'ready',
						visibility: 'unlisted',
						duration: asset.duration,
						muxAssetId: asset.muxAssetId,
						muxPlaybackId: asset.muxPlaybackId,
						chapters: video.chapters,
						courseSync: {
							bindingId: binding.bindingId,
							sourceCourseId: manifest.courseId,
							sourceSectionId: section.id,
							sourceLessonId: lesson.id,
							sourceVideoId: video.id,
							producerSha256: video.sha256,
							providerRevision: asset.providerRevision,
						},
					},
				}
			})
			const primaryVideoItem = videoItems[0]
			if (!primaryVideoItem) {
				throw new CourseSyncError(
					'SOURCE_LESSON_VIDEO_MISSING',
					`Lesson ${lesson.id} has no managed primary video.`,
				)
			}
			const solutionItem =
				lesson.type === 'problem' && lesson.solution && solutionId
					? {
							sourceKind: 'solution' as const,
							sourceId: lesson.id,
							targetResourceId: solutionId,
							parentResourceId: lessonId,
							position: 0,
							detached: false,
							previousDetached: false,
							fields: {
								title: `${lesson.title} Solution`,
								body: lesson.solution.body || '',
								slug: solutionSlug(lesson.id, `${lesson.title} Solution`),
								description: lesson.solution.description || '',
								state: 'draft',
								visibility: 'unlisted',
								videoResourceId: videoItems[1]?.targetResourceId,
								optional: false,
								courseSync: {
									bindingId: binding.bindingId,
									sourceCourseId: manifest.courseId,
									sourceSectionId: section.id,
									sourceLessonId: lesson.id,
									sourceVideoId: lesson.solution.id,
								},
							},
						}
					: null
			const questionItems = extractQuizQuestions(primary.body, lesson.id).map(
				(question) => ({
					sourceKind: 'question' as const,
					sourceId: question.id,
					targetResourceId: targetResourceId(
						binding.bindingId,
						'question',
						question.id,
					),
					parentResourceId: lessonId,
					position: question.position,
					detached: false,
					previousDetached: false,
					fields: {
						...question.fields,
						state: 'draft',
						visibility: 'unlisted',
						courseSync: {
							bindingId: binding.bindingId,
							sourceCourseId: manifest.courseId,
							sourceSectionId: section.id,
							sourceLessonId: lesson.id,
							sourceQuestionId: question.id,
						},
					},
				}),
			)
			return [
				lessonItem,
				primaryVideoItem,
				...(solutionItem && videoItems[1] ? [solutionItem, videoItems[1]] : []),
				...questionItems,
			]
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

	const assertServerBindingId = (bindingId: string) => {
		if (bindingId !== AI_HERO_COURSE_SYNC_BINDING.bindingId) {
			throw new CourseSyncError(
				'BINDING_NOT_FOUND',
				'Sync binding not found.',
				404,
			)
		}
	}

	const ensureServerBinding = async (bindingId: string) => {
		assertServerBindingId(bindingId)
		return persistence.ensureBinding(AI_HERO_COURSE_SYNC_BINDING)
	}

	const requireBinding = async (bindingId: string) => {
		assertServerBindingId(bindingId)
		await persistence.assertTarget(AI_HERO_COURSE_SYNC_BINDING)
		const binding = await persistence.ensureBinding(AI_HERO_COURSE_SYNC_BINDING)
		if (binding.status !== 'active') {
			throw new CourseSyncError(
				'BINDING_NOT_ACTIVE',
				'Sync binding is not active.',
				409,
			)
		}
		return binding
	}

	const decodeManifest = (
		binding: CourseSyncBinding,
		input: unknown,
	): CourseJsonDocumentV3 => {
		let manifest: CourseJsonDocumentV3
		try {
			manifest = decodeCourseJsonDocumentV3(input)
		} catch (error) {
			throw new CourseSyncError(
				'INVALID_V3_MANIFEST',
				error instanceof Error ? error.message : 'Manifest validation failed.',
			)
		}
		assertManifestScope(binding, manifest)
		return manifest
	}

	const freezeVideo = async (
		binding: CourseSyncBinding,
		manifest: CourseJsonDocumentV3,
		video: ReturnType<typeof courseJsonVideos>[number],
	): Promise<FrozenSourceAsset> => {
		const receiptKey = sha256(
			stableJson({
				bindingId: binding.bindingId,
				courseVersionId: manifest.courseVersionId,
				sourceVideoId: video.id,
				producerSha256: video.sha256,
				bytes: video.bytes,
			}),
		)
		const exactReceipt = await persistence.findFrozenAssetReceipt(receiptKey)
		const reusable =
			exactReceipt ??
			(await persistence.findFrozenAsset(
				binding.bindingId,
				video.sha256,
				video.bytes,
			))
		if (reusable?.muxAssetId) {
			const existingMuxAsset = await dependencies.muxClient.getAsset(
				reusable.muxAssetId,
			)
			if (!existingMuxAsset || existingMuxAsset.status === 'errored') {
				if (exactReceipt) {
					throw new CourseSyncError(
						'MUX_RECEIPT_ASSET_UNAVAILABLE',
						`The receipted Mux asset ${reusable.muxAssetId} is unavailable.`,
						502,
						{ category: 'transient_dependency', retryable: true },
					)
				}
			} else {
				const ready =
					existingMuxAsset.status === 'ready'
						? existingMuxAsset
						: await dependencies.muxClient.waitForReady(existingMuxAsset.id)
				if (!ready.playbackId || ready.duration === null) {
					throw new CourseSyncError(
						'MUX_READY_ASSET_INCOMPLETE',
						`Mux asset ${ready.id} is ready without playback metadata.`,
						502,
					)
				}
				const completed = await persistence.saveFrozenAssetReceipt({
					receiptKey,
					bindingId: binding.bindingId,
					courseVersionId: manifest.courseVersionId,
					asset: {
						...reusable,
						sourceVideoId: video.id,
						relativePath: video.relativePath,
						producerSha256: video.sha256,
						bytes: video.bytes,
						muxPlaybackId: ready.playbackId,
						duration: ready.duration,
					},
				})
				return {
					...completed,
					freezeEffects: { sourceAssetsRead: 0, muxAssetsCreated: 0 },
				}
			}
		}

		const source = await dependencies.muxSourceResolver.resolve({
			bindingId: binding.bindingId,
			courseVersionId: manifest.courseVersionId,
			sourceVideoId: video.id,
			relativePath: video.relativePath,
		})
		if (source.bytes !== video.bytes) {
			throw new CourseSyncError(
				'VIDEO_BYTE_COUNT_MISMATCH',
				`Dropbox byte count did not match the producer receipt for video ${video.id}.`,
				409,
				{
					category: 'source_validation',
					retryable: false,
					details: {
						sourceVideoId: video.id,
						expectedBytes: video.bytes,
						actualBytes: source.bytes,
					},
				},
			)
		}
		const passthrough = JSON.stringify({
			b: binding.bindingId,
			c: manifest.courseVersionId,
			v: video.id,
			s: video.sha256,
		})
		if (passthrough.length > 255) {
			throw new CourseSyncError(
				'MUX_PASSTHROUGH_TOO_LONG',
				`Mux passthrough metadata exceeded 255 characters for video ${video.id}.`,
			)
		}
		const created = await dependencies.muxClient.createAsset({
			url: source.url,
			passthrough,
		})
		const provisional = await persistence.saveFrozenAssetReceipt({
			receiptKey,
			bindingId: binding.bindingId,
			courseVersionId: manifest.courseVersionId,
			asset: {
				sourceVideoId: video.id,
				relativePath: video.relativePath,
				providerRevision: source.providerRevision,
				providerContentHash: source.providerContentHash,
				producerSha256: video.sha256,
				bytes: video.bytes,
				snapshotUri: null,
				muxAssetId: created.id,
				muxPlaybackId: created.playbackId,
				duration: created.duration,
			},
		})
		const provisionalMuxAsset =
			provisional.muxAssetId === created.id
				? created
				: await dependencies.muxClient.getAsset(provisional.muxAssetId!)
		if (!provisionalMuxAsset || provisionalMuxAsset.status === 'errored') {
			throw new CourseSyncError(
				'MUX_RECEIPT_ASSET_UNAVAILABLE',
				'The deterministic Mux receipt points to an unavailable asset.',
				502,
				{ category: 'transient_dependency', retryable: true },
			)
		}
		const ready =
			provisionalMuxAsset.status === 'ready'
				? provisionalMuxAsset
				: await dependencies.muxClient.waitForReady(provisionalMuxAsset.id)
		if (!ready.playbackId || ready.duration === null) {
			throw new CourseSyncError(
				'MUX_READY_ASSET_INCOMPLETE',
				`Mux asset ${ready.id} is ready without playback metadata.`,
				502,
			)
		}
		const completed = await persistence.saveFrozenAssetReceipt({
			receiptKey,
			bindingId: binding.bindingId,
			courseVersionId: manifest.courseVersionId,
			asset: {
				...provisional,
				muxAssetId: ready.id,
				muxPlaybackId: ready.playbackId,
				duration: ready.duration,
			},
		})
		return {
			...completed,
			freezeEffects: { sourceAssetsRead: 1, muxAssetsCreated: 1 },
		}
	}

	const stageRevision = async (input: {
		bindingId: string
		idempotencyKey: string
		manifest: unknown
		providerRevision?: string
		frozenAssets?: ReadonlyArray<FrozenSourceAsset>
	}) => {
		if (!input.idempotencyKey.trim()) {
			throw new CourseSyncError(
				'IDEMPOTENCY_KEY_REQUIRED',
				'Idempotency-Key is required.',
			)
		}
		const binding = await requireBinding(input.bindingId)
		const manifest = decodeManifest(binding, input.manifest)
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

		const videos = courseJsonVideos(manifest)
		const frozenAssets = input.frozenAssets
			? [...input.frozenAssets]
			: await Promise.all(
					videos.map((video) => freezeVideo(binding, manifest, video)),
				)
		if (frozenAssets.length !== videos.length) {
			throw new CourseSyncError(
				'FROZEN_ASSET_SET_INCOMPLETE',
				'Pre-frozen assets do not cover every manifest video.',
			)
		}
		const frozenByVideo = new Map(
			frozenAssets.map((asset) => [asset.sourceVideoId, asset] as const),
		)
		if (frozenByVideo.size !== frozenAssets.length) {
			throw new CourseSyncError(
				'DUPLICATE_FROZEN_ASSET',
				'Pre-frozen assets contain duplicate video IDs.',
			)
		}
		for (const video of videos) {
			const asset = frozenByVideo.get(video.id)
			if (
				!asset ||
				asset.relativePath !== video.relativePath ||
				asset.producerSha256 !== video.sha256 ||
				asset.bytes !== video.bytes ||
				!asset.providerRevision ||
				!asset.muxAssetId ||
				!asset.muxPlaybackId ||
				asset.duration === null
			) {
				throw new CourseSyncError(
					'FROZEN_ASSET_RECEIPT_MISMATCH',
					`Pre-frozen asset receipt does not match video ${video.id}.`,
				)
			}
		}

		const sourceRevisionId = makeId('csr')
		const runId = makeId('csr_run')
		const now = clock()
		const revision: SourceRevisionRecord = {
			sourceRevisionId,
			bindingId: binding.bindingId,
			courseVersionId: manifest.courseVersionId,
			providerRevision:
				input.providerRevision?.trim() || manifest.courseVersionId,
			manifestSha256,
			manifestSnapshotUri: null,
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
	}

	return {
		async ensureBinding(bindingId: string) {
			return publicBinding(await ensureServerBinding(bindingId))
		},

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

		async freezeAsset(input: {
			bindingId: string
			manifest: unknown
			sourceVideoId: string
		}) {
			const binding = await requireBinding(input.bindingId)
			const manifest = decodeManifest(binding, input.manifest)
			const video = courseJsonVideos(manifest).find(
				(candidate) => candidate.id === input.sourceVideoId,
			)
			if (!video) {
				throw new CourseSyncError(
					'SOURCE_VIDEO_NOT_FOUND',
					`Manifest video ${input.sourceVideoId} was not found.`,
					404,
				)
			}
			return freezeVideo(binding, manifest, video)
		},

		stage(input: {
			bindingId: string
			idempotencyKey: string
			manifest: unknown
			providerRevision?: string
		}) {
			return stageRevision(input)
		},

		stageFrozen(input: {
			bindingId: string
			idempotencyKey: string
			manifest: unknown
			providerRevision?: string
			frozenAssets: ReadonlyArray<FrozenSourceAsset>
		}) {
			return stageRevision(input)
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
			const canonicalDesired = sourceResourceFields(
				binding,
				revision.manifest,
				revision.assets,
			)
			const solutionCandidates = canonicalDesired.flatMap((item) => {
				if (item.sourceKind !== 'solution') return []
				const solutionVideo = canonicalDesired.find(
					(candidate) =>
						candidate.sourceKind === 'video' &&
						candidate.parentResourceId === item.targetResourceId,
				)
				if (!solutionVideo) {
					throw new CourseSyncError(
						'SOURCE_SOLUTION_VIDEO_MISSING',
						`Lesson ${item.sourceId} has no managed solution video.`,
					)
				}
				return [
					{
						canonicalTargetResourceId: item.targetResourceId,
						lessonResourceId: item.parentResourceId,
						solutionVideoResourceId: solutionVideo.targetResourceId,
						sourceLessonId: item.sourceId,
					},
				]
			})
			const solutionAdoptions = await persistence.findSolutionResourceAdoptions(
				binding.bindingId,
				solutionCandidates,
			)
			const adoptedSolutionIdByCanonical = new Map(
				[...solutionAdoptions.values()].map((adoption) => [
					adoption.canonicalTargetResourceId,
					adoption.resourceId,
				]),
			)
			const desired = canonicalDesired.map((item) => {
				if (item.sourceKind === 'solution') {
					const adoption = solutionAdoptions.get(item.targetResourceId)
					if (!adoption) return item
					const adoptedSlug = adoption.fields.slug
					const baselineVersionId =
						adoption.currentVersionId ??
						solutionAdoptionBaselineVersionId(
							adoption.resourceId,
							adoption.fields,
						)
					return {
						...item,
						targetResourceId: adoption.resourceId,
						fields: {
							...item.fields,
							...(typeof adoptedSlug === 'string' ? { slug: adoptedSlug } : {}),
						},
						solutionAdoption: {
							canonicalTargetResourceId: item.targetResourceId,
							baselineVersionId,
							createBaselineVersion: adoption.currentVersionId === null,
						},
					}
				}
				const adoptedParentId = adoptedSolutionIdByCanonical.get(
					item.parentResourceId,
				)
				return adoptedParentId
					? { ...item, parentResourceId: adoptedParentId }
					: item
			})
			const adoptionPreviousByTarget = new Map<
				string,
				(typeof desired)[number]
			>()
			for (const adoption of solutionAdoptions.values()) {
				const adoptedSolution = desired.find(
					(item) => item.targetResourceId === adoption.resourceId,
				)
				if (adoptedSolution) {
					adoptionPreviousByTarget.set(adoption.resourceId, {
						...adoptedSolution,
						fields: adoption.fields,
						parentResourceId: adoption.lessonResourceId,
						position: adoption.position,
					})
				}
				const adoptedVideo = desired.find(
					(item) => item.targetResourceId === adoption.solutionVideoResourceId,
				)
				if (adoptedVideo) {
					adoptionPreviousByTarget.set(adoption.solutionVideoResourceId, {
						...(previousByTarget.get(adoption.solutionVideoResourceId) ??
							adoptedVideo),
						parentResourceId: adoption.resourceId,
						position: 0,
						detached: false,
					})
				}
			}
			const desiredIds = new Set(desired.map((item) => item.targetResourceId))
			const removedQuestions = [...previousByTarget.values()].filter(
				(item) =>
					item.sourceKind === 'question' &&
					!item.detached &&
					!desiredIds.has(item.targetResourceId),
			)
			const planned = [
				...desired,
				...removedQuestions.map((item) => ({ ...item, detached: true })),
			]
			const snapshots = await persistence.getTargetResources(
				planned.map((item) => item.targetResourceId),
			)
			const resources: ResourcePlanItem[] = planned.map((item) => {
				const previous =
					adoptionPreviousByTarget.get(item.targetResourceId) ??
					previousByTarget.get(item.targetResourceId)
				const snapshot = snapshots.get(item.targetResourceId)
				const action = !snapshot
					? 'create'
					: !previous ||
						  stableJson(previous.fields) !== stableJson(item.fields) ||
						  stableJson(snapshot.fields) !== stableJson(item.fields) ||
						  previous.parentResourceId !== item.parentResourceId ||
						  previous.position !== item.position ||
						  previous.detached !== item.detached
						? 'update'
						: 'retain'
				return {
					...item,
					action,
					previousDetached: previous?.detached ?? false,
					previousVersionId:
						item.solutionAdoption?.baselineVersionId ??
						snapshot?.currentVersionId ??
						null,
					previousFieldsSha256: snapshot
						? sha256(stableJson(snapshot.fields))
						: null,
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
				if (
					!asset.muxAssetId ||
					!asset.muxPlaybackId ||
					asset.duration === null
				) {
					throw new CourseSyncError(
						'FROZEN_MUX_ASSET_MISSING',
						`Frozen Mux asset is missing for video ${asset.sourceVideoId}.`,
					)
				}
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
					muxAssetId: asset.muxAssetId,
					muxPlaybackId: asset.muxPlaybackId,
					duration: asset.duration,
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

		async evaluateBoundedAutoApply(runId: string) {
			const run = await persistence.getRun(runId)
			if (!run) {
				throw new CourseSyncError('RUN_NOT_FOUND', 'Sync run not found.', 404)
			}
			if (run.state !== 'previewed' || !run.plan || !run.planSha256) {
				throw new CourseSyncError(
					'INVALID_RUN_STATE',
					'Only a content-addressed preview can be evaluated for bounded automatic apply.',
					409,
					{ category: 'lifecycle_conflict', retryable: false },
				)
			}
			const { planSha256: claimedPlanSha256, ...planInput } = run.plan
			if (
				claimedPlanSha256 !== run.planSha256 ||
				claimedPlanSha256 !== sha256(stableJson(planInput))
			) {
				throw new CourseSyncError(
					'PLAN_HASH_MISMATCH',
					'The stored preview plan hash does not match the run.',
					409,
					{ category: 'lifecycle_conflict', retryable: false },
				)
			}
			return evaluateCourseSyncBoundedAutoApply(run.plan)
		},

		async verifyApplied(input: { runId: string; planSha256: string }) {
			const run = await persistence.getRun(input.runId)
			if (
				!run ||
				run.state !== 'applied' ||
				run.planSha256 !== input.planSha256 ||
				run.plan?.planSha256 !== input.planSha256
			) {
				throw new CourseSyncError(
					'AUTO_APPLY_READBACK_FAILED',
					'The applied run did not match the content-addressed preview during readback.',
					500,
					{ category: 'internal', retryable: false },
				)
			}
			const { planSha256: claimedPlanSha256, ...planInput } = run.plan
			if (claimedPlanSha256 !== sha256(stableJson(planInput))) {
				throw new CourseSyncError(
					'AUTO_APPLY_READBACK_FAILED',
					'The applied plan failed its content-addressed readback.',
					500,
					{ category: 'internal', retryable: false },
				)
			}
			assertCourseSyncLaunchApplyPolicy(run.plan)
			return publicRun(run)
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
			if (!run.plan || (run.state !== 'previewed' && run.state !== 'failed')) {
				throw new CourseSyncError(
					'INVALID_RUN_STATE',
					'Only a previewed or safely rolled-back failed run can be applied.',
					409,
				)
			}
			if (
				run.state === 'failed' &&
				run.applyIdempotencyKey &&
				run.applyIdempotencyKey !== input.idempotencyKey
			) {
				throw new CourseSyncError(
					'IDEMPOTENCY_CONFLICT',
					'Failed apply retry must use the original idempotency key.',
					409,
				)
			}
			assertCourseSyncLaunchApplyPolicy(run.plan)
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
				await persistence.markFailed(
					run.runId,
					failure.code,
					failure.message,
					input.idempotencyKey,
				)
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
			if (run.state === 'rolled_back') {
				const compensating = run.compensatingRunId
					? await persistence.getRun(run.compensatingRunId)
					: null
				if (compensating?.applyIdempotencyKey !== input.idempotencyKey) {
					throw new CourseSyncError(
						'IDEMPOTENCY_CONFLICT',
						'Rollback already completed with another key.',
						409,
						{ category: 'lifecycle_conflict', retryable: false },
					)
				}
				return publicRun(run, true)
			}
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
					bindingId: run.bindingId,
					idempotencyKey: input.idempotencyKey,
					compensatingRunId: makeId('csr_run'),
					createdById: dependencies.createdById,
				}),
			)
		},
	}
}
