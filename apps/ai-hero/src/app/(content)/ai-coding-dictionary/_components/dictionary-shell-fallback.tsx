import * as React from 'react'
import { Search } from 'lucide-react'

import type { DictionarySection } from '@/lib/ai-coding-dictionary'

import { sectionId } from './section-id'

/**
 * Server-rendered layout shell that mirrors `<DictionaryShell>`'s grid +
 * sidebar shape exactly. Used as the Suspense fallback so the swap from
 * fallback → hydrated client shell doesn't shift any layout.
 *
 * Visual fidelity is structural only — no InstantSearch context, so the
 * search input is a non-interactive placeholder and the section nav has
 * no active-state highlight. The real shell takes over those bits as soon
 * as it hydrates.
 */
export function DictionaryShellFallback({
	sections,
	children,
}: {
	sections: DictionarySection[]
	children: React.ReactNode
}) {
	return (
		<>
			<div
				aria-hidden
				className="border-border bg-background sticky top-(--nav-height) z-20 flex h-14 items-center border-b lg:hidden"
			>
				<Search
					aria-hidden
					className="text-muted-foreground pointer-events-none ml-5 size-4"
				/>
				<span className="text-muted-foreground/80 ml-3 font-mono text-sm">
					Search the dictionary...
				</span>
			</div>
			<section className="border-border grid grid-cols-1 border-b lg:grid-cols-[18rem_minmax(0,1fr)]">
				<aside className="border-border bg-background lg:sticky lg:top-(--nav-height) lg:max-h-[calc(100vh-var(--nav-height))] lg:self-start lg:overflow-y-auto">
					<div
						aria-hidden
						className="border-border hidden h-14 items-center border-b lg:flex"
					>
						<Search
							aria-hidden
							className="text-muted-foreground pointer-events-none ml-5 size-4"
						/>
						<span className="text-muted-foreground/80 ml-3 font-mono text-sm">
							Search the dictionary...
						</span>
					</div>
					<nav aria-label="Dictionary sections" className="flex flex-col">
						<p className="text-muted-foreground border-border border-b px-6 py-3 font-mono text-[10px] font-medium uppercase tracking-wider">
							Sections
						</p>
						<ul className="flex flex-col">
							{sections.map((section) => {
								const id = sectionId(section.title)
								return (
									<li key={section.title} className="border-border border-b">
										<a
											href={`#${id}`}
											className="text-muted-foreground hover:text-foreground hover:bg-muted/30 group flex items-center justify-between gap-3 px-6 py-3 text-sm transition-colors"
										>
											<span className="flex min-w-0 items-center gap-2">
												<span aria-hidden className="text-primary opacity-50">
													#
												</span>
												<span className="truncate font-medium">
													{section.title}
												</span>
											</span>
											<span className="text-muted-foreground/70 font-mono text-[10px] tabular-nums">
												{section.entries.length}
											</span>
										</a>
									</li>
								)
							})}
						</ul>
					</nav>
				</aside>
				<div className="border-border min-w-0 lg:border-l">{children}</div>
			</section>
		</>
	)
}
