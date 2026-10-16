import { AsyncLocalStorage } from 'node:async_hooks'
import type { LoaderTree } from 'next/dist/server/lib/app-dir-module'
import type { WorkStore } from 'next/dist/server/app-render/work-async-storage.external'
import type { RequestStore } from 'next/dist/server/app-render/work-unit-async-storage.external'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/layout-client', () => ({ default: () => null }))
vi.mock('@/lib/pages-query', () => ({ getCachedPage: vi.fn() }))
vi.mock('./_components/landing-body', () => ({ LandingBody: () => null }))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_URL: 'https://www.aihero.dev' },
}))
vi.stubGlobal('AsyncLocalStorage', AsyncLocalStorage)
const { metadata } = await import('./page')
const { resolveMetadata } = await vi.importActual<
	typeof import('next/dist/lib/metadata/resolve-metadata')
>('next/dist/esm/lib/metadata/resolve-metadata')
const { workAsyncStorage } = await vi.importActual<
	typeof import('next/dist/server/app-render/work-async-storage.external')
>('next/dist/esm/server/app-render/work-async-storage.external')

const { workUnitAsyncStorage } = await vi.importActual<
	typeof import('next/dist/server/app-render/work-unit-async-storage.external')
>('next/dist/esm/server/app-render/work-unit-async-storage.external')

const tree: LoaderTree = [
	'',
	{
		children: [
			'__PAGE__',
			{},
			{ page: [async () => ({ metadata }), '/page.tsx'] },
			null,
		],
	},
	{
		layout: [
			async () => ({
				metadata: { metadataBase: new URL('https://www.aihero.dev') },
			}),
			'/layout.tsx',
		],
	},
	null,
]

describe('homepage metadata', () => {
	it.each(['https://www.aihero.dev/', 'https://www.aihero.dev/?utm_source=x'])(
		'renders a query-free canonical for request %s',
		async (url) => {
			const request = new Request(url)
			const parsed = new URL(request.url)
			const resolved = await workAsyncStorage.run(
				{ route: '/', isStaticGeneration: false } as WorkStore,
				() =>
					workUnitAsyncStorage.run(
						{ type: 'request', phase: 'render' } as RequestStore,
						() =>
							resolveMetadata(
								tree,
								Promise.resolve(parsed.pathname),
								Promise.resolve(Object.fromEntries(parsed.searchParams)),
								undefined,
								{},
								{ trailingSlash: false, isStaticMetadataRouteFile: false },
								false,
							),
					),
			)
			const head = renderToStaticMarkup(
				<link
					rel="canonical"
					href={String(resolved.alternates?.canonical?.url)}
				/>,
			)
			expect(head).toBe(
				'<link rel="canonical" href="https://www.aihero.dev/"/>',
			)
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
