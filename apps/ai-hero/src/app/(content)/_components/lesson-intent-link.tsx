'use client'

import type { ComponentPropsWithRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

type LessonIntentLinkProps = Omit<
	ComponentPropsWithRef<typeof Link>,
	'href' | 'prefetch'
> & { href: string }

export function LessonIntentLink({
	href,
	onMouseEnter,
	onFocus,
	...props
}: LessonIntentLinkProps) {
	const router = useRouter()

	return (
		<Link
			{...props}
			href={href}
			prefetch={false}
			onMouseEnter={(event) => {
				onMouseEnter?.(event)
				if (!event.defaultPrevented) router.prefetch(href)
			}}
			onFocus={(event) => {
				onFocus?.(event)
				if (!event.defaultPrevented) router.prefetch(href)
			}}
		/>
	)
}
