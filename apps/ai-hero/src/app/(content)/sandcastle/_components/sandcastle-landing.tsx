import Image from 'next/image'
import Link from 'next/link'
import { Icon } from '@/components/brand/icons'
import { BADGE_OUTLINE, TYPE } from '@/components/landing/type'
import {
	SANDCASTLE_DOCS_PATH,
	SANDCASTLE_PACKAGE,
	SANDCASTLE_README_URL,
	SANDCASTLE_REPO_URL,
	type SandcastleDocs,
} from '@/lib/sandcastle-docs'
import { compileMDX } from '@/utils/compile-mdx'
import { ArrowRight, ArrowUpRight, Download, Star } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

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
	'Bind-mount if the sandbox can mount a host directory, isolated if it has its own filesystem.'

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
					</div>
				</div>
			</header>

			{docs.steps.length > 0 ? (
				<section aria-labelledby="sandcastle-how">
					<SectionHead
						id="sandcastle-how"
						title="How it works"
						href={`${SANDCASTLE_DOCS_PATH}/how-it-works`}
						linkLabel="Branch strategies"
					/>
					<ol className="bg-border grid grid-cols-1 gap-px md:grid-cols-3">
						{docs.steps.map((step, index) => (
							<li
								key={step}
								className="bg-background flex flex-col gap-4 px-[18px] py-8 sm:px-11 md:px-8"
							>
								<span
									aria-hidden
									className={cn(
										TYPE.navNum,
										'bg-accent-fill/[0.14] text-primary flex size-7 items-center justify-center rounded-sm',
									)}
								>
									{index + 1}
								</span>
								<p className={cn(TYPE.bodyTight, 'text-pretty font-normal')}>
									<InlineMarkdown source={step} />
								</p>
							</li>
						))}
					</ol>
				</section>
			) : null}

			{docs.providers.length > 0 ? (
				<section aria-labelledby="sandcastle-providers">
					<SectionHead
						id="sandcastle-providers"
						title="Sandbox providers"
						href={`${SANDCASTLE_DOCS_PATH}/sandbox-providers`}
						linkLabel="Compare providers"
					/>
					<ul className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2 xl:grid-cols-4">
						{docs.providers.map((provider) => (
							<li
								key={provider.importPath}
								className="bg-background flex min-w-0 flex-col gap-3 px-[18px] py-7 sm:px-8"
							>
								<div className="flex items-center justify-between gap-3">
									<h3 className={TYPE.cardTitle}>{provider.name}</h3>
									<span className={cn(TYPE.badge, BADGE_OUTLINE)}>
										{provider.type}
									</span>
								</div>
								<code
									className={cn(
										TYPE.metaMark,
										'break-all text-[color:var(--ah-fg-muted)]',
									)}
								>
									{provider.importPath}
								</code>
							</li>
						))}
						{/* Fill the last row so the hairline grid keeps its edge. */}
						{Array.from({ length: (4 - (docs.providers.length % 4)) % 4 }).map(
							(_, index) => (
								<li
									key={index}
									aria-hidden
									className="bg-background hidden xl:block"
								/>
							),
						)}
						<li className="bg-background sm:col-span-2 xl:col-span-4">
							<Link
								href={`${SANDCASTLE_DOCS_PATH}/custom-sandbox-providers`}
								className="hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.06] group flex flex-col gap-1 px-[18px] py-5 transition-colors sm:flex-row sm:items-center sm:gap-4 sm:px-8"
							>
								<span className={cn(TYPE.cardTitle, 'shrink-0')}>
									Custom providers
								</span>
								<span className={cn(TYPE.metaSm, 'text-muted-foreground')}>
									{CUSTOM_PROVIDER}
								</span>
								<ArrowRight
									aria-hidden
									className="text-muted-foreground group-hover:text-foreground mt-1 size-4 shrink-0 transition group-hover:translate-x-0.5 motion-reduce:transition-none sm:ml-auto sm:mt-0"
								/>
							</Link>
						</li>
					</ul>
				</section>
			) : null}

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

			{/* What the README says about the repo itself, which the docs leave
			    out: its license, and where working on it is described. */}
			<footer className="px-[18px] py-8 sm:px-11">
				<p className={cn(TYPE.metaSm, 'text-muted-foreground text-pretty')}>
					{docs.license ? `Sandcastle is ${docs.license} licensed. ` : null}
					To work on Sandcastle itself, see{' '}
					<Link
						href={`${SANDCASTLE_README_URL}#development`}
						target="_blank"
						rel="noopener noreferrer"
						className="hover:text-foreground underline underline-offset-4 transition-colors"
					>
						Development in the README
					</Link>
					.
				</p>
			</footer>
		</div>
	)
}

function SectionHead({
	id,
	title,
	href,
	linkLabel,
}: {
	id: string
	title: string
	href?: string
	linkLabel?: string
}) {
	return (
		<div className="border-border flex flex-col gap-4 border-b px-[18px] pb-8 pt-12 sm:px-11 md:flex-row md:items-end">
			<h2 id={id} className={cn(TYPE.heading, 'text-balance')}>
				{title}
			</h2>
			{href && linkLabel ? (
				<Link
					href={href}
					className={cn(
						TYPE.meta,
						'hover:text-foreground group inline-flex shrink-0 items-center gap-1.5 text-[color:var(--ah-fg-subtle)] transition-colors md:ml-auto',
					)}
				>
					{linkLabel}
					<ArrowRight
						aria-hidden
						className="size-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
					/>
				</Link>
			) : null}
		</div>
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
