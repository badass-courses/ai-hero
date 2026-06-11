import * as React from 'react'

export function SectionHeading({ children }: { children: React.ReactNode }) {
	return (
		<h2 className="mx-auto max-w-xl text-balance px-8 py-20 text-center font-sans text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
			{children}
		</h2>
	)
}

export function YellowStrong({ children }: { children: React.ReactNode }) {
	return <strong className="text-primary font-semibold">{children}</strong>
}
