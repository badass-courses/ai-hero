import React from 'react'
import Spinner from '@/components/spinner'
import { api } from '@/trpc/react'
import { CheckCircle, LockKeyhole } from 'lucide-react'

type ValuePathCompletionResultProps = {
	kitSubscriberId?: string | number
	email?: string
}

export function isSkillsWorkflowCompletionSurvey(surveyId: string) {
	return surveyId === 'skills-workflow-completion'
}

export function ValuePathCompletionResult({
	kitSubscriberId,
	email,
}: ValuePathCompletionResultProps) {
	const eligibility = api.certificate.valuePathEligibility.useQuery(
		{
			resourceIdOrSlug: 'value-path:ai-hero-skills-workflow',
			kitSubscriberId,
			email,
		},
		{
			enabled: Boolean(kitSubscriberId || email),
		},
	)

	if (!kitSubscriberId && !email) {
		return (
			<div className="flex flex-col gap-3 py-10 text-center">
				<h2 className="text-2xl font-bold">Your answers are saved.</h2>
				<p className="text-muted-foreground mx-auto max-w-xl text-base">
					Sign in or use the survey link from your email so we can connect your
					certificate to your workflow progress.
				</p>
			</div>
		)
	}

	if (eligibility.status === 'pending') {
		return (
			<div className="flex items-center justify-center gap-3 py-10 text-center text-lg">
				<Spinner className="size-5" /> <span>Checking certificate...</span>
			</div>
		)
	}

	if (!eligibility.data?.eligible) {
		return (
			<div className="flex flex-col items-center gap-3 py-10 text-center">
				<LockKeyhole className="text-muted-foreground size-8" />
				<h2 className="text-2xl font-bold">Your answers are saved.</h2>
				<p className="text-muted-foreground mx-auto max-w-xl text-base">
					Your certificate unlocks after you complete the full Skills Workflow.
				</p>
			</div>
		)
	}

	const certificateUrl = `/api/certificates?resource=${encodeURIComponent(
		eligibility.data.resourceIdOrSlug,
	)}&user=${encodeURIComponent(eligibility.data.contactId ?? '')}`

	return (
		<div className="flex flex-col items-center gap-4 py-10 text-center">
			<CheckCircle className="size-8 text-emerald-600 dark:text-emerald-300" />
			<div className="space-y-2">
				<h2 className="text-2xl font-bold">Nice. Your certificate is ready.</h2>
				<p className="text-muted-foreground mx-auto max-w-xl text-base">
					Your answers are saved. Download your AI Hero Skills Workflow
					certificate when you are ready.
				</p>
			</div>
			<a
				className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center justify-center px-4 py-2 text-sm font-medium"
				href={certificateUrl}
				target="_blank"
				rel="noreferrer"
			>
				Download certificate
			</a>
		</div>
	)
}
