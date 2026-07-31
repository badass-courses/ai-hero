import * as React from 'react'

import { cn } from '@coursebuilder/utils/cn'

import { TYPE } from './type'

export function SectionHeading({ children }: { children: React.ReactNode }) {
	return (
		<h2 className={cn(TYPE.heading, 'mx-auto max-w-xl text-balance px-8 py-20 text-center font-sans')}>
			{children}
		</h2>
	)
}

export function YellowStrong({ children }: { children: React.ReactNode }) {
	return <strong className="text-primary font-semibold">{children}</strong>
}
