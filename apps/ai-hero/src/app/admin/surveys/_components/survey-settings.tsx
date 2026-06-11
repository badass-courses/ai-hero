'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import type { SurveyWithQuestions } from '@/lib/surveys'

import {
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from '@coursebuilder/ui'

import SurveyCrudDialog from './survey-crud-dialog'

export function SurveySettings({
	survey: initialSurvey,
}: {
	survey: SurveyWithQuestions
}) {
	const [survey, setSurvey] = React.useState<SurveyWithQuestions>(initialSurvey)
	const router = useRouter()

	const handleUpdate = async (updatedSurvey: SurveyWithQuestions) => {
		const oldSlug = survey.fields?.slug
		const newSlug = updatedSurvey.fields?.slug

		setSurvey({ ...survey, fields: updatedSurvey.fields })

		if (oldSlug !== newSlug && newSlug) {
			router.push(`/admin/surveys/${newSlug}/settings`)
		}
	}

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between">
				<CardTitle>Survey Settings</CardTitle>
				<SurveyCrudDialog survey={survey} onSubmit={handleUpdate}>
					<Button variant="outline" size="sm">
						Edit Settings
					</Button>
				</SurveyCrudDialog>
			</CardHeader>
			<CardContent className="space-y-4">
				<div>
					<p className="text-sm font-medium">Title</p>
					<p className="text-muted-foreground text-sm">
						{survey.fields?.title}
					</p>
				</div>
				<div>
					<p className="text-sm font-medium">Slug</p>
					<p className="text-muted-foreground text-sm">{survey.fields?.slug}</p>
				</div>
				<div>
					<p className="text-sm font-medium">State</p>
					<p className="text-muted-foreground text-sm">
						{survey.fields?.state}
					</p>
				</div>
				<div>
					<p className="text-sm font-medium">Visibility</p>
					<p className="text-muted-foreground text-sm">
						{survey.fields?.visibility}
					</p>
				</div>
				<div>
					<p className="text-sm font-medium">After Completion Messages</p>
					<div className="mt-2 space-y-2 rounded-lg border p-3 text-sm">
						<div>
							<span className="font-medium">Ask for Email: </span>
							<span className="text-muted-foreground">
								{survey.fields?.afterCompletionMessages?.askForEmail?.title ||
									'Thank you for completing the survey!'}
							</span>{' '}
							<span className="text-muted-foreground">
								{survey.fields?.afterCompletionMessages?.askForEmail
									?.description ||
									'Please enter your email to receive updates and insights based on the survey results:'}
							</span>
						</div>
						<div>
							<span className="font-medium">Neutral: </span>
							<span className="text-muted-foreground">
								{survey.fields?.afterCompletionMessages?.neutral?.default}
							</span>
						</div>
						<div>
							<span className="font-medium">Correct: </span>
							<span className="text-muted-foreground">
								{survey.fields?.afterCompletionMessages?.correct?.default}
							</span>
						</div>
						<div>
							<span className="font-medium">Incorrect: </span>
							<span className="text-muted-foreground">
								{survey.fields?.afterCompletionMessages?.incorrect?.default}
							</span>
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	)
}
