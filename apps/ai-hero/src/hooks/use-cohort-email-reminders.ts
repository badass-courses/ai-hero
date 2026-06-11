import { NewEmailSchema, type NewEmail } from '@/lib/emails'
import { api } from '@/trpc/react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

const DEFAULT_EMAIL = {
	title: 'Cohort Reminder Email',
	subject: `{{title}} starts soon, here is what to do next`,
	body: `Hey {{user.name | default: "there"}}!

{{title}} starts soon.

Please log in at {{url}} before the cohort begins and make sure you can access the workshop materials, Discord, and your account.

See you inside!`,
}

export const MARKDOWN_EDITOR_EXTENSIONS = [
	'{{user.name | default: "there"}}',
	'{{url}}',
	'{{title}}',
	'{{cohort.fields.title}}',
	'{{cohort.fields.slug}}',
	'{{cohort.fields.startsAt}}',
	'{{cohort.fields.description}}',
	'{{workshops.size}}',
]

export const CohortReminderScheduleSchema = z.object({
	hoursInAdvance: z.number().min(1).max(336).optional(),
	sendAt: z.string().datetime().nullable().optional(),
})

export type CohortReminderSchedule = z.infer<
	typeof CohortReminderScheduleSchema
>

type AttachEmailParams = {
	cohortId: string
	emailId: string
	schedule?: CohortReminderSchedule
}

type CreateAndAttachEmailParams = {
	cohortId: string
	input: NewEmail
	schedule?: CohortReminderSchedule
}

export const CohortReminderEmailFormSchema = NewEmailSchema.extend({
	emailId: z.string().optional(),
	cohortId: z.string().optional(),
	schedule: CohortReminderScheduleSchema.default({
		hoursInAdvance: 24,
		sendAt: null,
	}),
})

export type CohortReminderEmailForm = z.infer<
	typeof CohortReminderEmailFormSchema
>

export function useCohortEmailReminders(cohortId: string) {
	const form = useForm<CohortReminderEmailForm>({
		resolver: zodResolver(CohortReminderEmailFormSchema),
		defaultValues: {
			fields: {
				...DEFAULT_EMAIL,
			},
			schedule: {
				hoursInAdvance: 24,
				sendAt: null,
			},
		},
	})

	const onSubmit = (data: CohortReminderEmailForm) => {
		const { schedule, ...emailData } = data
		createAndAttachEmail({
			cohortId,
			input: emailData,
			schedule,
		})
	}

	const utils = api.useUtils()

	const { data: cohortEmails, status: cohortEmailsStatus } =
		api.cohorts.getCohortReminderEmails.useQuery({ cohortId })

	const { data: allEmails, status: allEmailsStatus } =
		api.cohorts.getAllCohortReminderEmails.useQuery()

	const {
		mutate: attachEmail,
		isPending: isAttachingEmail,
		variables: attachVariables,
	} = api.cohorts.attachReminderEmailToCohort.useMutation({
		onSettled: () => {
			utils.cohorts.getCohortReminderEmails.invalidate({ cohortId })
			utils.cohorts.getAllCohortReminderEmails.invalidate()
		},
	})

	const {
		mutate: detachEmail,
		isPending: isDetachingEmail,
		variables: detachVariables,
	} = api.cohorts.detachReminderEmailFromCohort.useMutation({
		onSettled: () => {
			utils.cohorts.getCohortReminderEmails.invalidate({ cohortId })
			utils.cohorts.getAllCohortReminderEmails.invalidate()
		},
	})

	const {
		mutate: createAndAttachEmail,
		isPending: isCreatingAndAttachingEmail,
	} = api.cohorts.createAndAttachReminderEmailToCohort.useMutation({
		onSettled: () => {
			utils.cohorts.getAllCohortReminderEmails.invalidate()
			utils.cohorts.getCohortReminderEmails.invalidate({ cohortId })
		},
		onSuccess: () => {
			form.reset()
		},
	})

	const {
		mutate: updateSchedule,
		isPending: isUpdatingSchedule,
		variables: updateScheduleVariables,
	} = api.cohorts.updateReminderEmailScheduleForCohort.useMutation({
		onSuccess: () => {
			utils.cohorts.getCohortReminderEmails.invalidate({ cohortId })
			utils.cohorts.getAllCohortReminderEmails.invalidate()
		},
	})

	const {
		mutate: updateEmail,
		isPending: isUpdatingEmail,
		variables: updateVariables,
	} = api.cohorts.updateReminderEmailForCohort.useMutation({
		onSuccess: () => {
			utils.cohorts.getCohortReminderEmails.invalidate({ cohortId })
			utils.cohorts.getAllCohortReminderEmails.invalidate()
		},
	})

	const {
		mutate: sendNow,
		isPending: isSendingNow,
		variables: sendNowVariables,
	} = api.cohorts.sendReminderEmailNowForCohort.useMutation({})

	const isLoading =
		cohortEmailsStatus === 'pending' ||
		allEmailsStatus === 'pending' ||
		isAttachingEmail ||
		isDetachingEmail ||
		isCreatingAndAttachingEmail ||
		isUpdatingSchedule ||
		isUpdatingEmail ||
		isSendingNow

	return {
		form,
		onSubmit,
		cohortEmails,
		allEmails,
		isLoading,
		isAttachingEmail,
		isDetachingEmail,
		isCreatingAndAttachingEmail,
		isUpdatingSchedule,
		isUpdatingEmail,
		isSendingNow,
		isDetachingEmailId: (emailId: string) =>
			isDetachingEmail && detachVariables?.emailId === emailId,
		isAttachingEmailId: (emailId: string) =>
			isAttachingEmail && attachVariables?.emailId === emailId,
		isUpdatingScheduleForEmail: (emailId: string) =>
			isUpdatingSchedule && updateScheduleVariables?.emailId === emailId,
		isUpdatingEmailId: (emailId: string) =>
			isUpdatingEmail && updateVariables?.emailId === emailId,
		isSendingNowForEmail: (emailId: string) =>
			isSendingNow && sendNowVariables?.emailId === emailId,
		attachEmail: (params: AttachEmailParams) => attachEmail(params),
		detachEmail: (params: AttachEmailParams) => detachEmail(params),
		createAndAttachEmail: (params: CreateAndAttachEmailParams) =>
			createAndAttachEmail(params),
		updateEmail: (params: CohortReminderEmailForm) => {
			if (params.emailId && params.cohortId) {
				updateEmail({
					emailId: params.emailId,
					cohortId: params.cohortId,
					fields: params.fields,
					schedule: params.schedule,
				})
			}
		},
		updateSchedule: (params: AttachEmailParams) => updateSchedule(params),
		sendNow: (params: { cohortId: string; emailId: string }) => sendNow(params),
	}
}
