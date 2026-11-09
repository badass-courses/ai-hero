// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { countRequiredModuleProgress } from '@/lib/required-module-progress'

const mocks = vi.hoisted(() => ({ progress: null as any }))
vi.mock('@/trpc/react', () => ({
	api: {
		progress: {
			moduleProgress: { useQuery: () => ({ data: mocks.progress }) },
		},
	},
}))
vi.mock('@/components/certificates/module-certificate', () => ({
	Root: ({ children }: any) => <div>{children}</div>,
	Trigger: ({ children }: any) => <button>{children}</button>,
	Dialog: () => null,
	NameInput: () => null,
	DownloadButton: () => null,
	GenerateShareUrlButton: () => null,
	ShareUrl: () => null,
}))
vi.mock('@/components/certificates/certificate-tile', () => ({
	CERTIFICATE_TILE_ACTION: '',
	CertificateTile: ({ action }: any) => <div>{action}</div>,
}))
import { Certificate } from './module-certificate-container'
import {
	ClientModuleProgressProvider,
	useModuleProgress,
} from './module-progress-provider'

function Probe() {
	const { moduleProgress, addLessonProgress, removeLessonProgress } =
		useModuleProgress()
	return (
		<>
			<output>{JSON.stringify(moduleProgress)}</output>
			<button onClick={() => addLessonProgress('faq')}>Complete FAQ</button>
			<button onClick={() => removeLessonProgress('faq')}>Undo FAQ</button>
			<Certificate resourceSlugOrId="workshop" />
		</>
	)
}

describe('optional optimistic progress', () => {
	it.each([false, true])(
		'optional completion never inflates required counts (optional only: %s)',
		async (optionalOnly) => {
			;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
			mocks.progress = countRequiredModuleProgress(
				{
					completedLessons: optionalOnly
						? []
						: [
								{
									userId: 'learner',
									resourceId: 'required',
									completedAt: new Date(),
								},
							],
					nextResource: null,
					percentCompleted: 100,
					completedLessonsCount: optionalOnly ? 0 : 1,
					totalLessonsCount: optionalOnly ? 0 : 1,
				},
				[
					...(optionalOnly
						? []
						: [
								{
									id: 'required',
									type: 'lesson',
									slug: 'required',
									optional: false,
								},
							]),
					{ id: 'faq', type: 'lesson', slug: 'faq', optional: true },
				],
			)
			const host = document.createElement('div')
			document.body.append(host)
			const root = createRoot(host)
			try {
				await act(async () =>
					root.render(
						<ClientModuleProgressProvider moduleIdOrSlug="workshop">
							<Probe />
						</ClientModuleProgressProvider>,
					),
				)
				expect(host.textContent).toContain('Get Certificate')
				const read = () =>
					JSON.parse(host.querySelector('output')!.textContent!)
				await act(async () => host.querySelectorAll('button')[0]!.click())
				expect(read()).toMatchObject({
					percentCompleted: 100,
					completedLessonsCount: optionalOnly ? 0 : 1,
				})
				expect(
					read().completedLessons.some(
						(item: any) => item.resourceId === 'faq',
					),
				).toBe(true)
				await act(async () => host.querySelectorAll('button')[1]!.click())
				expect(read()).toMatchObject({
					percentCompleted: 100,
					completedLessonsCount: optionalOnly ? 0 : 1,
				})
				expect(
					read().completedLessons.some(
						(item: any) => item.resourceId === 'faq',
					),
				).toBe(false)
				expect(host.textContent).toContain('Get Certificate')
			} finally {
				await act(async () => root.unmount())
				host.remove()
			}
		},
	)
})
