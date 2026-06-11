import * as React from 'react'

export function Prose({ children }: { children: React.ReactNode }) {
	return (
		<section className="border-border border-b">
			<div className="prose prose-lg dark:prose-invert prose-headings:font-sans prose-headings:tracking-tight prose-a:text-foreground prose-a:decoration-foreground/40 hover:prose-a:decoration-foreground prose-code:bg-muted prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.9em] prose-code:before:content-none prose-code:after:content-none prose-blockquote:border-l-2 prose-blockquote:border-foreground/30 mx-auto max-w-3xl px-8 py-16 sm:px-16 sm:py-24">
				{children}
			</div>
		</section>
	)
}
