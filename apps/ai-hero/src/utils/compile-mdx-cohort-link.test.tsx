import React from 'react'
import { renderToReadableStream } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

import { compileMDX } from './compile-mdx'

const { prefetch } = vi.hoisted(() => ({ prefetch: vi.fn() }))

vi.mock('next/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('next/navigation')>()),
	useRouter: () => ({ prefetch }),
}))
vi.mock('next/link', () => ({
	default: ({ prefetch, onPointerEnter, onFocus, ...props }: React.ComponentProps<'a'> & {
		prefetch?: boolean
	}) => (
		<a
			{...props}
			data-prefetch={prefetch}
			data-prefetch-on-intent={Boolean(onPointerEnter && onFocus)}
		/>
	),
}))
vi.mock('@/lib/cohort-office-hours-query', () => ({
	getCohortOfficeHoursSessionsForWorkshop: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/server/logger', () => ({
	log: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))

it('routes relative cohort links in article prose through intent prefetch', async () => {
	const { content } = await compileMDX('[Cohort](/cohorts/example) and [Workshop](/workshops/example)')
	const stream = await renderToReadableStream(content)
	const html = await new Response(stream).text()

	expect(html).toMatch(/href="\/cohorts\/example"[^>]*data-prefetch="false"[^>]*data-prefetch-on-intent="true"/)
	expect(html).toMatch(/href="\/workshops\/example"[^>]*data-prefetch-on-intent="false"/)
	expect(prefetch).not.toHaveBeenCalled()
})
