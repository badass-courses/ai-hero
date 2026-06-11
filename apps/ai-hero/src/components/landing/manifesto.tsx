import * as React from 'react'

export function Manifesto({
	headline,
	children,
}: {
	headline: string
	children: React.ReactNode
}) {
	return (
		<section className="border-border grid grid-cols-1 gap-8 border-b px-8 py-12 sm:px-16 sm:py-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:gap-16">
			<h2 className="flex text-balance font-sans text-3xl font-semibold leading-tight tracking-tight sm:-mt-3 sm:py-16 sm:text-4xl md:py-24">
				{headline}
			</h2>
			<div className="flex flex-col gap-6 py-0 pl-0 text-base leading-relaxed opacity-80 sm:border-l sm:py-16 sm:pl-16 sm:text-lg md:py-24 md:pl-20">
				{children}
			</div>
		</section>
	)
}
