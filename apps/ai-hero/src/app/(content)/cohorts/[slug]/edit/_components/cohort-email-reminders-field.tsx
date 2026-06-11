'use client'

import React, { useState } from 'react'
import { DateTimePicker } from './date-time-picker/date-time-picker'
import {
	CohortReminderEmailFormSchema,
	useCohortEmailReminders,
	MARKDOWN_EDITOR_EXTENSIONS,
	type CohortReminderEmailForm,
} from '@/hooks/use-cohort-email-reminders'
import type { Email } from '@/lib/emails'
import { api } from '@/trpc/react'
import { zodResolver } from '@hookform/resolvers/zod'
import { parseAbsolute } from '@internationalized/date'
import { Loader2, Mail, Pencil, Plus } from 'lucide-react'
import pluralize from 'pluralize'
import { useForm, type UseFormReturn } from 'react-hook-form'

import type { ContentResourceResource } from '@coursebuilder/core/schemas'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
	Input,
	Textarea,
	useToast,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/utils/cn'

const COHORT_TIMEZONE = 'America/Los_Angeles'

function formatPacificTime(value?: string | null) {
	if (!value) return null

	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return value

	return new Intl.DateTimeFormat('en-US', {
		timeZone: COHORT_TIMEZONE,
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		timeZoneName: 'short',
	}).format(date)
}

function getScheduleSummary(emailRef?: ContentResourceResource) {
	const metadata = emailRef?.metadata as
		| { sendAt?: string | null; hoursInAdvance?: number }
		| undefined

	if (metadata?.sendAt) {
		return `Exact send: ${formatPacificTime(metadata.sendAt)}`
	}

	if (typeof metadata?.hoursInAdvance === 'number') {
		return `${metadata.hoursInAdvance} hours before cohort start`
	}

	return 'Schedule not set'
}

export default function CohortEmailRemindersField({
	parentResourceId,
}: {
	parentResourceId: string
}) {
	const {
		cohortEmails,
		allEmails,
		form: createReminderForm,
		onSubmit: handleCreateEmail,
		isCreatingAndAttachingEmail,
	} = useCohortEmailReminders(parentResourceId)

	return (
		<div className="px-5 pt-5">
			<div className="mb-2 text-lg font-semibold">Cohort reminder emails</div>
			<ul className="flex flex-col gap-2">
				{cohortEmails?.map((cohortEmail) => {
					const cohortEmailRef = allEmails?.refs.find(
						(ref) =>
							ref.resourceOfId === parentResourceId &&
							ref.resourceId === cohortEmail.id,
					)

					return (
						<CohortReminderItem
							className="border-primary/50 bg-card/50 border-dashed transition-all duration-200 ease-in-out"
							isAttached={true}
							key={`current-cohort-reminder-email-${cohortEmail.id}`}
							email={cohortEmail}
							emailRef={cohortEmailRef}
							parentResourceId={parentResourceId}
							usedCount={
								allEmails?.refs.filter(
									(ref) =>
										ref.resourceId === cohortEmail.id &&
										ref.resourceOfId !== parentResourceId,
								).length
							}
						/>
					)
				})}

				{allEmails?.emails
					.filter(
						(email) =>
							!cohortEmails?.find((current) => current.id === email.id),
					)
					.map((email) => {
						const ref = allEmails?.refs.find(
							(item) => item.resourceId === email.id,
						)
						return (
							<CohortReminderItem
								isAttached={false}
								key={email.id}
								email={email}
								emailRef={ref}
								parentResourceId={parentResourceId}
								usedCount={
									allEmails?.refs.filter(
										(item) =>
											item.resourceId === email.id &&
											item.resourceOfId !== parentResourceId,
									).length
								}
							/>
						)
					})}
				{isCreatingAndAttachingEmail && (
					<div className="bg-card/50 flex animate-pulse items-center gap-2 rounded-md border px-3 py-2 shadow-sm">
						<Loader2 className="size-4 animate-spin" />
						Creating and attaching email...
					</div>
				)}
			</ul>
			<Dialog modal={true}>
				<DialogTrigger asChild>
					<Button className="mt-2" variant="secondary">
						<Plus className="size-4" /> Create Email
					</Button>
				</DialogTrigger>
				<DialogContent className="max-w-3xl">
					<DialogHeader>
						<DialogTitle className="inline-flex items-center text-lg font-semibold">
							<Mail className="mr-1 size-4" /> Reminder Email for This Cohort
						</DialogTitle>
						<DialogDescription>
							Set up a reminder email for this cohort. Use an exact send time
							for Friday, Sunday, doors open, and week 2 release emails. If
							exact send time is blank, hours before cohort start will be used.
						</DialogDescription>
					</DialogHeader>
					<CreateOrUpdateCohortReminderForm
						form={createReminderForm}
						onSubmit={handleCreateEmail}
					/>
				</DialogContent>
			</Dialog>
		</div>
	)
}

function CohortReminderItem({
	email,
	emailRef,
	isAttached,
	parentResourceId,
	className,
	usedCount,
}: {
	email: Email
	emailRef?: ContentResourceResource
	isAttached: boolean
	parentResourceId: string
	className?: string
	usedCount?: number
}) {
	const {
		attachEmail,
		detachEmail,
		updateEmail,
		isAttachingEmailId,
		isDetachingEmailId,
		isUpdatingEmailId,
	} = useCohortEmailReminders(parentResourceId)

	const metadata = emailRef?.metadata as
		| { sendAt?: string | null; hoursInAdvance?: number }
		| undefined

	const form = useForm<CohortReminderEmailForm>({
		resolver: zodResolver(CohortReminderEmailFormSchema),
		defaultValues: {
			emailId: email.id,
			cohortId: parentResourceId,
			fields: {
				title: email.fields?.title ?? '',
				subject: email.fields?.subject ?? '',
				body: email.fields?.body ?? '',
			},
			schedule: {
				hoursInAdvance: metadata?.hoursInAdvance ?? 24,
				sendAt: metadata?.sendAt ?? null,
			},
		},
	})

	return (
		<li
			className={cn(
				'flex items-center justify-between gap-2 rounded-md border px-3 py-2 shadow-sm',
				className,
			)}
		>
			<Dialog modal={true}>
				<DialogTrigger>
					<div className="flex flex-col items-start">
						<span className="text-primary inline-flex cursor-pointer items-center gap-1 text-left font-semibold transition-colors hover:underline">
							{isUpdatingEmailId(email.id) ? (
								<Loader2 className="size-3 animate-spin" />
							) : (
								<Pencil className="size-3" />
							)}
							{email.fields?.title}
						</span>
						<div className="flex flex-col text-left">
							<span className="text-muted-foreground inline-flex items-center gap-2 text-sm">
								{getScheduleSummary(emailRef)}
							</span>
							{(usedCount ?? 0) > 0 && (
								<span className="text-muted-foreground inline-flex items-center gap-2 text-sm">
									{usedCount} other {pluralize('cohort', usedCount)} using this
									template
								</span>
							)}
						</div>
					</div>
				</DialogTrigger>
				<DialogContent className="max-w-3xl">
					<DialogHeader>
						<DialogTitle className="inline-flex items-center text-lg font-semibold">
							<Mail className="mr-1 size-4" /> {email.fields?.title}
						</DialogTitle>
						<DialogDescription>
							Edit the reminder email for this{' '}
							{(usedCount ?? 0) > 0
								? `and ${usedCount} other ${pluralize('cohort', usedCount)}.`
								: 'cohort.'}
						</DialogDescription>
					</DialogHeader>
					<CreateOrUpdateCohortReminderForm
						form={form}
						onSubmit={updateEmail}
					/>
				</DialogContent>
			</Dialog>
			<div className="flex items-center gap-2">
				<SendNowConfirmDialog cohortId={parentResourceId} email={email} />
				{isAttached ? (
					<Button
						size="sm"
						variant="outline"
						type="button"
						disabled={isDetachingEmailId(email.id)}
						onClick={() =>
							detachEmail({
								cohortId: parentResourceId,
								emailId: email.id,
							})
						}
					>
						Detach
						{isDetachingEmailId(email.id) && (
							<Loader2 className="size-4 animate-spin" />
						)}
					</Button>
				) : (
					<Button
						size="sm"
						variant="default"
						type="button"
						disabled={isAttachingEmailId(email.id)}
						onClick={() =>
							attachEmail({
								cohortId: parentResourceId,
								emailId: email.id,
								schedule: {
									hoursInAdvance: metadata?.hoursInAdvance ?? 24,
									sendAt: metadata?.sendAt ?? null,
								},
							})
						}
					>
						Attach
						{isAttachingEmailId(email.id) && (
							<Loader2 className="size-4 animate-spin" />
						)}
					</Button>
				)}
			</div>
		</li>
	)
}

function CreateOrUpdateCohortReminderForm({
	form,
	onSubmit,
}: {
	form: UseFormReturn<CohortReminderEmailForm>
	onSubmit: (data: CohortReminderEmailForm) => void
}) {
	const bodyRef = React.useRef<HTMLTextAreaElement>(null)
	const insertAtCursor = (text: string) => {
		const el = bodyRef.current
		if (!el) return
		const start = el.selectionStart
		const end = el.selectionEnd
		const current = el.value
		const next = current.slice(0, start) + text + current.slice(end)
		form.setValue('fields.body', next)
		requestAnimationFrame(() => {
			el.focus()
			el.setSelectionRange(start + text.length, start + text.length)
		})
	}

	const currentValues = form.watch()
	const defaultValues = form.formState.defaultValues
	const isUpdating = !!currentValues.emailId
	const hasChanges = isUpdating
		? currentValues.fields?.title !== defaultValues?.fields?.title ||
			currentValues.fields?.subject !== defaultValues?.fields?.subject ||
			currentValues.fields?.body !== defaultValues?.fields?.body ||
			currentValues.schedule?.hoursInAdvance !==
				defaultValues?.schedule?.hoursInAdvance ||
			currentValues.schedule?.sendAt !== defaultValues?.schedule?.sendAt
		: true

	return (
		<Form {...form}>
			<form className="flex flex-col gap-4">
				<FormField
					control={form.control}
					name="fields.title"
					render={({ field }) => (
						<FormItem>
							<FormLabel>Title</FormLabel>
							<FormControl>
								<Input {...field} />
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>
				<FormField
					control={form.control}
					name="schedule.sendAt"
					render={({ field }) => (
						<FormItem>
							<FormLabel>Exact send time</FormLabel>
							<FormControl>
								<DateTimePicker
									value={
										field.value
											? parseAbsolute(field.value, COHORT_TIMEZONE)
											: null
									}
									onChange={(date) => {
										field.onChange(
											date ? date.toDate(COHORT_TIMEZONE).toISOString() : null,
										)
									}}
									granularity="minute"
									shouldCloseOnSelect={false}
								/>
							</FormControl>
							<FormMessage />
							<div className="text-muted-foreground text-sm">
								Use this for friendly send times like Friday 9am PT. If set,
								this overrides hours before cohort start.
							</div>
							{field.value && (
								<Button
									type="button"
									variant="outline"
									onClick={() => field.onChange(null)}
								>
									Clear exact send time
								</Button>
							)}
						</FormItem>
					)}
				/>
				<FormField
					control={form.control}
					name="schedule.hoursInAdvance"
					render={({ field }) => (
						<FormItem>
							<FormLabel>Hours before cohort start</FormLabel>
							<FormControl>
								<Input
									type="number"
									min={1}
									max={336}
									value={field.value ?? ''}
									onChange={(event) => {
										const value = event.target.value
										field.onChange(value ? parseInt(value, 10) : undefined)
									}}
								/>
							</FormControl>
							<FormMessage />
							<div className="text-muted-foreground text-sm">
								Fallback schedule. Use this only when you want reminder timing
								tied directly to cohort start.
							</div>
						</FormItem>
					)}
				/>
				<FormField
					control={form.control}
					name="fields.subject"
					render={({ field }) => (
						<FormItem>
							<FormLabel>Email Subject</FormLabel>
							<FormControl>
								<Input {...field} value={field.value ?? ''} />
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>
				<FormField
					control={form.control}
					name="fields.body"
					render={({ field }) => (
						<FormItem>
							<FormLabel>Email Body (markdown)</FormLabel>
							<Textarea
								{...field}
								ref={bodyRef}
								className="min-h-[300px] font-mono"
								onChange={(event) => {
									form.setValue('fields.body', event.target.value)
								}}
								value={field.value?.toString() ?? ''}
							/>
							<div className="inline-flex flex-wrap gap-1">
								{MARKDOWN_EDITOR_EXTENSIONS.map((item) => (
									<button
										type="button"
										onClick={() => insertAtCursor(item)}
										key={item}
										className="bg-card hover:bg-card/80 text-primary hover:text-foreground border-border flex flex-shrink-0 items-center rounded-full border px-2 py-1 text-sm transition-all ease-in-out hover:cursor-pointer"
									>
										{item}
									</button>
								))}
							</div>
							<FormMessage />
						</FormItem>
					)}
				/>
				<div className="flex w-full flex-col gap-2">
					<DialogTrigger asChild>
						<Button
							disabled={!hasChanges}
							type="button"
							onClick={() => {
								form.handleSubmit(onSubmit)()
							}}
						>
							{isUpdating ? 'Update' : 'Create'}
						</Button>
					</DialogTrigger>
					{isUpdating && (
						<Button
							disabled={!hasChanges}
							variant="outline"
							type="button"
							onClick={() => form.reset()}
						>
							Reset
						</Button>
					)}
				</div>
			</form>
		</Form>
	)
}

function SendNowConfirmDialog({
	cohortId,
	email,
}: {
	cohortId: string
	email: Email
}) {
	const [open, setOpen] = useState(false)
	const { toast } = useToast()

	const { data: preview, isLoading: isLoadingPreview } =
		api.cohorts.previewReminderEmailForCohort.useQuery(
			{ cohortId, emailId: email.id },
			{ enabled: open },
		)

	const { mutate: sendNow, isPending: isSending } =
		api.cohorts.sendReminderEmailNowForCohort.useMutation({
			onSuccess: (result) => {
				setOpen(false)
				toast({
					title: `Sent ${result.sent} email${result.sent !== 1 ? 's' : ''}`,
					description:
						result?.errorCount && result.errorCount > 0
							? `${result.errorCount} failed`
							: 'All emails sent successfully',
					variant:
						result?.errorCount && result.errorCount > 0
							? 'destructive'
							: 'default',
				})
			},
			onError: (error) => {
				toast({
					title: 'Failed to send',
					description: error.message,
					variant: 'destructive',
				})
			},
		})

	return (
		<AlertDialog open={open} onOpenChange={setOpen}>
			<AlertDialogTrigger asChild>
				<Button size="sm" variant="outline">
					<Mail className="mr-1 size-3" /> Send Now
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent className="max-w-2xl">
				<AlertDialogHeader>
					<AlertDialogTitle>Send Reminder Email Now</AlertDialogTitle>
					<AlertDialogDescription>
						This will immediately send &ldquo;{email.fields?.title}&rdquo; to
						all current cohort learners.
					</AlertDialogDescription>
				</AlertDialogHeader>

				{isLoadingPreview ? (
					<div className="flex items-center justify-center py-8">
						<Loader2 className="size-6 animate-spin" />
					</div>
				) : preview ? (
					<div className="space-y-4">
						<div>
							<h4 className="mb-2 text-sm font-medium">
								Recipients ({preview.recipientCount})
							</h4>
							<div className="max-h-32 overflow-y-auto rounded border p-2 text-sm">
								{preview.recipients.map((recipient) => (
									<div
										key={recipient.email}
										className="flex justify-between py-0.5"
									>
										<span>{recipient.name || 'Unknown'}</span>
										<span className="text-muted-foreground">
											{recipient.email}
										</span>
									</div>
								))}
								{preview.recipientCount === 0 && (
									<p className="text-muted-foreground">No recipients found</p>
								)}
							</div>
						</div>

						<div>
							<h4 className="mb-1 text-sm font-medium">Subject</h4>
							<div className="bg-muted rounded border p-2 text-sm">
								{preview.subject}
							</div>
						</div>

						<div>
							<h4 className="mb-1 text-sm font-medium">Body Preview</h4>
							<pre className="text-muted-foreground max-h-48 overflow-y-auto whitespace-pre-wrap rounded border p-3 text-sm">
								{preview.body}
							</pre>
						</div>
					</div>
				) : null}

				<AlertDialogFooter>
					<AlertDialogCancel disabled={isSending}>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={(event) => {
							event.preventDefault()
							sendNow({ cohortId, emailId: email.id })
						}}
						disabled={isSending || !preview || preview.recipientCount === 0}
					>
						{isSending ? (
							<>
								<Loader2 className="mr-2 size-4 animate-spin" />
								Sending...
							</>
						) : (
							`Send to ${preview?.recipientCount ?? 0} recipient${
								(preview?.recipientCount ?? 0) !== 1 ? 's' : ''
							}`
						)}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
