import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Icon } from '@/components/brand/icons'
import { BADGE_OUTLINE, TYPE } from '@/components/landing/type'
import {
	SANDCASTLE_DOCS_PATH,
	SANDCASTLE_PACKAGE,
	SANDCASTLE_REPO_URL,
	type SandcastleDocs,
} from '@/lib/sandcastle-docs'
import { compileMDX } from '@/utils/compile-mdx'
import { ArrowRight, ArrowUpRight, Download, Star } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { CopyPageButton } from '../../_components/copy-page-button'
import { InstallCommand } from '../../skills/_components/install-command'

/** The README's own wordmark pair, already on the shared Cloudinary. */
const WORDMARK = {
	light:
		'https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-onlight_2x.png',
	dark: 'https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-ondark_2x.png',
	// The 2x asset's pixels, so it stays sharp up to 151px tall.
	width: 562,
	height: 302,
}

const INSTALL_COMMAND = `npm install --save-dev ${SANDCASTLE_PACKAGE}`

// The README's own words for a provider of your own, under its "Custom
// Sandbox Providers" heading.
const CUSTOM_PROVIDER =
	'Bind-mount when the sandbox can mount a host directory. Isolated when it has its own filesystem.'

/**
 * /sandcastle: the tool's front page. Every fact on it is read out of the
 * README (the lead, the three steps, the providers, the example), so the
 * landing cannot say something the docs no longer do. The order is the one a
 * tool page owes its reader: what it is and how to install it, what it does,
 * where it runs, then the way into the docs.
 */
export async function SandcastleLanding({
	docs,
	stars,
	downloads,
}: {
	docs: SandcastleDocs
	stars: number | null
	downloads: number | null
}) {
	const firstPage = docs.start
	// The index lists the start page first, as the sidebar does.
	const index = [
		...(docs.start ? [{ title: docs.start.group, pages: [docs.start] }] : []),
		...docs.groups,
	]

	return (
		<div className="[&>*+*]:border-border flex flex-col [&>*+*]:-mt-px [&>*+*]:border-t">
			<header className="@container">
				<div className="grid grid-cols-1 gap-x-12 gap-y-10 px-[18px] pb-12 pt-12 sm:px-11 @[960px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] @[960px]:items-center">
					<div className="flex min-w-0 flex-col">
						<h1 className="mb-5">
							<span className="sr-only">Sandcastle</span>
							{/* Theme is class-driven here, so the README's
							    prefers-color-scheme swap becomes dark: variants. */}
							<Image
								src={WORDMARK.light}
								alt=""
								width={WORDMARK.width}
								height={WORDMARK.height}
								priority
								className="h-[112px] w-auto sm:h-[140px] dark:hidden"
							/>
							<Image
								src={WORDMARK.dark}
								alt=""
								width={WORDMARK.width}
								height={WORDMARK.height}
								priority
								className="hidden h-[112px] w-auto sm:h-[140px] dark:block"
							/>
						</h1>
						<p
							className={cn(
								TYPE.leadHero,
								'mb-7 max-w-[34ch] text-pretty text-[color:var(--ah-fg-body)]',
							)}
						>
							{docs.lead}
						</p>
						<Stats stars={stars} downloads={downloads} />
						<div className="mt-8 flex flex-wrap items-center gap-2.5">
							{firstPage ? (
								<Link
									href={firstPage.href}
									className={cn(
										TYPE.meta,
										'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring group inline-flex h-[46px] w-fit items-center gap-2 rounded-[9px] px-5 text-[15px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
									)}
								>
									Get started
									<ArrowRight
										aria-hidden
										className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
									/>
								</Link>
							) : null}
							<Link
								href={SANDCASTLE_REPO_URL}
								target="_blank"
								rel="noopener noreferrer"
								className={cn(
									TYPE.meta,
									'border-foreground/20 text-foreground hover:border-foreground/40 hover:bg-secondary focus-visible:ring-ring inline-flex h-[46px] w-fit items-center gap-2 rounded-[9px] border px-5 text-[15px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
								)}
							>
								<Icon name="Github" className="size-4 shrink-0" />
								View on GitHub
							</Link>
						</div>
					</div>
					<div className="flex min-w-0 flex-col gap-3">
						<InstallCommand command={INSTALL_COMMAND} />
						{docs.example ? <Example code={docs.example} /> : null}
						{/* Every docs page as one markdown file, for an agent. */}
						<CopyPageButton
							variant="ghost"
							size="sm"
							label="Copy all docs"
							className="text-muted-foreground hover:text-foreground self-end rounded-[6px]"
							sourceUrl={`${SANDCASTLE_DOCS_PATH}.md`}
						/>
					</div>
				</div>
			</header>

			{/* What it does and where it runs, read side by side as one section,
			    so neither needs a grid of its own. */}
			<section aria-labelledby="sandcastle-how" className="@container">
				<div className="grid grid-cols-1 gap-x-16 gap-y-14 px-[18px] py-14 sm:px-11 @[960px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
					<div className="flex min-w-0 flex-col">
						<h2 id="sandcastle-how" className={TYPE.heading}>
							How it works
						</h2>
						<ol className="mt-9 flex flex-col">
							{docs.steps.map((step, index) => (
								<li key={step} className="relative flex gap-5 pb-9 last:pb-0">
									{/* A rule from each number to the next reads the list as
									    one sequence. */}
									{index < docs.steps.length - 1 ? (
										<span
											aria-hidden
											className="bg-border absolute bottom-1 left-4 top-11 w-px"
										/>
									) : null}
									<span
										aria-hidden
										className={cn(
											TYPE.navNum,
											'bg-accent-fill/[0.14] text-primary flex size-8 shrink-0 items-center justify-center rounded-[6px]',
										)}
									>
										{index + 1}
									</span>
									<p className={cn(TYPE.lead, 'text-pretty pt-0.5')}>
										<InlineMarkdown source={step} />
									</p>
								</li>
							))}
						</ol>
						<MoreLink
							href={`${SANDCASTLE_DOCS_PATH}/how-it-works`}
							className="mt-auto pt-10"
						>
							Branch strategies
						</MoreLink>
					</div>

					{docs.providers.length > 0 ? (
						<div className="flex min-w-0 flex-col">
							<h2 className={TYPE.heading}>Sandbox providers</h2>
							<ul className="border-border bg-card divide-border mt-9 flex flex-col divide-y overflow-hidden rounded-[11px] border">
								{docs.providers.map((provider) => (
									<li
										key={provider.importPath}
										className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-4 sm:grid-cols-[6.5rem_minmax(0,1fr)_6.5rem]"
									>
										<span className={TYPE.cardTitle}>{provider.name}</span>
										<code
											className={cn(
												TYPE.metaMark,
												'col-span-2 row-start-2 text-[color:var(--ah-fg-muted)] sm:col-span-1 sm:row-start-auto',
											)}
										>
											{/* Wrap after a slash, never inside a segment. */}
											{provider.importPath.split('/').map((segment, index) => (
												<React.Fragment key={index}>
													{index > 0 ? (
														<>
															/<wbr />
														</>
													) : null}
													{segment}
												</React.Fragment>
											))}
										</code>
										<span
											className={cn(
												TYPE.badge,
												BADGE_OUTLINE,
												'col-start-2 row-start-1 justify-self-end sm:col-start-3',
											)}
										>
											{provider.type}
										</span>
									</li>
								))}
								<li>
									<Link
										href={`${SANDCASTLE_DOCS_PATH}/custom-sandbox-providers`}
										className="hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.06] group flex items-center gap-4 px-5 py-4 transition-colors"
									>
										<span className="flex min-w-0 flex-col gap-1">
											<span className={TYPE.cardTitle}>Custom providers</span>
											<span
												className={cn(TYPE.metaSm, 'text-muted-foreground')}
											>
												{CUSTOM_PROVIDER}
											</span>
										</span>
										<ArrowRight
											aria-hidden
											className="text-muted-foreground group-hover:text-foreground ml-auto size-4 shrink-0 transition group-hover:translate-x-0.5 motion-reduce:transition-none"
										/>
									</Link>
								</li>
							</ul>
							<MoreLink
								href={`${SANDCASTLE_DOCS_PATH}/sandbox-providers`}
								className="mt-auto pt-10"
							>
								Compare providers
							</MoreLink>
						</div>
					) : null}
				</div>
			</section>

			<section aria-labelledby="sandcastle-docs-index">
				<SectionHead id="sandcastle-docs-index" title="Documentation" />
				{/* One list, read top to bottom: the group on the left, then each
				    page's title and the sentence it opens on. */}
				<div className="divide-border flex flex-col divide-y">
					{index.map((group) => (
						<div
							key={group.title}
							className="grid grid-cols-1 md:grid-cols-[13rem_minmax(0,1fr)]"
						>
							<h3
								className={cn(
									TYPE.groupLabel,
									'px-[18px] pb-1 pt-6 sm:px-11 md:py-7',
								)}
							>
								{group.title}
							</h3>
							<ul className="divide-border md:border-border flex flex-col divide-y md:border-l">
								{group.pages.map((page) => (
									<li key={page.slug}>
										<Link
											href={page.href}
											prefetch={false}
											className="hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.06] group flex items-center gap-6 px-[18px] py-5 transition-colors sm:px-11 md:px-8"
										>
											<span className="flex min-w-0 flex-col gap-1.5">
												<span className={TYPE.subhead}>{page.title}</span>
												{page.description ? (
													<span
														className={cn(
															TYPE.metaProse,
															'max-w-[68ch] text-[color:var(--ah-fg-muted)]',
														)}
													>
														{page.description}
													</span>
												) : null}
											</span>
											<ArrowRight
												aria-hidden
												className="text-muted-foreground group-hover:text-foreground ml-auto size-4 shrink-0 transition group-hover:translate-x-0.5 motion-reduce:transition-none"
											/>
										</Link>
									</li>
								))}
							</ul>
						</div>
					))}
				</div>
			</section>

			{/* The README's License section, which is not a page of its own. */}
			{docs.license ? (
				<footer className="px-[18px] py-8 sm:px-11">
					<p className={cn(TYPE.metaSm, 'text-muted-foreground')}>
						{docs.license}
					</p>
				</footer>
			) : null}
		</div>
	)
}

function SectionHead({ id, title }: { id: string; title: string }) {
	return (
		<div className="border-border border-b px-[18px] pb-8 pt-12 sm:px-11">
			<h2 id={id} className={cn(TYPE.heading, 'text-balance')}>
				{title}
			</h2>
		</div>
	)
}

function MoreLink({
	href,
	className,
	children,
}: {
	href: string
	className?: string
	children: React.ReactNode
}) {
	return (
		<Link
			href={href}
			className={cn(
				TYPE.meta,
				'hover:text-foreground group inline-flex w-fit shrink-0 items-center gap-1.5 text-[color:var(--ah-fg-subtle)] transition-colors',
				className,
			)}
		>
			{children}
			<ArrowRight
				aria-hidden
				className="size-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
			/>
		</Link>
	)
}

/**
 * The credibility line. Each stat drops out when its source does not answer,
 * rather than printing a zero.
 */
function Stats({
	stars,
	downloads,
}: {
	stars: number | null
	downloads: number | null
}) {
	const stats = [
		stars !== null && {
			icon: <Star aria-hidden className="text-primary size-5 fill-current" />,
			value: stars,
			label: 'GitHub stars',
			href: SANDCASTLE_REPO_URL,
		},
		downloads !== null && {
			icon: <Download aria-hidden className="text-primary size-5" />,
			value: downloads,
			label: 'npm downloads a week',
			href: `https://www.npmjs.com/package/${SANDCASTLE_PACKAGE}`,
		},
	].filter(Boolean) as {
		icon: React.ReactNode
		value: number
		label: string
		href: string
	}[]

	if (stats.length === 0) return null

	return (
		<dl className="flex flex-wrap gap-x-9 gap-y-5">
			{stats.map((stat) => (
				<div key={stat.label} className="flex items-center gap-3">
					{stat.icon}
					<div className="flex flex-col-reverse">
						<dt className={cn(TYPE.statLabel, 'mt-0.5')}>
							<Link
								href={stat.href}
								target="_blank"
								rel="noopener noreferrer"
								className="hover:text-foreground inline-flex items-center gap-1 transition-colors"
							>
								{stat.label}
								<ArrowUpRight aria-hidden className="size-3" />
							</Link>
						</dt>
						<dd className={cn(TYPE.stat, 'text-[22px] sm:text-[24px]')}>
							{stat.value.toLocaleString('en-US')}
						</dd>
					</div>
				</div>
			))}
		</dl>
	)
}

async function Example({ code }: { code: string }) {
	// The README numbers its quick-start steps, and this block opens on the
	// "// 4." that belongs to that list, not to the code.
	const source = code.replace(/^\/\/ \d+\..*\n/, '')
	const { content } = await compileMDX(`\`\`\`ts\n${source}\n\`\`\``)
	// CodeHike's frame, as articles render it, minus its vertical margins so
	// it lines up under the install row.
	return <div className="[&_pre]:my-0 [&>*]:my-0">{content}</div>
}

/**
 * Inline markdown for a README list item: `code` spans and nothing else, which
 * is all the steps use. The parser escaped `<{}` for MDX; undo that here.
 */
function InlineMarkdown({ source }: { source: string }) {
	const text = source.replace(/\\([<{}])/g, '$1')
	return (
		<>
			{text.split(/(`[^`]+`)/g).map((part, index) =>
				part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
					<code
						key={index}
						className="bg-muted rounded-[4px] px-1.5 py-0.5 font-mono text-[0.88em]"
					>
						{part.slice(1, -1)}
					</code>
				) : (
					part.replace(/\*\*/g, '')
				),
			)}
		</>
	)
}
