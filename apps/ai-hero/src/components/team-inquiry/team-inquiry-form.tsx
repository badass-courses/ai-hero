'use client'

import * as React from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { CheckIcon, XCircleIcon } from 'lucide-react'
import { WORKSHOP_CTA_BUTTON } from '@/app/(content)/workshops/_components/workshop-cta-button'
import { useForm } from 'react-hook-form'

import {
	Button,
	Form,
	Input,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Textarea,
} from '@coursebuilder/ui'
import Spinner from '@coursebuilder/ui/primitives/spinner'
import { cn } from '@coursebuilder/ui/utils/cn'

import { COUNTRIES } from './countries'
import { sendTeamInquiry } from './team-inquiry-actions'
import {
	getTeamInquirySchema,
	TRAINING_TOPICS,
	TRAINING_TIMINGS,
	type TeamInquiryFormValues,
} from './team-inquiry-schema'

const SuccessMessage = ({ message }: { message: string }) => (
	<div
		aria-live="polite"
		className="bg-background text-foreground flex flex-wrap items-center justify-center rounded px-5 py-4 text-center text-sm font-semibold"
	>
		<CheckIcon className="mr-1 h-4 w-4" aria-hidden="true" />{' '}
		<span>{message}</span>
	</div>
)

const ErrorMessage = ({ children }: React.PropsWithChildren) => (
	<div
		aria-live="polite"
		className="bg-destructive text-destructive-foreground flex items-center justify-center rounded-md px-5 py-3 font-medium leading-tight"
	>
		<XCircleIcon className="mr-2 h-6 w-6" aria-hidden="true" /> Error:{' '}
		{children}
	</div>
)

export const TeamInquiryForm: React.FC<{
	location: string
	/**
	 * Names the product the inquiry is about in the email Joel reads, e.g. a
	 * workshop slug. Defaults to "Direct" on the server.
	 */
	source?: string
}> = ({ location, source }) => {
	const [isSubmitted, setIsSubmitted] = React.useState(false)
	const [error, setError] = React.useState<string>()

	const form = useForm<TeamInquiryFormValues>({
		resolver: zodResolver(getTeamInquirySchema(source)),
		defaultValues: {
			name: '',
			email: '',
			companyName: '',
			teamSize: '1-10',
			message: '',
			...(source === 'training-partners'
				? {
						country: '',
						trainingLocation: 'same' as const,
						partnerPreference: 'none' as const,
						specificPartner: '',
						topics: [],
					}
				: {}),
			website: '',
			timestamp: new Date().toISOString(),
		},
	})

	const fieldError = (field: keyof TeamInquiryFormValues) => {
		const error = form.formState.errors[field]
		return error ? (
			<p id={`${field}-error`} role="alert" className="text-destructive">
				{error.message}
			</p>
		) : null
	}
	const routingSelect = (
		field:
			| 'country'
			| 'trainingCountry'
			| 'trainingLocation'
			| 'engineersToTrain'
			| 'format'
			| 'timing'
			| 'partnerPreference',
		label: string,
		options: readonly { value: string; label: string }[],
		required = false,
	) => (
		<div className="space-y-2">
			<Label htmlFor={field}>{label}</Label>
			<select
				{...form.register(field)}
				id={field}
				required={required}
				className="border-input bg-background text-foreground focus-visible:ring-ring focus-visible:ring-offset-background h-12 w-full rounded-[9px] border px-3 focus-visible:ring-2 focus-visible:ring-offset-2"
				aria-invalid={!!form.formState.errors[field]}
				aria-describedby={
					form.formState.errors[field] ? `${field}-error` : undefined
				}
			>
				{required && <option value="">Choose an option</option>}
				{options.map(({ value, label }) => (
					<option key={value} value={value}>
						{label}
					</option>
				))}
			</select>
			{fieldError(field)}
		</div>
	)
	const countryOptions = COUNTRIES.map(({ code, name }) => ({
		value: code,
		label: `${code}: ${name}`,
	}))
	const liveTraining = form.watch('trainingType') === 'live'

	const onSubmit = async (values: TeamInquiryFormValues) => {
		// Check if submission is too fast (less than 3 seconds)
		const submissionTime = new Date()
		const startTime = new Date(values.timestamp)
		const timeDiff = submissionTime.getTime() - startTime.getTime()

		if (timeDiff < 3000) {
			setError('Please try again')
			return
		}

		const result = await sendTeamInquiry({
			...values,
			context: {
				url: location,
				source,
			},
		})

		if (result.error) {
			setError(result.error)
		} else {
			setIsSubmitted(true)
			form.reset({
				...form.formState.defaultValues,
				timestamp: new Date().toISOString(),
			})
		}
	}

	return (
		<Form {...form}>
			<form
				onSubmit={form.handleSubmit(onSubmit)}
				className="flex flex-col space-y-5"
			>
				<input type="hidden" {...form.register('timestamp')} />

				{/* Honeypot field - visually hidden but available to bots */}
				<div className="absolute left-[-9999px] top-[-9999px] h-0 w-0 opacity-0">
					<Label htmlFor="website">Website</Label>
					<Input
						{...form.register('website')}
						id="website"
						type="text"
						tabIndex={-1}
					/>
				</div>

				<div className="grid gap-5 md:grid-cols-2">
					<div className="space-y-2">
						<Label htmlFor="name">Name</Label>
						<Input {...form.register('name')} id="name" />
					</div>
					<div className="space-y-2">
						<Label htmlFor="email">Email</Label>
						<Input {...form.register('email')} id="email" type="email" />
					</div>
					<div className="space-y-2">
						<Label htmlFor="companyName">Company Name</Label>
						<Input {...form.register('companyName')} id="companyName" />
					</div>
					<div className="space-y-2">
						<Label htmlFor="teamSize">Team Size</Label>
						<Select
							onValueChange={(value) =>
								form.setValue(
									'teamSize',
									value as TeamInquiryFormValues['teamSize'],
								)
							}
							value={form.watch('teamSize')}
						>
							<SelectTrigger id="teamSize">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="1-10">1-10 employees</SelectItem>
								<SelectItem value="11-50">11-50 employees</SelectItem>
								<SelectItem value="51-200">51-200 employees</SelectItem>
								<SelectItem value="201+">201+ employees</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</div>

				{source === 'training-partners' && (
					<>
						{routingSelect('country', 'Country', countryOptions, true)}
						{routingSelect(
							'trainingLocation',
							'Where will the training happen?',
							[
								{ value: 'same', label: 'In the same country' },
								{ value: 'elsewhere', label: 'Somewhere else' },
							],
						)}
						{form.watch('trainingLocation') === 'elsewhere' &&
							routingSelect(
								'trainingCountry',
								'Training country',
								countryOptions,
								true,
							)}
						<fieldset
							className="min-w-0 space-y-3"
							aria-describedby={
								form.formState.errors.trainingType
									? 'training-type-error'
									: undefined
							}
						>
							<legend className="font-medium">What do you need?</legend>
							{[
								{ value: 'live', label: 'Live training for my team' },
								{ value: 'self-paced', label: 'Self-paced seats for my team' },
							].map(({ value, label }) => (
								<Label key={value} className="flex items-center gap-3">
									<input
										{...form.register('trainingType')}
										type="radio"
										value={value}
										required
										aria-invalid={!!form.formState.errors.trainingType}
									/>
									{label}
								</Label>
							))}
							{form.formState.errors.trainingType && (
								<p
									id="training-type-error"
									role="alert"
									className="text-destructive"
								>
									{form.formState.errors.trainingType.message}
								</p>
							)}
						</fieldset>
						{liveTraining && (
							<>
								{routingSelect(
									'engineersToTrain',
									'Engineers to train',
									['1-9', '10-25', '26-50', '51+'].map((value) => ({
										value,
										label: value,
									})),
									true,
								)}
								{routingSelect(
									'format',
									'Format',
									['Onsite', 'Remote', 'Either'].map((value) => ({
										value,
										label: value,
									})),
									true,
								)}
								<fieldset
									className="min-w-0 space-y-3"
									aria-describedby={
										form.formState.errors.topics ? 'topics-error' : undefined
									}
								>
									<legend className="font-medium">
										Topics (choose at least one)
									</legend>
									{TRAINING_TOPICS.map((topic) => (
										<Label key={topic} className="flex items-center gap-3">
											<input
												{...form.register('topics')}
												type="checkbox"
												value={topic}
												aria-invalid={!!form.formState.errors.topics}
											/>
											{topic}
										</Label>
									))}
									{fieldError('topics')}
								</fieldset>
								{routingSelect(
									'timing',
									'Timing',
									TRAINING_TIMINGS.map((value) => ({ value, label: value })),
									true,
								)}
								{routingSelect(
									'partnerPreference',
									'Partner preference (optional)',
									[
										{ value: 'none', label: 'No preference' },
										{ value: 'specific', label: 'A specific partner' },
									],
								)}
								{form.watch('partnerPreference') === 'specific' && (
									<div className="space-y-2">
										<Label htmlFor="specificPartner">Partner name</Label>
										<Input
											{...form.register('specificPartner')}
											id="specificPartner"
											maxLength={120}
											required
											aria-invalid={!!form.formState.errors.specificPartner}
											aria-describedby={
												form.formState.errors.specificPartner
													? 'specificPartner-error'
													: undefined
											}
										/>
										{fieldError('specificPartner')}
									</div>
								)}
							</>
						)}
					</>
				)}

				<div className="space-y-2">
					<Label htmlFor="message">Message (Optional)</Label>
					<Textarea
						{...form.register('message')}
						id="message"
						placeholder="Tell us about your team and what you're looking to achieve..."
						className="min-h-[100px]"
					/>
				</div>

				{/* The house gold CTA, same object as the workshop buy button. */}
				<Button
					type="submit"
					size="lg"
					disabled={form.formState.isSubmitting}
					className={cn(WORKSHOP_CTA_BUTTON, 'w-full')}
				>
					{form.formState.isSubmitting ? (
						<>
							<Spinner className="w-4" aria-hidden="true" /> Sending...
						</>
					) : source === 'training-partners' ? (
						'Send inquiry'
					) : (
						'Get team pricing'
					)}
				</Button>

				{isSubmitted && (
					<SuccessMessage message="Thanks for your interest! We'll be in touch soon." />
				)}
				{error && <ErrorMessage>{error}</ErrorMessage>}
			</form>
		</Form>
	)
}
