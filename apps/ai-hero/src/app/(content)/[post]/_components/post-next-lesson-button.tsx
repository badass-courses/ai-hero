'use client'

import Link from 'next/link'
import { getNextUpResourceFromList } from '@/utils/get-nextup-resource-from-list'
import { ArrowRight } from 'lucide-react'

import { Button } from '@coursebuilder/ui'

import { useList } from './list-provider'

export function PostNextLessonButton({ postId }: { postId: string }) {
	const { list } = useList()
	const nextUp = list ? getNextUpResourceFromList(list, postId) : null

	if (!nextUp?.resource?.fields?.slug) return null

	return (
		<Button
			asChild
			size="default"
			variant="ghost"
			className="rounded-full border"
		>
			<Link href={`/${nextUp.resource.fields.slug}`} prefetch>
				Next lesson
				<ArrowRight className="text-muted-foreground ml-2 h-4 w-4" />
			</Link>
		</Button>
	)
}
