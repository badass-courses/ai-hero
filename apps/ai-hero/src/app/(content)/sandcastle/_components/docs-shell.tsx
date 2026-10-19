import Link from 'next/link'
import { Icon } from '@/components/brand/icons'
import LayoutClient from '@/components/layout-client'
import { TYPE } from '@/components/landing/type'
import { HubLayout } from '@/components/navigation/hub-layout'
import {
	SANDCASTLE_DOCS_PATH,
	SANDCASTLE_PACKAGE,
	SANDCASTLE_REPO_URL,
	type SandcastleDocs,
} from '@/lib/sandcastle-docs'
import { ArrowUpRight, ChevronDown } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * The frame every Sandcastle page shares: the docs sidebar beside the page.
 * The hub sidebar starts as its icon rail, the call the dictionary makes for
 * the same reason — two full sidebars would squeeze the docs to a column.
 *
 * `current` is the open page's slug, or null on the landing page.
 */
export function SandcastleShell({
	docs,
	current,
	children,
}: {
	docs: SandcastleDocs
	current: string | null
	children: React.ReactNode
}) {
	const currentTitle =
		docs.pages.find((page) => page.slug === current)?.title ?? 'Overview'

	return (
		<LayoutClient withContainer withFooter={false}>
			<HubLayout sidebarDefaultCollapsed>
				<main className="bg-background text-foreground grid min-h-[calc(100vh-var(--nav-height))] grid-cols-1 lg:grid-cols-[16.5rem_minmax(0,1fr)]">
					<aside className="border-border lg:sticky lg:top-(--nav-height) lg:max-h-[calc(100vh-var(--nav-height))] lg:self-start lg:overflow-y-auto">
						{/* Phones get the same nav behind a disclosure, so the page is
						    the first thing on screen rather than twenty links. */}
						<details className="border-border group border-b lg:hidden">
							<summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-[18px] py-3 [&::-webkit-details-marker]:hidden">
								<span className={TYPE.groupLabel}>Sandcastle docs</span>
								<span
									className={cn(
										TYPE.nav,
										'flex items-center gap-2 font-medium',
									)}
								>
									{currentTitle}
									<ChevronDown
										aria-hidden
										className="size-3.5 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
									/>
								</span>
							</summary>
							<div className="border-border border-t">
								<DocsNav docs={docs} current={current} />
							</div>
						</details>
						<div className="hidden lg:block">
							<DocsNav docs={docs} current={current} />
						</div>
					</aside>
					<div className="border-border min-w-0 lg:border-l">{children}</div>
				</main>
			</HubLayout>
		</LayoutClient>
	)
}

const ROW = cn(
	TYPE.nav,
	'text-muted-foreground hover:text-foreground hover:bg-muted flex items-center rounded-sm px-2.5 py-[7px] transition-colors',
)

// The hub sidebar's active row (DESIGN rule 8): a solid ink fill in light, a
// gold wash with gold type in dark.
const ROW_ACTIVE = cn(
	'text-background bg-foreground hover:bg-foreground hover:text-background font-medium',
	'dark:bg-accent-fill/10 dark:text-primary dark:hover:bg-accent-fill/10 dark:hover:text-primary',
)

function DocsNav({
	docs,
	current,
}: {
	docs: SandcastleDocs
	current: string | null
}) {
	return (
		<nav aria-label="Sandcastle docs" className="flex flex-col gap-5 px-2 py-5">
			<Link
				href={SANDCASTLE_DOCS_PATH}
				prefetch={false}
				aria-current={current === null ? 'page' : undefined}
				className={cn(ROW, current === null && ROW_ACTIVE)}
			>
				Overview
			</Link>
			{docs.groups.map((group) => (
				<div key={group.title} className="flex flex-col gap-1">
					<p className={cn(TYPE.groupLabel, 'px-2.5 pb-1')}>{group.title}</p>
					<ul className="flex flex-col gap-px">
						{group.pages.map((page) => {
							const isCurrent = page.slug === current
							return (
								<li key={page.slug}>
									<Link
										href={page.href}
										prefetch={false}
										aria-current={isCurrent ? 'page' : undefined}
										className={cn(ROW, isCurrent && ROW_ACTIVE)}
									>
										{page.title}
									</Link>
								</li>
							)
						})}
					</ul>
				</div>
			))}
			<div className="border-border flex flex-col gap-px border-t pt-4">
				<ExternalRow href={SANDCASTLE_REPO_URL}>
					<Icon name="Github" className="size-3.5 shrink-0" />
					GitHub
				</ExternalRow>
				<ExternalRow
					href={`https://www.npmjs.com/package/${SANDCASTLE_PACKAGE}`}
				>
					npm
				</ExternalRow>
			</div>
		</nav>
	)
}

function ExternalRow({
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
			className={cn(ROW, 'gap-2')}
		>
			{children}
			<ArrowUpRight aria-hidden className="ml-auto size-3.5" />
		</Link>
	)
}
