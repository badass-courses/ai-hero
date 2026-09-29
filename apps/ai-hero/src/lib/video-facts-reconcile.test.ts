import { describe, expect, it } from 'vitest'

import type { VideoFacts } from './video-facts'
import {
	diffVideoFacts,
	findVideoResourcesToReindex,
} from './video-facts-reconcile'

const lessonFacts: VideoFacts = {
	has_video: true,
	free: false,
	course_ids: ['cohort-1', 'workshop-1'],
	duration_seconds: null,
	container_title: 'Personal Assistant',
	mux_playback_id: 'playback-1',
	thumbnail_time: null,
}

describe('diffVideoFacts', () => {
	it('writes nothing when the index already agrees', () => {
		const updates = diffVideoFacts(
			[{ id: 'lesson', ...lessonFacts, course_ids: ['workshop-1', 'cohort-1'] }],
			new Map([['lesson', lessonFacts]]),
		)

		expect(updates).toEqual([])
	})

	it('treats a missing field, null and an empty list as the same value', () => {
		const { duration_seconds: _omit, ...withoutDuration } = lessonFacts
		const updates = diffVideoFacts(
			[
				{ id: 'lesson', ...withoutDuration },
				{ id: 'post', ...lessonFacts, course_ids: [] },
			],
			new Map([
				['lesson', lessonFacts],
				['post', { ...lessonFacts, course_ids: null }],
			]),
		)

		expect(updates).toEqual([])
	})

	// The case the reconcile exists for: an editor flips a tier in the CMS
	// reorder, which never reindexes the lesson.
	it('rewrites a doc whose derived facts changed', () => {
		const updates = diffVideoFacts(
			[{ id: 'lesson', ...lessonFacts, free: true }],
			new Map([['lesson', lessonFacts]]),
		)

		expect(updates).toEqual([{ id: 'lesson', ...lessonFacts }])
	})

	// A cohort day opening changes course_ids with no write anywhere.
	it('rewrites a doc when a course opens it', () => {
		const updates = diffVideoFacts(
			[{ id: 'lesson', ...lessonFacts, course_ids: null }],
			new Map([['lesson', lessonFacts]]),
		)

		expect(updates).toHaveLength(1)
	})

	it('leaves docs outside the graph alone', () => {
		const updates = diffVideoFacts(
			[{ id: 'dictionary-entry' }],
			new Map([['lesson', lessonFacts]]),
		)

		expect(updates).toEqual([])
	})
})

describe('findVideoResourcesToReindex', () => {
	const graph = {
		nodes: [
			{ id: 'post', type: 'post', state: 'published', visibility: 'public' },
			{ id: 'draft-post', type: 'post', state: 'draft', visibility: 'public' },
			{ id: 'owned', type: 'lesson', state: 'draft', visibility: 'unlisted' },
			{ id: 'closed', type: 'lesson', state: 'published', visibility: 'unlisted' },
			{ id: 'indexed', type: 'post', state: 'published', visibility: 'public' },
			{ id: 'flipped', type: 'post', state: 'published', visibility: 'public' },
			{ id: 'no-video', type: 'post', state: 'published', visibility: 'public' },
		],
		edges: [],
	}
	const facts = new Map<string, VideoFacts>([
		['post', { ...lessonFacts, free: true, course_ids: null }],
		['draft-post', { ...lessonFacts, free: true, course_ids: null }],
		['owned', lessonFacts],
		['closed', { ...lessonFacts, course_ids: null }],
		['indexed', { ...lessonFacts, free: true }],
		['flipped', { ...lessonFacts, free: true }],
		['no-video', { ...lessonFacts, has_video: false }],
	])
	const indexed = [
		{ id: 'indexed', visibility: 'public', state: 'published' },
		// Published by a write that never reindexed.
		{ id: 'flipped', visibility: 'public', state: 'draft' },
		{ id: 'no-video', visibility: 'unlisted', state: 'draft' },
	]

	it('rebuilds watchable videos the index is missing or has out of date', () => {
		expect(findVideoResourcesToReindex(graph, facts, indexed)).toEqual([
			'post',
			'owned',
			'flipped',
		])
	})
})
