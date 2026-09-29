import { describe, expect, it } from 'vitest'

import {
	computeVideoFacts,
	computeVideoPlayback,
	ownedVideoPlayback,
	type VideoGraphEdge,
	type VideoGraphNode,
} from './video-facts'

const now = new Date('2026-09-29T12:00:00Z')

function video(id: string, overrides: Partial<VideoGraphNode> = {}) {
	return {
		id,
		type: 'videoResource',
		state: 'ready',
		muxPlaybackId: `playback-${id}`,
		...overrides,
	} satisfies VideoGraphNode
}

function node(id: string, type: string, overrides: Partial<VideoGraphNode> = {}) {
	return { id, type, title: id, state: 'published', ...overrides }
}

function edge(parentId: string, childId: string, tier?: string): VideoGraphEdge {
	return { parentId, childId, tier }
}

describe('computeVideoFacts', () => {
	it('marks a post with a ready video as a free video', () => {
		const facts = computeVideoFacts(
			{
				nodes: [node('post', 'post', { duration: 312.4 }), video('v1')],
				edges: [edge('post', 'v1')],
			},
			now,
		)

		expect(facts.get('post')).toEqual({
			has_video: true,
			free: true,
			course_ids: null,
			duration_seconds: 312,
			container_title: null,
			workshop_slug: null,
			video_resource_id: 'v1',
			thumbnail_time: null,
			mux_playback_id: 'playback-v1',
		})
	})

	it('finds an older post video through fields.videoResourceId', () => {
		const facts = computeVideoFacts(
			{
				nodes: [
					node('post', 'post', { videoResourceId: 'v1' }),
					video('v1', { duration: 60 }),
				],
				edges: [],
			},
			now,
		)

		expect(facts.get('post')?.has_video).toBe(true)
		expect(facts.get('post')?.duration_seconds).toBe(60)
	})

	it('takes the thumbnail time from the post before the video', () => {
		const facts = computeVideoFacts(
			{
				nodes: [
					node('post', 'post', { thumbnailTime: 42.4 }),
					video('v1', { thumbnailTime: 7 }),
				],
				edges: [edge('post', 'v1')],
			},
			now,
		)

		expect(facts.get('post')?.thumbnail_time).toBe(42)
	})

	it.each([
		['errored', { state: 'errored' }],
		['still processing', { state: 'processing' }],
		['without a playback id', { muxPlaybackId: null }],
	])('ignores a video that is %s', (_label, overrides) => {
		const facts = computeVideoFacts(
			{
				nodes: [node('post', 'post'), video('v1', overrides)],
				edges: [edge('post', 'v1')],
			},
			now,
		)

		expect(facts.get('post')?.has_video).toBe(false)
		expect(facts.get('post')?.mux_playback_id).toBeNull()
	})

	it('only produces facts for resources that are videos themselves', () => {
		const facts = computeVideoFacts(
			{
				nodes: [
					node('cohort', 'cohort'),
					node('workshop', 'workshop'),
					node('lesson', 'lesson'),
					node('solution', 'solution'),
					video('v1'),
					video('v2'),
				],
				edges: [
					edge('cohort', 'workshop'),
					edge('workshop', 'lesson'),
					edge('lesson', 'solution'),
					edge('lesson', 'v1'),
					edge('solution', 'v2'),
				],
			},
			now,
		)

		expect(Array.from(facts.keys())).toEqual(['lesson'])
	})

	describe('a cohort of day-workshops', () => {
		const facts = computeVideoFacts(
			{
				nodes: [
					node('cohort', 'cohort', {
						title: 'Personal Assistant',
						visibility: 'public',
					}),
					node('day0', 'workshop', { visibility: 'unlisted' }),
					node('day1', 'workshop', {
						visibility: 'unlisted',
						startsAt: '2026-09-01T00:00:00Z',
					}),
					node('day9', 'workshop', {
						visibility: 'unlisted',
						startsAt: '2026-10-05T00:00:00Z',
					}),
					node('intro', 'section'),
					node('welcome', 'lesson'),
					node('setup', 'lesson'),
					// Lesson state gates nothing: the live crash course is all drafts.
					node('paid', 'lesson', { state: 'draft' }),
					node('upcoming', 'lesson'),
					video('v-welcome'),
					video('v-setup'),
					video('v-paid'),
					video('v-upcoming'),
				],
				edges: [
					edge('cohort', 'day0'),
					edge('cohort', 'day1'),
					edge('cohort', 'day9'),
					edge('day0', 'welcome', 'free'),
					edge('day0', 'intro', 'free'),
					edge('intro', 'setup'),
					edge('day1', 'paid', 'standard'),
					edge('day9', 'upcoming', 'free'),
					edge('welcome', 'v-welcome'),
					edge('setup', 'v-setup'),
					edge('paid', 'v-paid'),
					edge('upcoming', 'v-upcoming'),
				],
			},
			now,
		)

		it('frees a lesson placed with tier free', () => {
			expect(facts.get('welcome')?.free).toBe(true)
		})

		it('frees every lesson in a free-tier section', () => {
			expect(facts.get('setup')?.free).toBe(true)
		})

		it('keeps a standard-tier lesson paid but opened by its courses', () => {
			expect(facts.get('paid')).toMatchObject({
				free: false,
				course_ids: ['cohort', 'day1'],
			})
		})

		it('names the cohort, not the day-workshop, as the lesson course', () => {
			expect(facts.get('welcome')?.container_title).toBe('Personal Assistant')
		})

		// Cohort days are published ahead and open on startsAt.
		it('opens nothing through a day that has not started yet', () => {
			expect(facts.get('upcoming')).toMatchObject({
				has_video: true,
				free: false,
				course_ids: null,
			})
		})
	})

	// The index is searchable with a public key and Mux ids play without a
	// token: a paid lesson's playback id there would give the video away.
	it('keeps a paid lesson playback id out of the index facts', () => {
		const graph = {
			nodes: [
				node('workshop', 'workshop'),
				node('paid', 'lesson'),
				node('free', 'lesson'),
				video('v-paid', { thumbnailTime: 9 }),
				video('v-free'),
			],
			edges: [
				edge('workshop', 'paid', 'standard'),
				edge('workshop', 'free', 'free'),
				edge('paid', 'v-paid'),
				edge('free', 'v-free'),
			],
		}
		const facts = computeVideoFacts(graph, now)

		// The still still works: it goes through /api/thumbnails by video
		// resource id, which is not sensitive.
		expect(facts.get('paid')).toMatchObject({
			has_video: true,
			mux_playback_id: null,
			video_resource_id: 'v-paid',
			thumbnail_time: 9,
		})
		expect(facts.get('free')?.mux_playback_id).toBe('playback-v-free')
		expect(computeVideoPlayback(graph, new Set(['paid']))).toEqual(
			new Map([['paid', { playbackId: 'playback-v-paid', thumbnailTime: 9 }]]),
		)
	})

	it('hands an owner the playback of paid lessons in their courses only', () => {
		const graph = {
			nodes: [
				node('mine', 'workshop'),
				node('theirs', 'workshop'),
				node('owned', 'lesson'),
				node('other', 'lesson'),
				node('preview', 'lesson'),
				video('v1'),
				video('v2'),
				video('v3'),
			],
			edges: [
				edge('mine', 'owned', 'standard'),
				edge('theirs', 'other', 'standard'),
				edge('mine', 'preview', 'free'),
				edge('owned', 'v1'),
				edge('other', 'v2'),
				edge('preview', 'v3'),
			],
		}

		expect(ownedVideoPlayback(graph, ['mine'], now)).toEqual({
			owned: { playbackId: 'playback-v1', thumbnailTime: null },
		})
		expect(ownedVideoPlayback(graph, [], now)).toEqual({})
	})

	// Regression: lesson docs' parentResources kept `ai-sdk-v5-crash-course`
	// after the workshop was renamed, and that URL redirects to the workshop.
	it('links a lesson through an open workshop, a free one first', () => {
		const facts = computeVideoFacts(
			{
				nodes: [
					node('paid-ws', 'workshop', { slug: 'a-paid' }),
					node('free-ws', 'workshop', { slug: 'z-free' }),
					node('closed-ws', 'workshop', { slug: 'closed', state: 'draft' }),
					node('section', 'section'),
					node('lesson', 'lesson'),
					node('other', 'lesson'),
					video('v1'),
					video('v2'),
				],
				edges: [
					edge('paid-ws', 'lesson', 'standard'),
					edge('free-ws', 'section', 'free'),
					edge('section', 'lesson'),
					edge('closed-ws', 'other', 'free'),
					edge('lesson', 'v1'),
					edge('other', 'v2'),
				],
			},
			now,
		)

		expect(facts.get('lesson')?.workshop_slug).toBe('z-free')
		expect(facts.get('other')?.workshop_slug).toBeNull()
	})

	it('opens nothing through a draft workshop', () => {
		const facts = computeVideoFacts(
			{
				nodes: [
					node('workshop', 'workshop', { state: 'draft' }),
					node('lesson', 'lesson'),
					video('v1'),
				],
				edges: [edge('workshop', 'lesson', 'free'), edge('lesson', 'v1')],
			},
			now,
		)

		expect(facts.get('lesson')).toMatchObject({ free: false, course_ids: null })
	})

	// Mirrors the ability: only a module's own join rows carry tier. A tier on
	// a section→lesson row does not open the lesson.
	it('ignores a tier set on a section-to-lesson join', () => {
		const facts = computeVideoFacts(
			{
				nodes: [
					node('workshop', 'workshop'),
					node('section', 'section'),
					node('lesson', 'lesson'),
					video('v1'),
				],
				edges: [
					edge('workshop', 'section', 'standard'),
					edge('section', 'lesson', 'free'),
					edge('lesson', 'v1'),
				],
			},
			now,
		)

		expect(facts.get('lesson')?.free).toBe(false)
	})

	it('frees a lesson placed free by either of two workshops', () => {
		const facts = computeVideoFacts(
			{
				nodes: [
					node('a', 'workshop'),
					node('b', 'workshop'),
					node('lesson', 'lesson'),
					video('v1'),
				],
				edges: [
					edge('a', 'lesson', 'standard'),
					edge('b', 'lesson', 'free'),
					edge('lesson', 'v1'),
				],
			},
			now,
		)

		expect(facts.get('lesson')).toMatchObject({
			free: true,
			course_ids: ['a', 'b'],
		})
	})

	it('survives a cycle in the graph', () => {
		const facts = computeVideoFacts(
			{
				nodes: [node('a', 'list'), node('b', 'list'), node('p', 'post'), video('v')],
				edges: [edge('a', 'b'), edge('b', 'a'), edge('b', 'p'), edge('p', 'v')],
			},
			now,
		)

		expect(facts.get('p')?.course_ids).toEqual(['a', 'b'])
	})
})
