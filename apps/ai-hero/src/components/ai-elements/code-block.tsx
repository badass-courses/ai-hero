'use client'

import type { ComponentProps } from 'react'
import { cn } from '@coursebuilder/utils/cn'

export function CodeBlock({
	code,
	className,
	...props
}: ComponentProps<'pre'> & {
	code: string
	language?: string
}) {
	return (
		<pre className={cn('overflow-x-auto p-3 text-xs', className)} {...props}>
			<code>{code}</code>
		</pre>
	)
}
