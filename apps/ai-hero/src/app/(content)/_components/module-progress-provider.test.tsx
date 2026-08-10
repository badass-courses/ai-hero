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

	it('does not request progress for an anonymous static shell', () => {
		const markup = renderToStaticMarkup(
			<ClientModuleProgressProvider moduleIdOrSlug="workshop">
				<ProgressProbe />
			</ClientModuleProgressProvider>,
		)

		expect(markup).toContain('>0<')
		expect(mocks.queryOptions).toMatchObject({ enabled: false })
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
		expect(mocks.queryOptions).toMatchObject({ enabled: true })
	})
})
