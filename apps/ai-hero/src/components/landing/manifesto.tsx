import * as React from 'react'

import { TYPE } from './type'

import { cn } from '@coursebuilder/utils/cn'

export function Manifesto({
	headline,
	children,
}: {
	headline: string
	children: React.ReactNode
}) {
	return (
		<section className="border-border grid grid-cols-1 gap-8 border-b px-8 py-12 sm:px-16 sm:py-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:gap-16">
			<h2 className={cn(TYPE.heading, 'flex text-balance font-sans sm:-mt-3 sm:py-16 md:py-24')}>
				{headline}
			</h2>
			<div className={cn(TYPE.body, 'flex flex-col gap-6 py-0 pl-0 opacity-80 sm:border-l sm:py-16 sm:pl-16 md:py-24 md:pl-20')}>
				{children}
			</div>
		</section>
	)
}
