import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	moduleProgress: null as any,
	queryOptions: null as any,
	sessionStatus: 'unauthenticated' as
		| 'authenticated'
		| 'loading'
		| 'unauthenticated',
}))

vi.mock('next-auth/react', () => ({
	useSession: () => ({ status: mocks.sessionStatus }),
}))

vi.mock('@/trpc/react', () => ({
	api: {
		progress: {
			moduleProgress: {
				useQuery: (_input: unknown, options: unknown) => {
					mocks.queryOptions = options
					return { data: mocks.moduleProgress }
				},
			},
		},
	},
}))

import {
	ClientModuleProgressProvider,
	useModuleProgress,
} from './module-progress-provider'

function ProgressProbe() {
	const { moduleProgress } = useModuleProgress()
	return <div>{moduleProgress?.completedLessons?.length ?? 0}</div>
}

describe('ClientModuleProgressProvider', () => {
	beforeEach(() => {
		mocks.moduleProgress = null
		mocks.queryOptions = null
		mocks.sessionStatus = 'unauthenticated'
	})

	it('renders an empty static shell before the query resolves', () => {
		const markup = renderToStaticMarkup(
			<ClientModuleProgressProvider moduleIdOrSlug="workshop">
				<ProgressProbe />
			</ClientModuleProgressProvider>,
		)

		// The query always fires (see the comment on
		// ClientModuleProgressProvider): subscriber-cookie learners are never
		// next-auth-authenticated, so gating the fetch on session status hid
		// their progress. There is no `enabled` field to assert on any more —
		// only that the anonymous case resolves to nothing and the static
		// shell renders empty.
		expect(markup).toContain('>0<')
		expect(mocks.queryOptions).not.toHaveProperty('enabled')
	})

	it('hydrates signed-in progress from the member query', () => {
		mocks.sessionStatus = 'authenticated'
		mocks.moduleProgress = {
			completedLessons: [{ id: 'lesson-1' }],
			totalLessonsCount: 2,
		}

		const markup = renderToStaticMarkup(
			<ClientModuleProgressProvider moduleIdOrSlug="workshop">
				<ProgressProbe />
			</ClientModuleProgressProvider>,
		)

		expect(markup).toContain('>1<')
		expect(mocks.queryOptions).not.toHaveProperty('enabled')
	})
})
