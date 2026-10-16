/* eslint-disable @next/next/no-head-element -- This renders a head fixture, not an application page. */
import * as React from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Metadata } from 'next'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { buildCourseSchema } from './course-schema'
import { metaDescription } from './meta-description'
import baselineDeclarations from './__fixtures__/seo-head-base.json'
import {
	SiteStructuredData,
	DictionaryEntryStructuredData,
} from './structured-data'

vi.mock('@/env.mjs', () => ({
	env: {
		NEXT_PUBLIC_URL: 'https://www.aihero.dev',
		NEXT_PUBLIC_SITE_TITLE: 'AI Hero',
		NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.test',
	},
}))
vi.mock('@/config', () => ({
	default: {
		defaultTitle: 'AI Hero',
		description: 'AI Engineering for Curious Professional Developers',
		author: 'Matt Pocock',
		sameAs: [],
	},
}))

const { accumulateMetadata } = await vi.importActual<
	typeof import('next/dist/lib/metadata/resolve-metadata')
>('next/dist/esm/lib/metadata/resolve-metadata')
const root = resolve(import.meta.dirname, '../../../..')
const site = 'https://www.aihero.dev'
const config = {
	siteUrl: site,
	defaultTitle: 'AI Hero',
	author: 'Matt Pocock',
	description: 'AI Engineering for Curious Professional Developers',
	openGraph: { images: [{ url: `${site}/api/og/default` }] },
}
const env = { NEXT_PUBLIC_URL: site }
const paths = {
	home: 'apps/ai-hero/src/app/page.tsx',
	layout: 'apps/ai-hero/src/app/layout.tsx',
	workshop: 'apps/ai-hero/src/app/(content)/workshops/[module]/page.tsx',
	dictionary:
		'apps/ai-hero/src/app/(content)/ai-coding-dictionary/[slug]/page.tsx',
}

/** Execute only a route's metadata declaration, with synthetic read adapters. No app/DB imports run. */
function declaration<T>(
	path: string,
	name: string,
	before: boolean,
	bindings: Record<string, unknown>,
): T {
	// The base declarations were extracted verbatim from 77c57d6b. Keep tests runnable in shallow clones.
	const baseline: Record<string, string> = baselineDeclarations
	const source = before ? '' : readFileSync(resolve(root, path), 'utf8')
	const tree = ts.createSourceFile(
		path,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	)
	let code = before
		? (baseline[`${path.replace('apps/ai-hero/', '')}:${name}`] ?? '')
		: ''
	for (const node of tree.statements) {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name)
			code = node.getText(tree).replace(/^export /, '')
		if (ts.isVariableStatement(node))
			for (const item of node.declarationList.declarations) {
				if (item.name.getText(tree) === name && item.initializer)
					code = `const ${name} = ${item.initializer.getText(tree)}`
			}
	}
	if (!code) throw new Error(`Metadata declaration not found: ${name}`)
	const compiled = ts.transpileModule(code, {
		compilerOptions: {
			jsx: ts.JsxEmit.React,
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.CommonJS,
		},
	}).outputText
	return new Function(...Object.keys(bindings), `${compiled}\nreturn ${name}`)(
		...Object.values(bindings),
	) as T
}

type MetadataGenerator = (
	props: { params: Promise<Record<string, string>> },
	parent: Promise<Metadata>,
) => Promise<Metadata>
type WorkshopScript = (props: {
	title: string
	description: string
	slug: string
	productId: string
}) => React.ReactNode | Promise<React.ReactNode>
const StructuredDataScript = ({ data, id }: { data: unknown; id: string }) => (
	<script
		id={id}
		type="application/ld+json"
		dangerouslySetInnerHTML={{
			__html: JSON.stringify(data).replace(/</g, '\\u003c'),
		}}
	/>
)

async function renderHead(
	pathname: string,
	leaf: Metadata,
	scripts: React.ReactNode,
	before: boolean,
) {
	const layout = declaration<Metadata>(paths.layout, 'metadata', before, {
		config,
		env,
		URL,
	})
	const resolved = await accumulateMetadata(
		pathname,
		[
			[layout, null],
			[leaf, null],
		],
		Promise.resolve(pathname.split('?')[0]!),
		{ trailingSlash: false, isStaticMetadataRouteFile: false },
	)
	return renderToStaticMarkup(
		<head>
			<title>{resolved.title?.absolute}</title>
			{resolved.description ? (
				<meta name="description" content={resolved.description} />
			) : null}
			{resolved.alternates?.canonical?.url ? (
				<link
					rel="canonical"
					href={String(resolved.alternates.canonical.url)}
				/>
			) : null}
			<meta
				property="og:title"
				content={String(resolved.openGraph?.title?.absolute ?? '')}
			/>
			<meta
				property="og:description"
				content={resolved.openGraph?.description ?? ''}
			/>
			{resolved.openGraph?.images?.map((image, i) => (
				<meta
					key={i}
					property="og:image"
					content={String(
						typeof image === 'string' || image instanceof URL
							? image
							: image.url,
					)}
				/>
			))}
			{scripts}
		</head>,
	)
}

describe('source-declaration head renders (synthetic fixtures, Next metadata inheritance)', () => {
	it('captures base/head for homepage, both crash courses and a dictionary term', async () => {
		const proof: Record<string, { before: string; after: string }> = {}
		for (const before of [true, false]) {
			const phase = before ? 'before' : 'after'
			const homepage = declaration<Metadata>(paths.home, 'metadata', before, {
				config,
				env,
				URL,
			})
			const homeHead = await renderHead(
				'/',
				homepage,
				<SiteStructuredData />,
				before,
			)
			proof['/'] ??= { before: '', after: '' }
			proof['/'][phase] = homeHead
			if (!before) {
				expect(homeHead).toContain('href="https://www.aihero.dev/"')
				expect(
					await renderHead(
						'/?utm_source=x',
						homepage,
						<SiteStructuredData />,
						before,
					),
				).toBe(homeHead)
			}
			for (const [slug, title, description] of [
				[
					'ai-sdk-v6-crash-course',
					'AI SDK v6 Crash Course',
					'A synthetic fixture: this course teaches *you* to use [the AI SDK](https://example.test/sdk) with practical exercises.',
				],
				[
					'ai-coding-crash-course',
					'AI Coding Crash Course',
					'A synthetic fixture for professional engineers: learn how to ship software with coding agents while keeping your focus on software engineering fundamentals and practical workflows.',
				],
			]) {
				const product = {
					price: {
						unitAmount: 247,
						fields: {
							stripe: { currency: 'usd', active: true, supported: true },
						},
					},
				}
				const bindings = {
					React,
					config,
					env,
					URL,
					metaDescription,
					buildCourseSchema,
					StructuredDataScript,
					getCourseSeoCommerce: async () => ({ product, quantityAvailable: 0 }),
					getCachedMinimalWorkshop: async () => ({
						fields: { title, description },
					}),
				}
				const generate = declaration<MetadataGenerator>(
					paths.workshop,
					'generateMetadata',
					before,
					bindings,
				)
				const script = declaration<WorkshopScript>(
					paths.workshop,
					'WorkshopMetadata',
					before,
					bindings,
				)
				const metadata = await generate(
					{ params: Promise.resolve({ module: slug! }) },
					Promise.resolve({}),
				)
				const jsonLd = await script({
					title: title!,
					description: description!,
					slug: slug!,
					productId: 'synthetic-product',
				})
				const route = `/workshops/${slug}`
				proof[route] ??= { before: '', after: '' }
				proof[route][phase] = await renderHead(route, metadata, jsonLd, before)
				if (!before) {
					expect(metadata.description).not.toMatch(/\*you\*|\[/)
					expect(metadata.description!.length).toBeLessThanOrEqual(155)
					expect(proof[route][phase]).toContain('https://schema.org/SoldOut')
				}
			}
			const entry = {
				title: 'Agent',
				slug: 'agent',
				description:
					'A synthetic *dictionary* description with an &amp; entity.',
				sectionTitle: 'Core terms',
				path: 'agent.md',
				githubUrl: 'https://example.test/agent.md',
				aliases: [],
				position: 0,
				body: 'Synthetic body.',
				rawBody: 'Synthetic body.',
			}
			const generate = declaration<MetadataGenerator>(
				paths.dictionary,
				'generateMetadata',
				before,
				{
					metaDescription,
					getAiCodingDictionaryEntry: async () => entry,
					AI_CODING_DICTIONARY_TITLE: 'AI Coding Dictionary',
					AI_CODING_DICTIONARY_DESCRIPTION: 'Dictionary',
					getAiCodingDictionaryOgImageUrl: (title: string) =>
						`${site}/api/og/default?title=${encodeURIComponent(title)}`,
				},
			)
			const metadata = await generate(
				{ params: Promise.resolve({ slug: entry.slug }) },
				Promise.resolve({}),
			)
			proof['/ai-coding-dictionary/agent'] ??= { before: '', after: '' }
			proof['/ai-coding-dictionary/agent'][phase] = await renderHead(
				'/ai-coding-dictionary/agent',
				metadata,
				<DictionaryEntryStructuredData
					entry={{
						...entry,
						description: before
							? entry.description
							: metaDescription(entry.description),
					}}
					dictionary={{
						entries: [entry],
						sections: [],
						sourceUrl: 'https://example.test/dictionary',
						updatedAt: '2026-10-15T00:00:00Z',
					}}
				/>,
				before,
			)
		}
		expect(proof).toMatchSnapshot()
	})
})
