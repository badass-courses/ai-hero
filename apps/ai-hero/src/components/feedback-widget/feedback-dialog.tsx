'use client'

import * as React from 'react'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import Spinner from '@/components/spinner'
import {
	getEmoji,
	type FeedbackFormValues,
	useFeedback,
} from '@coursebuilder/ui/feedback-widget'
import { Button, Label, RadioGroup, RadioGroupItem, Textarea } from '@coursebuilder/ui'

import { cn } from '@coursebuilder/utils/cn'

import { useFeedbackForm } from './use-feedback-form'

const EMOTIONS = [':heart_eyes:', ':wave:', ':sob:'] as const
const CATEGORIES = ['general', 'help', 'code'] as const

/** App-owned feedback dialog with phone-safe geometry and controls. */
export function FeedbackDialog() {
	const { isFeedbackDialogOpen, setIsFeedbackDialogOpen, location } =
		useFeedback()
	const contentRef = React.useRef<HTMLDivElement>(null)

	return (
		<Dialog
			open={isFeedbackDialogOpen}
			onOpenChange={(open) => setIsFeedbackDialogOpen(open, 'navigation')}
		>
			<DialogContent
				ref={contentRef}
				tabIndex={-1}
				onOpenAutoFocus={(event) => {
					event.preventDefault()
					contentRef.current?.focus({ preventScroll: true })
				}}
				className={cn(
					'max-h-[calc(100dvh-1rem)] overflow-x-hidden overflow-y-auto overscroll-contain sm:max-w-lg',
					// On a phone this is deliberately a bottom sheet. It stays inside
					// the visual viewport, leaves a clear backdrop above for dismissal,
					// and keeps the home-indicator area out of the form controls.
					'max-sm:bottom-0 max-sm:left-0 max-sm:right-0 max-sm:top-auto max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:rounded-t-[14px] max-sm:border-x-0 max-sm:border-b-0 max-sm:p-5 max-sm:pb-[calc(1rem+env(safe-area-inset-bottom))]',
					'motion-reduce:animate-none',
				)}
			>
				<DialogHeader className="pr-8 text-left">
					<DialogTitle>Send Feedback</DialogTitle>
					<DialogDescription>
						Tell us what worked, what felt off, or what you need next.
					</DialogDescription>
				</DialogHeader>
				<FeedbackForm location={location} />
			</DialogContent>
		</Dialog>
	)
}

export function FeedbackForm({ location }: { location: string }) {
	const { initialValues, submitFeedbackForm, isSubmitted, error } =
		useFeedbackForm({ location })
	const [values, setValues] = React.useState<FeedbackFormValues>(initialValues)
	const [isSubmitting, setIsSubmitting] = React.useState(false)
	const { setIsFeedbackDialogOpen } = useFeedback()

	const updateContext = <Key extends 'emotion' | 'category'>(
		key: Key,
		value: FeedbackFormValues['context'][Key],
	) => {
		setValues((current) => ({
			...current,
			context: { ...current.context, [key]: value },
		}))
	}

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!values.text.trim() || isSubmitting) return
		setIsSubmitting(true)
		try {
			await submitFeedbackForm({ ...values, text: values.text.trim() })
		} finally {
			setIsSubmitting(false)
		}
	}

	if (isSubmitted && !error) {
		return (
			<div className="flex flex-col items-start gap-4" role="status">
				<p className="text-foreground text-sm">
					Thanks—your feedback is on its way.
				</p>
				<Button
					type="button"
					variant="outline"
					onClick={() => setIsFeedbackDialogOpen(false)}
				>
					Close
				</Button>
			</div>
		)
	}

	return (
		<form onSubmit={handleSubmit} className="flex min-w-0 flex-col gap-5">
			<div className="flex flex-col gap-2">
				<Label htmlFor="feedback-text" className="font-semibold">
					What should we know?
				</Label>
				<Textarea
					id="feedback-text"
					name="feedback"
					value={values.text}
					onChange={(event) =>
						setValues((current) => ({
							...current,
							text: event.target.value,
						}))
					}
					placeholder="What happened, and what would feel better?…"
					autoComplete="off"
					className="min-h-32 resize-y text-base sm:min-h-36 sm:text-sm"
					required
				/>
			</div>

			<div className="grid min-w-0 gap-5 sm:grid-cols-2">
				<fieldset className="min-w-0">
					<legend className="mb-2 text-sm font-semibold">How did it feel?</legend>
					<RadioGroup
						value={values.context.emotion}
						onValueChange={(value) =>
							updateContext(
								'emotion',
								value as FeedbackFormValues['context']['emotion'],
							)
						}
						className="grid grid-cols-3 gap-2"
					>
						{EMOTIONS.map((emotion) => {
							const emoji = getEmoji(emotion)
							const selected = values.context.emotion === emotion
							return (
								<Label
									key={emotion}
									htmlFor={`feedback-emotion-${emotion}`}
									className={cn(
										'focus-within:ring-ring flex min-h-11 cursor-pointer items-center justify-center rounded-[9px] border text-xl transition-colors focus-within:ring-2 focus-within:ring-offset-2',
										selected
											? 'border-primary bg-primary/10'
											: 'border-input hover:bg-muted',
									)}
								>
									<RadioGroupItem
										id={`feedback-emotion-${emotion}`}
										value={emotion}
										className="sr-only"
									/>
									<span aria-hidden>{emoji.image}</span>
									<span className="sr-only">{emoji.label}</span>
								</Label>
							)
						})}
					</RadioGroup>
				</fieldset>

				<fieldset className="min-w-0">
					<legend className="mb-2 text-sm font-semibold">What is it about?</legend>
					<RadioGroup
						value={values.context.category}
						onValueChange={(value) =>
							updateContext(
								'category',
								value as FeedbackFormValues['context']['category'],
							)
						}
						className="grid grid-cols-3 gap-2"
					>
						{CATEGORIES.map((category) => {
							const selected = values.context.category === category
							return (
								<Label
									key={category}
									htmlFor={`feedback-category-${category}`}
									className={cn(
										'focus-within:ring-ring flex min-h-11 min-w-0 cursor-pointer items-center justify-center rounded-[9px] border px-2 text-sm capitalize transition-colors focus-within:ring-2 focus-within:ring-offset-2',
										selected
											? 'border-primary bg-primary/10'
											: 'border-input hover:bg-muted',
									)}
								>
									<RadioGroupItem
										id={`feedback-category-${category}`}
										value={category}
										className="sr-only"
									/>
									<span className="truncate">{category}</span>
								</Label>
							)
						})}
					</RadioGroup>
				</fieldset>
			</div>

			{values.context.category === 'code' ? (
				<p className="text-muted-foreground text-sm">
					For help with code or an exercise, ask in the{' '}
					<a
						href="/discord"
						target="_blank"
						rel="noreferrer"
						className="text-primary font-medium underline underline-offset-4"
					>
						Discord community
					</a>
					.
				</p>
			) : (
				<Button
					type="submit"
					size="lg"
					disabled={isSubmitting || !values.text.trim()}
					className="min-h-11 touch-manipulation text-base sm:text-sm"
				>
					{isSubmitting ? (
						<>
							<Spinner className="size-4" aria-hidden /> Sending…
						</>
					) : (
						'Send Feedback'
					)}
				</Button>
			)}

			{error ? (
				<p className="text-destructive text-sm" role="alert">
					We could not send your feedback. Please try again.
				</p>
			) : null}
		</form>
	)
}
