import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { TYPE } from '@/components/landing/type'
import { Callout } from '@/components/mdx/callout'
import { MdxErrorBoundary } from '@/components/mdx/mdx-error-boundary'
import { PROSE_MEASURE } from '@/components/mdx/prose'
import { HubLayout } from '@/components/navigation/hub-layout'
import {
	getSandcastleDocs,
	getSandcastleDocsPage,
	SANDCASTLE_PACKAGE,
	SANDCASTLE_README_URL,
	SANDCASTLE_REPO_URL,
	type SandcastleDocsPage,
} from '@/lib/sandcastle-docs'
import { compileMDX } from '@/utils/compile-mdx'
import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronDown } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

const SANDCASTLE_DOCS_TITLE = 'Sandcastle docs'
const SANDCASTLE_DOCS_DESCRIPTION =
	'Docs for Sandcastle, the TypeScript library for orchestrating AI coding agents in isolated sandboxes.'

/**
 * One page of the Sandcastle docs. `/sandcastle` and `/sandcastle/[slug]` both
 * render this; the index is the README's first section.
 */
export async function SandcastleDocsView({ slug }: { slug: string }) {
	const docs = await getSandcastleDocsPage(slug)
	if (!docs) notFound()
	const { pages, page, previous, next } = docs

	return (
		<LayoutClient withContainer withFooter={false}>
			{/* The docs bring their own sidebar, so the hub one starts as the
			    collapsed icon rail, the same call the dictionary makes. */}
			<HubLayout sidebarDefaultCollapsed>
				<main className="bg-background text-foreground grid min-h-[calc(100vh-var(--nav-height))] grid-cols-1 lg:grid-cols-[17rem_minmax(0,1fr)]">
					<aside className="border-border lg:sticky lg:top-(--nav-height) lg:max-h-[calc(100vh-var(--nav-height))] lg:self-start lg:overflow-y-auto">
						<details className="border-border group border-b lg:hidden">
							<summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-[18px] py-3 [&::-webkit-details-marker]:hidden">
								<span className={cn(TYPE.groupLabel)}>Sandcastle docs</span>
								<span
									className={cn(
										TYPE.nav,
										'flex items-center gap-2 font-medium',
									)}
								>
									{page.title}
									<ChevronDown
										aria-hidden
										className="size-3.5 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
									/>
								</span>
							</summary>
							<div className="border-border border-t">
								<DocsNav pages={pages} current={page} />
							</div>
						</details>
						<div className="hidden lg:block">
							<DocsNav pages={pages} current={page} />
						</div>
					</aside>

					<div className="border-border min-w-0 lg:border-l">
						<header className="border-border border-b">
							<div className="flex flex-col px-[18px] pb-10 pt-12 sm:px-11">
								<p className={TYPE.eyebrow}>{SANDCASTLE_DOCS_TITLE}</p>
								<h1 className={cn(TYPE.article, 'text-balance')}>
									{page.title}
								</h1>
								<p
									className={cn(
										TYPE.metaSm,
										'text-muted-foreground mt-5 flex flex-wrap items-center gap-x-1.5',
									)}
								>
									From the README of
									<Link
										href={SANDCASTLE_README_URL}
										target="_blank"
										rel="noopener noreferrer"
										className="text-foreground decoration-border hover:decoration-foreground inline-flex items-center gap-0.5 font-mono underline underline-offset-4 transition-colors"
									>
										mattpocock/sandcastle
										<ArrowUpRight aria-hidden className="size-3.5" />
									</Link>
								</p>
							</div>
						</header>

						<DocsBody body={page.body} />

						<DocsPager previous={previous} next={next} />
					</div>
				</main>
			</HubLayout>
		</LayoutClient>
	)
}

function DocsNav({
	pages,
	current,
}: {
	pages: SandcastleDocsPage[]
	current: SandcastleDocsPage
}) {
	return (
		<nav aria-label="Sandcastle docs" className="flex flex-col gap-6 py-6">
			<ul className="flex flex-col gap-px px-2">
				{pages.map((page) => {
					const isCurrent = page.href === current.href
					return (
						<li key={page.href}>
							<Link
								href={page.href}
								prefetch={false}
								aria-current={isCurrent ? 'page' : undefined}
								className={cn(
									TYPE.nav,
									'text-muted-foreground hover:text-foreground hover:bg-muted block rounded-sm px-2.5 py-[7px] transition-colors',
									isCurrent && [
										'font-medium',
										'bg-foreground text-background hover:bg-foreground hover:text-background',
										'dark:bg-accent-fill/10 dark:text-primary dark:hover:bg-accent-fill/10 dark:hover:text-primary',
									],
								)}
							>
								{page.title}
							</Link>
							{isCurrent && page.headings.length > 0 ? (
								<ul className="border-border my-1 ml-[18px] flex flex-col border-l">
									{page.headings.map((heading) => (
										<li key={heading.anchor}>
											<a
												href={`#${heading.anchor}`}
												className={cn(
													TYPE.metaSm,
													'text-muted-foreground hover:text-foreground block py-[5px] pl-3 pr-2 transition-colors',
												)}
											>
												{heading.title}
											</a>
										</li>
									))}
								</ul>
							) : null}
						</li>
					)
				})}
			</ul>
			<div className="border-border flex flex-col gap-px border-t px-2 pt-4">
				<ExternalNavLink href={SANDCASTLE_REPO_URL}>GitHub</ExternalNavLink>
				<ExternalNavLink
					href={`https://www.npmjs.com/package/${SANDCASTLE_PACKAGE}`}
				>
					npm
				</ExternalNavLink>
			</div>
		</nav>
	)
}

function ExternalNavLink({
	href,
	children,
}: {
	href: string
	children: React.ReactNode
}) {
	return (
		<Link
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className={cn(
				TYPE.nav,
				'text-muted-foreground hover:text-foreground hover:bg-muted flex items-center justify-between rounded-sm px-2.5 py-[7px] transition-colors',
			)}
		>
			{children}
			<ArrowUpRight aria-hidden className="size-3.5" />
		</Link>
	)
}

async function DocsBody({ body }: { body: string }) {
	// A README blockquote is an aside ("> **Convention**: ..."), not the
	// testimonial the article pipeline styles blockquotes as.
	const { content } = await compileMDX(body, {
		blockquote: ({ children }) => <Callout kind="note">{children}</Callout>,
	})

	return (
		<div className="border-border border-b px-[18px] py-12 sm:px-11">
			<article
				className={cn(
					'prose prose-hr:border-border dark:prose-invert prose-a:text-primary sm:prose-lg',
					PROSE_MEASURE,
				)}
			>
				<MdxErrorBoundary>{content}</MdxErrorBoundary>
			</article>
		</div>
	)
}

function DocsPager({
	previous,
	next,
}: {
	previous: SandcastleDocsPage | null
	next: SandcastleDocsPage | null
}) {
	return (
		<nav
			aria-label="Previous and next page"
			className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2"
		>
			{previous ? (
				<PagerTile page={previous} direction="previous" />
			) : (
				<div aria-hidden className="bg-background hidden sm:block" />
			)}
			{next ? (
				<PagerTile page={next} direction="next" />
			) : (
				<div aria-hidden className="bg-background hidden sm:block" />
			)}
		</nav>
	)
}

function PagerTile({
	page,
	direction,
}: {
	page: SandcastleDocsPage
	direction: 'previous' | 'next'
}) {
	const isPrevious = direction === 'previous'
	const Arrow = isPrevious ? ArrowLeft : ArrowRight
	return (
		<Link
			href={page.href}
			prefetch={false}
			className={cn(
				'bg-background hover:bg-muted/40 group flex flex-col gap-3 px-[18px] py-8 transition-colors sm:px-11',
				!isPrevious && 'sm:items-end sm:text-right',
			)}
		>
			<span
				className={cn(
					TYPE.metaMark,
					'group-hover:text-foreground inline-flex items-center gap-2 transition-colors',
				)}
			>
				{isPrevious ? 'Previous' : 'Next'}
				<Arrow
					aria-hidden
					className={cn(
						'size-3.5 transition-transform duration-200 ease-out',
						isPrevious
							? 'order-first group-hover:-translate-x-0.5'
							: 'group-hover:translate-x-0.5',
					)}
				/>
			</span>
			<strong className={TYPE.subhead}>{page.title}</strong>
		</Link>
	)
}

export async function sandcastleDocsMetadata(slug: string): Promise<Metadata> {
	const docs = await getSandcastleDocsPage(slug)
	if (!docs) return {}
	const { page } = docs
	const title = slug
		? `${page.title} | ${SANDCASTLE_DOCS_TITLE} | AI Hero`
		: `${SANDCASTLE_DOCS_TITLE} | AI Hero`
	const description = page.description || SANDCASTLE_DOCS_DESCRIPTION

	return {
		title,
		description,
		alternates: { canonical: page.href },
		openGraph: {
			title,
			description,
			url: page.href,
			siteName: 'AI Hero',
			type: 'article',
			images: [
				{
					url: `/api/og?title=${encodeURIComponent(page.slug ? page.title : 'Sandcastle')}`,
					width: 1200,
					height: 630,
				},
			],
		},
	}
}

export async function sandcastleDocsStaticParams() {
	const pages = await getSandcastleDocs()
	return pages.filter((page) => page.slug).map((page) => ({ slug: page.slug }))
}
