import Link from 'next/link'
import type { SurveyWithQuestions } from '@/lib/surveys'
import { ChevronLeft } from 'lucide-react'

import { Button } from '@coursebuilder/ui'

import { SurveyDetailNav } from './survey-detail-nav'

export function SurveyDetailTemplate({
	survey,
	children,
}: {
	survey: SurveyWithQuestions
	children: React.ReactNode
}) {
	return (
		<main className="flex w-full justify-between p-10">
			<div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
				<div className="mb-5 flex w-full flex-col items-start gap-4">
					<Button variant="link" size="sm" asChild className="px-0">
						<Link href="/admin/surveys">
							<ChevronLeft className="size-4" />
							Back to Surveys
						</Link>
					</Button>
					<h1 className="font-heading text-xl font-bold sm:text-3xl">
						{survey.fields?.title || 'Untitled Survey'}
					</h1>
					<SurveyDetailNav slug={survey.fields?.slug ?? survey.id} />
				</div>
				{children}
			</div>
		</main>
	)
}
