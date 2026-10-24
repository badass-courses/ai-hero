import * as React from 'react'
import Link from 'next/link'
import { Icon } from '@/components/brand/icons'
import { TYPE } from '@/components/landing/type'
import { MdxErrorBoundary } from '@/components/mdx/mdx-error-boundary'
import { PROSE_MEASURE } from '@/components/mdx/prose'
import { ActiveHeadingProvider } from '@/hooks/use-active-heading'
import { type SandcastleDocsPage } from '@/lib/sandcastle-docs'
import { compileMDX } from '@/utils/compile-mdx'
import { ArrowLeft, ArrowRight } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { CopyPageButton } from '../../_components/copy-page-button'
import { getTocModel } from '../../posts/_components/post-toc-model'
import {
	PostToCDisclosure,
	PostToCRail,
} from '../../posts/_components/post-toc-rail'

/**
 * One docs page: the article shell posts use (70ch prose plus the 232px "On
 * this page" rail from `xl`, a disclosure below it), so the docs read like the
 * rest of the site's long-form, and a pager that walks the sidebar's order.
 */
export async function DocsArticle({
	page,
	previous,
	next,
}: {
	page: SandcastleDocsPage
	previous: SandcastleDocsPage | null
	next: SandcastleDocsPage | null
}) {
	const tocModel = getTocModel(page.body)

	return (
		<ActiveHeadingProvider>
			<article className="[&>*+*]:border-border flex flex-1 flex-col [&>*+*]:-mt-px [&>*+*]:border-t">
				<header className="flex flex-col px-[18px] pb-10 pt-12 sm:px-11">
					<p className={TYPE.eyebrow}>{page.group}</p>
					<h1 className={cn(TYPE.article, 'text-balance')}>{page.title}</h1>
					<div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
						{/* The page as markdown, for pasting into an agent. */}
						<CopyPageButton
							variant="ghost"
							className="rounded-[9px] border"
							sourceUrl={`${page.href}.md`}
						/>
						<Link
							href={page.sourceUrl}
							target="_blank"
							rel="noopener noreferrer"
							className={cn(
								TYPE.metaSm,
								'text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 transition-colors',
							)}
						>
							<Icon name="Github" className="size-3.5 shrink-0" />
							Edit this page on GitHub
						</Link>
					</div>
				</header>
				<PostToCDisclosure model={tocModel} />
				{/* The body takes the slack, so the pager ends the screen. */}
				<div className="flex-1 xl:grid xl:grid-cols-[minmax(0,1fr)_232px]">
					<DocsBody body={page.body} />
					<PostToCRail model={tocModel} title={page.title} />
				</div>
				<DocsPager previous={previous} next={next} />
			</article>
		</ActiveHeadingProvider>
	)
}

async function DocsBody({ body }: { body: string }) {
	// A README blockquote is an aside, not the testimonial the article
	// pipeline styles blockquotes as.
	const { content } = await compileMDX(body, { blockquote: DocsAside })

	return (
		<div className="min-w-0 px-[18px] py-10 sm:px-11">
			<div
				className={cn(
					'prose prose-hr:border-border dark:prose-invert prose-a:text-primary sm:prose-lg',
					PROSE_MEASURE,
				)}
			>
				<MdxErrorBoundary>{content}</MdxErrorBoundary>
			</div>
		</div>
	)
}

/**
 * The README calls a passage out by opening a blockquote on a bold label
 * ("> **Convention**: …"). That one is highlighted, under its own label. A
 * blockquote without a label is only set apart, so the page highlights what
 * its author did and nothing else.
 */
function DocsAside({ children }: { children?: React.ReactNode }) {
	const blocks = React.Children.toArray(children).filter(
		(child) => typeof child !== 'string' || child.trim() !== '',
	)
	const [first, ...rest] = blocks
	const label = first ? leadingLabel(first) : null

	if (!label) {
		return (
			<aside className="border-border my-8 rounded-[9px] border px-6 py-5 [&>:first-child]:mt-0 [&>:last-child]:mb-0">
				{children}
			</aside>
		)
	}

	return (
		<aside
			aria-label={label.text}
			className="bg-accent-fill/[0.07] border-accent-fill/30 my-8 rounded-[9px] border px-6 py-5 [&>:last-child]:mb-0"
		>
			<p className={cn(TYPE.groupLabel, 'text-primary !mb-2 !mt-0')}>
				{label.text}
			</p>
			{label.paragraph}
			{rest}
		</aside>
	)
}

/**
 * `<p><strong>Label</strong>: rest…</p>` → the label, and the paragraph
 * without it. Null when the block does not open that way.
 */
function leadingLabel(block: React.ReactNode) {
	if (!React.isValidElement<{ children?: React.ReactNode }>(block)) return null
	const [lead, after, ...tail] = React.Children.toArray(block.props.children)
	if (
		!React.isValidElement<{ children?: React.ReactNode }>(lead) ||
		typeof lead.props.children !== 'string' ||
		typeof after !== 'string' ||
		!/^\s*:/.test(after)
	) {
		return null
	}
	return {
		text: lead.props.children,
		paragraph: React.cloneElement(
			block,
			undefined,
			after.replace(/^\s*:\s*/, ''),
			...tail,
		),
	}
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
				'bg-background hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.06] group flex flex-col gap-3 px-[18px] py-8 transition-colors sm:px-11',
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
						'size-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none',
						isPrevious
							? 'order-first group-hover:-translate-x-0.5'
							: 'group-hover:translate-x-0.5',
					)}
				/>
			</span>
			<strong className={TYPE.subhead}>{page.title}</strong>
			<span className={cn(TYPE.metaSm, 'text-muted-foreground')}>
				{page.group}
			</span>
		</Link>
	)
}
