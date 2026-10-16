import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/layout-client', () => ({ default: () => null }))
vi.mock('@/lib/pages-query', () => ({ getCachedPage: vi.fn() }))
vi.mock('./_components/landing-body', () => ({ LandingBody: () => null }))

// The canonical is page metadata, not derived from the inbound request.
vi.stubEnv('NEXT_PUBLIC_URL', 'https://www.aihero.dev')
const { metadata } = await import('./page')

describe('homepage metadata', () => {
	it.each(['/', '/?utm_source=x'])(
		'has the absolute site-config canonical for %s',
		() => {
			expect(metadata.alternates?.canonical).toBe('https://www.aihero.dev/')
		},
	)
	it('leaves homepage copy unchanged', () => {
		expect(metadata.title).toEqual({
			template: '%s | AI Hero',
			default: 'Become a Real AI Hero',
		})
		expect(metadata.description).toBeUndefined()
	})
})
