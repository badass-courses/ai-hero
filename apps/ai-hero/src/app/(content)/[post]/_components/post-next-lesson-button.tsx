'use client'

import Link from 'next/link'
import { getNextUpResourceFromList } from '@/utils/get-nextup-resource-from-list'
import { ArrowRight } from 'lucide-react'

import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { useList } from './list-provider'

export function PostNextLessonButton({
	postId,
	className,
	label = 'Next lesson',
}: {
	postId: string
	className?: string
	label?: 'Next lesson' | 'Next page'
}) {
	const { list } = useList()
	const nextUp = list ? getNextUpResourceFromList(list, postId) : null

	if (!nextUp?.resource?.fields?.slug) return null

	return (
		<Button
			asChild
			size="default"
			variant="ghost"
			className={cn('rounded-full border', className)}
		>
			<Link href={`/${nextUp.resource.fields.slug}`} prefetch>
				{label}
				<ArrowRight className="text-muted-foreground ml-2 h-4 w-4" />
			</Link>
		</Button>
	)
}
