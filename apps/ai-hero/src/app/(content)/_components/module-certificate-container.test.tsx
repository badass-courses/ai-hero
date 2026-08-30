import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	eligibilityUseQuery: vi.fn(),
	useModuleProgress: vi.fn(),
}))

vi.mock('@/trpc/react', () => ({
	api: {
		certificate: {
			crashCourseEligibility: { useQuery: mocks.eligibilityUseQuery },
		},
	},
}))
vi.mock('./module-progress-provider', () => ({
	useModuleProgress: mocks.useModuleProgress,
}))
vi.mock('@/components/certificates/module-certificate', () => ({
	Root: ({
		children,
		variant,
	}: {
		children: React.ReactNode
		variant: string
	}) => <div data-certificate-root={variant}>{children}</div>,
	Trigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	NameInput: () => <span>Name input</span>,
	DownloadButton: () => <span>Download</span>,
	GenerateShareUrlButton: () => <span>Generate share</span>,
	ShareUrl: () => <span>Share URL</span>,
	ShareActions: ({ courseName }: { courseName: string }) => (
		<span>Share {courseName}</span>
	),
}))

import { Certificate } from './module-certificate-container'

beforeEach(() => {
	vi.clearAllMocks()
	mocks.useModuleProgress.mockReturnValue({
		moduleProgress: {
			percentCompleted: 100,
			completedLessonsCount: 12,
			totalLessonsCount: 12,
		},
	})
})

describe('Crash Course certificate tile', () => {
	it('uses the quiz gate instead of stacking lesson progress', () => {
		mocks.eligibilityUseQuery.mockReturnValue({
			status: 'success',
			data: {
				status: 'locked',
				reason: 'answers-incorrect',
				correctAnswers: 7,
				requiredAnswers: 8,
			},
		})

		const markup = renderToStaticMarkup(
			<Certificate
				resourceSlugOrId="ai-coding-crash-course"
				variant="crash-course"
				finalQuizLessonId="sync_lesson_final_quiz"
			/>,
		)

		expect(markup).toContain('7/8 checkpoint questions correct')
		expect(markup).toContain(
			'/workshops/ai-coding-crash-course/sync_lesson_final_quiz',
		)
		expect(markup).not.toContain('data-certificate-root')
	})

	it('renders the existing certificate and share composition when granted', () => {
		mocks.eligibilityUseQuery.mockReturnValue({
			status: 'success',
			data: {
				status: 'granted',
				eligibility: {
					correctAnswers: 8,
					requiredAnswers: 8,
				},
			},
		})

		const markup = renderToStaticMarkup(
			<Certificate
				resourceSlugOrId="ai-coding-crash-course"
				variant="crash-course"
				finalQuizLessonId="sync_lesson_final_quiz"
			/>,
		)

		expect(markup).toContain('data-certificate-root="crash-course"')
		expect(markup).toContain('8/8 checkpoint questions correct')
		expect(markup).toContain('Share AI Coding Crash Course')
	})

	it('preserves the lesson-progress path while rollout is disabled', () => {
		mocks.eligibilityUseQuery.mockReturnValue({
			status: 'success',
			data: { status: 'disabled' },
		})

		const markup = renderToStaticMarkup(
			<Certificate
				resourceSlugOrId="ai-coding-crash-course"
				variant="crash-course"
			/>,
		)

		expect(markup).toContain('data-certificate-root="legacy"')
		expect(markup).toContain('12/12 lessons completed')
		expect(markup).toContain('Share URL (can be used on LinkedIn, etc.)')
		expect(markup).not.toContain('Share AI Coding Crash Course')
	})
})
