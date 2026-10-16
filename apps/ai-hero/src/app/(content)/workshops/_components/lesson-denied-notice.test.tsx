import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ denied: null as string | null }))

vi.mock('next/navigation', () => ({
	useSearchParams: () =>
		new URLSearchParams(mocks.denied ? `denied=${mocks.denied}` : ''),
	usePathname: () => '/workshops/crash-course',
}))
vi.mock('next/link', () => ({
	default: ({
		href,
		children,
	}: {
		href: string
		children: React.ReactNode
	}) => <a href={href}>{children}</a>,
}))

import { LESSON_DENIAL_COPY } from '@/lib/lesson-denial'

import { LessonDeniedNotice } from './lesson-denied-notice'

const render = (denied: string | null) => {
	mocks.denied = denied
	return renderToStaticMarkup(<LessonDeniedNotice />)
}

describe('LessonDeniedNotice', () => {
	it('renders the copy for each whitelisted reason', () => {
		for (const reason of Object.keys(LESSON_DENIAL_COPY) as Array<
			keyof typeof LESSON_DENIAL_COPY
		>) {
			const html = render(reason)
			expect(html).toContain(`data-lesson-denied="${reason}"`)
			expect(html.replace(/&#x27;/g, "'")).toContain(LESSON_DENIAL_COPY[reason])
		}
	})
	it('links signed-out readers to sign in, back to this page', () => {
		expect(render('signed-out')).toContain(
			'href="/login?callbackUrl=%2Fworkshops%2Fcrash-course"',
		)
		expect(render('no-purchase')).not.toContain('/login')
	})
	it('ignores anything outside the whitelist', () => {
		for (const bad of [null, 'pending-open', 'team-seat-unclaimed', '<b>x</b>'])
			expect(render(bad)).toBe('')
	})
})
