'use client'

import Link from 'next/link'
import { useSelectedLayoutSegment } from 'next/navigation'

import { Button } from '@coursebuilder/ui'

const tabs = [
	{ key: 'questions', label: 'Questions' },
	{ key: 'settings', label: 'Settings' },
	{ key: 'responses', label: 'Responses' },
] as const

export function SurveyDetailNav({ slug }: { slug: string }) {
	const segment = useSelectedLayoutSegment()
	const activeTab = segment ?? 'questions'
	const basePath = `/admin/surveys/${slug}`

	return (
		<div className="flex flex-wrap gap-2">
			{tabs.map((tab) => (
				<Button
					key={tab.key}
					variant={activeTab === tab.key ? 'default' : 'outline'}
					size="sm"
					asChild
				>
					<Link href={`${basePath}/${tab.key}`}>{tab.label}</Link>
				</Button>
			))}
		</div>
	)
}
