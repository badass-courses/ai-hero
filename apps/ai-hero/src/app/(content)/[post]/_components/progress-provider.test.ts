import { describe, expect, it } from 'vitest'

import type { ModuleProgress } from '@coursebuilder/core/schemas'

import {
	applyCompletionOverlay,
	createCompletionOverlay,
} from './progress-provider'

const progressWith = (...resourceIds: string[]): ModuleProgress => ({
	completedLessons: resourceIds.map((resourceId) => ({
		resourceId,
		completedAt: new Date(),
		userId: 'user-1',
	})),
	nextResource: null,
	percentCompleted: 0,
	completedLessonsCount: resourceIds.length,
	totalLessonsCount: 10,
})

const members = new Set(['lesson-1', 'lesson-2', 'lesson-3'])

describe('createCompletionOverlay', () => {
	it('carries an add across what a remount would reseed', () => {
		const overlay = createCompletionOverlay()
		overlay.add('lesson-1')
		expect(overlay.getSnapshot().added).toEqual(['lesson-1'])
	})

	it('remove rolls back a pending add', () => {
		const overlay = createCompletionOverlay()
		overlay.add('lesson-1')
		overlay.remove('lesson-1')
		expect(overlay.getSnapshot()).toEqual({
			added: [],
			removed: ['lesson-1'],
		})
	})

	it('keeps an entry even when one surface has seen the server agree', () => {
		// Deliberate: surfaces disagree about freshness (the provider reloads
		// per navigation, the sidebar keeps a long-staleTime query copy), so
		// nothing is allowed to drop an entry on another surface's behalf — the
		// merge is idempotent instead.
		const overlay = createCompletionOverlay()
		overlay.add('lesson-1')
		const result = applyCompletionOverlay(progressWith('lesson-1'), members, {
			added: overlay.getSnapshot().added,
			removed: [],
		})
		expect(result?.completedLessonsCount).toBe(1)
		expect(overlay.getSnapshot().added).toEqual(['lesson-1'])
	})

	it('notifies subscribers on change', () => {
		const overlay = createCompletionOverlay()
		let notified = 0
		overlay.subscribe(() => notified++)
		overlay.add('lesson-1')
		overlay.remove('lesson-1')
		expect(notified).toBe(2)
	})

	it('retract undoes an add without asserting un-completion', () => {
		// A rollback cannot tell a failed write from a succeeded write behind a
		// transport error — a `removed` mask here would hide a genuinely-landed
		// completion for the rest of the session.
		const overlay = createCompletionOverlay()
		overlay.add('lesson-1')
		overlay.retract('lesson-1')
		expect(overlay.getSnapshot()).toEqual({ added: [], removed: [] })
	})
})

describe('applyCompletionOverlay', () => {
	it('shows an optimistic tick the server has not seen yet', () => {
		const result = applyCompletionOverlay(progressWith('lesson-1'), members, {
			added: ['lesson-2'],
			removed: [],
		})
		expect(
			result?.completedLessons.map((lesson) => lesson.resourceId),
		).toEqual(['lesson-1', 'lesson-2'])
		expect(result?.completedLessonsCount).toBe(2)
	})

	it('returns the server value untouched when the overlay has nothing for this module', () => {
		const progress = progressWith('lesson-1')
		const result = applyCompletionOverlay(progress, members, {
			added: ['other-module-lesson'],
			removed: [],
		})
		expect(result).toBe(progress)
	})

	it('does not double-count an id the server already reports', () => {
		const result = applyCompletionOverlay(progressWith('lesson-1'), members, {
			added: ['lesson-1'],
			removed: [],
		})
		expect(result?.completedLessonsCount).toBe(1)
	})

	it('masks a server-completed lesson the reader optimistically removed', () => {
		const result = applyCompletionOverlay(
			progressWith('lesson-1', 'lesson-2'),
			members,
			{ added: [], removed: ['lesson-2'] },
		)
		expect(
			result?.completedLessons.map((lesson) => lesson.resourceId),
		).toEqual(['lesson-1'])
	})

	it('builds progress from nothing for a signed-out or first-visit reader', () => {
		const result = applyCompletionOverlay(null, members, {
			added: ['lesson-3'],
			removed: [],
		})
		expect(
			result?.completedLessons.map((lesson) => lesson.resourceId),
		).toEqual(['lesson-3'])
	})

	it('applies without membership filtering on a standalone post (null memberIds)', () => {
		const result = applyCompletionOverlay(null, null, {
			added: ['standalone-post'],
			removed: [],
		})
		expect(
			result?.completedLessons.map((lesson) => lesson.resourceId),
		).toEqual(['standalone-post'])
	})
})
