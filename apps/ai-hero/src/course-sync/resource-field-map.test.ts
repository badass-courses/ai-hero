import {
	courseJsonVideos,
	type CourseJsonDocumentV3,
} from '@ai-hero/course-sync-schema'
import { describe, expect, it } from 'vitest'

import {
	createCourseSyncControlPlane,
	sourceResourceFields,
} from './control-plane'
import { InMemoryCourseSyncPersistence } from './in-memory-persistence'
import {
	assertCourseSyncSourceFields,
	mergeCourseSyncResourceFields,
	sourceFieldsByKind,
} from './resource-fields'
import { syntheticCohortBinding } from './test-fixtures/cohort-binding'
import {
	AI_HERO_COURSE_SYNC_BINDING,
	type FrozenSourceAsset,
	type ResourcePlanItem,
} from './types'

const quizBody = `<QuizQuestion data={{
 id: 'full-question', question: 'Choose', type: 'multiple-choice', tagId: 123,
 correct: ['yes'], answer: 'Yes', choices: [{ answer: 'yes', label: 'Yes', image: '/yes.png' }],
 template: 'default', shuffleChoices: true, allowMultiple: true, required: true,
 dependsOn: { question: 'prior-question', answer: 'yes' },
 code: [{ filename: 'index.ts', active: true, code: 'const yes = true' }],
}} />`
const video = (id: string, body = 'Video body') => ({
	id,
	relativePath: `${id}.mp4`,
	body,
	description: `${id} description`,
	hash: `render-${id}`,
	sha256: 'a'.repeat(64),
	bytes: 1,
	chapters: [],
})
const manifest: CourseJsonDocumentV3 = {
	$schema: 'course.schema.json',
	schemaVersion: 4,
	courseId: syntheticCohortBinding.sourceCourseId,
	courseVersionId: 'all-source-branches',
	archiveTTL: '90d',
	courseName: 'Synthetic source field map',
	sections: [
		{
			id: 'all-branches',
			title: 'Every branch',
			lessons: [
				{ type: 'placeholder', id: 'placeholder', title: 'Placeholder' },
				{
					type: 'explainer',
					id: 'explainer',
					title: 'Explainer',
					explainer: video('explainer-video', quizBody),
				},
				{
					type: 'problem',
					id: 'problem-only',
					title: 'Problem only',
					problem: video('problem-only-video'),
				},
				{
					type: 'problem',
					id: 'problem-solution',
					title: 'Problem and solution',
					problem: video('problem-video'),
					solution: video('solution-video'),
				},
			],
		},
	],
}
const assets: FrozenSourceAsset[] = courseJsonVideos(manifest).map(
	(source) => ({
		sourceVideoId: source.id,
		relativePath: source.relativePath,
		providerRevision: 'provider-1',
		providerContentHash: null,
		producerSha256: source.sha256,
		bytes: source.bytes,
		snapshotUri: null,
		muxAssetId: `mux-${source.id}`,
		muxPlaybackId: `playback-${source.id}`,
		duration: 60,
	}),
)

function assertProducedFields(
	items: readonly Pick<ResourcePlanItem, 'sourceKind' | 'fields'>[],
) {
	for (const item of items) {
		expect(() => assertCourseSyncSourceFields(item)).not.toThrow()
		expect(mergeCourseSyncResourceFields(item)).toEqual(item.fields)
	}
}

describe('source generator field-map contract', () => {
	it('covers every generated branch and exactly every owned key across both section mappings', () => {
		const workshopBinding = {
			...AI_HERO_COURSE_SYNC_BINDING,
			bindingId: 'test-workshop-binding',
			sourceCourseId: manifest.courseId,
		}
		const items = [
			...sourceResourceFields(syntheticCohortBinding, manifest, assets),
			...sourceResourceFields(workshopBinding, manifest, assets),
		]
		assertProducedFields(items)
		expect(new Set(items.map((item) => item.sourceKind))).toEqual(
			new Set(Object.keys(sourceFieldsByKind)),
		)
		for (const sourceKind of new Set(items.map((item) => item.sourceKind))) {
			const produced = new Set(
				items
					.filter((item) => item.sourceKind === sourceKind)
					.flatMap((item) => Object.keys(item.fields)),
			)
			expect([...produced].sort()).toEqual(
				[...sourceFieldsByKind[sourceKind]].sort(),
			)
		}
		expect(items.filter((item) => item.sourceKind === 'lesson')).toHaveLength(8)
		expect(items.filter((item) => item.sourceKind === 'video')).toHaveLength(8)
		expect(items.filter((item) => item.sourceKind === 'solution')).toHaveLength(
			2,
		)
		expect(items.filter((item) => item.sourceKind === 'question')).toHaveLength(
			2,
		)
	})

	it('checks the adopted-solution preview branch without treating operator fields as produced keys', async () => {
		const persistence = new InMemoryCourseSyncPersistence()
		const generated = sourceResourceFields(
			syntheticCohortBinding,
			manifest,
			assets,
		)
		const solution = generated.find((item) => item.sourceKind === 'solution')!
		const solutionVideoResourceId = solution.fields.videoResourceId
		if (typeof solutionVideoResourceId !== 'string') throw new Error('missing solution video')
		const fields = {
			...solution.fields,
			slug: 'operator-adopted-slug',
			startsAt: '2026-11-09T08:01:00.000Z',
		}
		const adoptedId = 'solution-adopted'
		persistence.resources.set(adoptedId, {
			resourceId: adoptedId,
			currentVersionId: 'adopted-version',
			type: 'solution',
			fields,
		})
		persistence.findSolutionResourceAdoptions = async () =>
			new Map([
				[
					solution.targetResourceId,
					{
						resourceId: adoptedId,
						canonicalTargetResourceId: solution.targetResourceId,
						lessonResourceId: solution.parentResourceId,
						solutionVideoResourceId,
						currentVersionId: 'adopted-version',
						fields,
						position: 0,
					},
				],
			])
		const unexpected = async (): Promise<never> => {
			throw new Error('unexpected media dependency')
		}
		let sequence = 0
		const plane = createCourseSyncControlPlane({
			bindingRegistry: {
				[syntheticCohortBinding.bindingId]: syntheticCohortBinding,
			},
			persistence,
			muxSourceResolver: { resolve: unexpected },
			muxClient: {
				getAsset: unexpected,
				createAsset: unexpected,
				waitForReady: unexpected,
			},
			createdById: 'test-writer',
			makeId: (prefix) => `${prefix}_${++sequence}`,
		})
		const staged = await plane.stageFrozen({
			bindingId: syntheticCohortBinding.bindingId,
			idempotencyKey: 'map-adoption',
			manifest,
			frozenAssets: assets,
		})
		await plane.preview(staged.runId)
		const plan = persistence.runs.get(staged.runId)?.plan
		if (!plan) throw new Error('missing preview')
		assertProducedFields(plan.resources)
		const adopted = plan.resources.find(
			(item) => item.targetResourceId === adoptedId,
		)!
		expect(adopted.solutionAdoption).toBeDefined()
		expect(adopted.fields.slug).toBe('operator-adopted-slug')
		expect(adopted.fields).not.toHaveProperty('startsAt')
		expect(mergeCourseSyncResourceFields(adopted, fields).startsAt).toBe(
			fields.startsAt,
		)
	})
})
