import React from 'react'
import { usePathname } from 'next/navigation'

import { type FeedbackFormValues } from '@coursebuilder/ui/feedback-widget'

import { sendFeedbackFromUser } from './feedback-actions'
import { FEEDBACK_FAILURE_MESSAGE } from './feedback-messages'

export const useFeedbackForm = ({ location }: { location: string }) => {
	const pathname = usePathname()
	const [isSubmitted, setIsSubmitted] = React.useState(false)
	const [error, setError] = React.useState<string>()

	const submitFeedbackForm = React.useCallback(
		async (values: FeedbackFormValues): Promise<boolean> => {
			try {
				const result = await sendFeedbackFromUser({
					feedbackText: values.text,
					context: values.context,
				})
				if (!result.ok) {
					setError(result.message)
					return false
				}
				setError(undefined)
				setIsSubmitted(true)
				return true
			} catch {
				setError(FEEDBACK_FAILURE_MESSAGE)
				return false
			}
		},
		[],
	)

	const initialValues: FeedbackFormValues = {
		text: '',
		context: {
			category: 'general',
			emotion: ':wave:',
			url: `${process.env.NEXT_PUBLIC_URL}${pathname}`,
			location,
		},
	}

	return {
		initialValues,
		submitFeedbackForm,
		isSubmitted,
		error,
	}
}
