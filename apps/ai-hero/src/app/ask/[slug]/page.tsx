import { notFound } from 'next/navigation'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { db } from '@/db'
import { VALUE_PATH_ANSWER_SELECTED_EVENT } from '@/inngest/events/value-path'
import { inngest } from '@/inngest/inngest.server'
import { redis } from '@/server/redis-client'
import { log } from '@/server/logger'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { verifyValuePathToken } from '@/lib/subscriber-marketing/path-token'
import { getValuePathAnswerPageBySlug } from '@/lib/subscriber-marketing/value-path-answer-page'
import {
	buildSkillsWorkflowValuePathCertificateUrl,
	checkSkillsWorkflowValuePathCertificateEligibility,
} from '@/lib/subscriber-marketing/value-path-certificates'
import { recordValuePathAnswerProgression } from '@/lib/subscriber-marketing/value-path-click-progression'
import { parseExecutorList } from '@/lib/subscriber-marketing/value-path-email-executor'
import {
	readActiveGateDRuntimeAllowlist,
	resolveGateDPreAuthorizedReviewReasons,
} from '@/lib/subscriber-marketing/value-path-gate-d-allowlist'

export default async function ValuePathAnswerPage(props: {
	params: Promise<{ slug: string }>
	searchParams: Promise<{ pt?: string; answer?: string }>
}) {
	const [{ slug }, searchParams] = await Promise.all([
		props.params,
		props.searchParams,
	])
	const token = verifyValuePathToken({
		token: searchParams.pt,
		secret: getPathTokenSecret(),
	})
	const answerPage = await getValuePathAnswerPageBySlug({
		slug,
		optionValue: searchParams.answer,
		sequenceId: token.valid ? token.payload.sequenceId : undefined,
		emailId: token.valid
			? emailIdFromResourceId(token.payload.emailResourceId)
			: undefined,
	})
	if (!answerPage) notFound()
	if (!token.valid) {
		await log.warn('value-path.ask.token_invalid', {
			slug,
			reason: token.reason,
			hasToken: Boolean(searchParams.pt),
		})
	}

	const runtimeAllowlistDecision = token.valid
		? await readActiveGateDRuntimeAllowlist({ redis })
		: undefined
	const runtimeAllowlist = runtimeAllowlistDecision?.passed
		? runtimeAllowlistDecision.allowlist
		: undefined
	const progression =
		token.valid && runtimeAllowlist
			? await recordValuePathAnswerProgression({
					repository: new DrizzleCaptureMarketingRepository(db),
					finisherFieldProvider: emailListProvider,
					token: token.payload,
					answerPage,
					mode: runtimeAllowlist.mode,
					sendGate: {
						allowedActions: runtimeAllowlist.allowedActions,
						allowlistedContactIds: runtimeAllowlist.contactIds,
						allowlistedKitSubscriberIds: runtimeAllowlist.kitSubscriberIds,
						allowlistedEmails: runtimeAllowlist.emails,
						enabledValuePathSlugs: runtimeAllowlist.pathSlugs,
						verifiedEmailResourceIds: runtimeAllowlist.emailResourceIds,
						verifiedKitSequenceIds: runtimeAllowlist.kitSequenceIds,
					},
					acceptedReviewReasons: resolveGateDPreAuthorizedReviewReasons({
						allowlist: runtimeAllowlist,
						legacyEnvReviewReasons: parseExecutorList(
							process.env.AIH_VALUE_PATH_ACCEPTED_REVIEW_REASONS,
						),
					}),
				})
			: undefined

	if (token.valid && !runtimeAllowlist) {
		await log.warn('value-path.ask.authorization_blocked', {
			slug,
			contactId: token.payload.contactId,
			reviewReasons: runtimeAllowlistDecision?.reviewReasons ?? [
				'gate-d-allowlist-missing',
			],
		})
	}

	if (token.valid && runtimeAllowlist && progression?.status !== 'recorded') {
		await log.warn('value-path.ask.progression_not_recorded', {
			slug,
			contactId: token.payload.contactId,
			status: progression?.status,
			reviewReasons: progression?.reviewReasons,
		})
	}

	if (progression?.status === 'recorded' && token.valid) {
		await log.info('value-path.ask.answer_recorded', {
			slug,
			contactId: token.payload.contactId,
			valuePathSlug: token.payload.valuePathResourceId,
			emailResourceId: token.payload.emailResourceId,
			contactEventId: progression.contactEventId,
			finisherCapture: progression.finisherCapture,
		})
		await inngest.send({
			name: VALUE_PATH_ANSWER_SELECTED_EVENT,
			data: {
				contactId: token.payload.contactId,
				valuePathSlug: token.payload.valuePathResourceId,
				sentEmailResourceId: token.payload.emailResourceId,
				answerPageId: answerPage.id,
				contactEventId: progression.contactEventId,
			},
		})
	}

	const isCertificateAnswer =
		answerPage.fields.emailId === 'email-7' ||
		answerPage.fields.emailId === 'team-email-7'
	const answerAccepted =
		progression?.status === 'recorded' ||
		progression?.status === 'idempotent-noop'
	const certificateEligibility =
		isCertificateAnswer && token.valid && answerAccepted
			? await checkSkillsWorkflowValuePathCertificateEligibility({
					contactId: token.payload.contactId,
				})
			: undefined
	const certificateUrl =
		certificateEligibility?.eligible && certificateEligibility.contactId
			? buildSkillsWorkflowValuePathCertificateUrl({
					contactId: certificateEligibility.contactId,
				})
			: undefined

	return (
		<main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-8 px-6 py-16 text-white">
			<div className="space-y-3">
				<p className="text-sm font-medium uppercase tracking-[0.3em] text-cyan-300">
					AI Hero Skills Workflow
				</p>
				<h1 className="text-balance text-4xl font-semibold leading-tight md:text-5xl">
					{answerPage.fields.headline ??
						answerPage.fields.title ??
						'Good answer.'}
				</h1>
			</div>

			{answerPage.fields.body ? (
				<div className="whitespace-pre-wrap text-lg leading-8 text-slate-200">
					{answerPage.fields.body}
				</div>
			) : null}

			{answerPage.fields.takeaway ? (
				<section className="border-l-2 border-cyan-300 pl-5 text-lg leading-8 text-slate-100">
					{answerPage.fields.takeaway}
				</section>
			) : null}

			{answerPage.fields.nextNotice ? (
				<p className="text-base leading-7 text-slate-300">
					{answerPage.fields.nextNotice}
				</p>
			) : null}

			{isCertificateAnswer ? (
				!token.valid ? (
					<section
						className="border-l-2 border-amber-300 pl-5 text-base leading-7 text-slate-200"
						data-value-path-certificate="identity-unavailable"
					>
						Open the signed link from your course email to get your certificate.
					</section>
				) : !answerAccepted ? (
					<section
						className="border-l-2 border-amber-300 pl-5 text-base leading-7 text-slate-200"
						data-value-path-certificate="answer-not-recorded"
					>
						We could not save your answer. Open the link again in a moment.
					</section>
				) : certificateUrl ? (
					<section data-value-path-certificate="available">
						<a
							className="inline-flex min-h-12 items-center justify-center bg-cyan-300 px-6 py-3 text-base font-semibold text-slate-950 transition hover:bg-cyan-200"
							href={certificateUrl}
							target="_blank"
							rel="noreferrer"
						>
							Get your certificate
						</a>
					</section>
				) : (
					<section
						className="border-l-2 border-amber-300 pl-5 text-base leading-7 text-slate-200"
						data-value-path-certificate="ineligible"
					>
						Your certificate unlocks after you complete the full Skills Workflow.
					</section>
				)
			) : null}

			{token.valid ? (
				<p
					className="sr-only"
					data-value-path-token="valid"
					data-value-path-progression={progression?.status}
				>
					Path token verified for {token.payload.valuePathResourceId}.
				</p>
			) : (
				<p className="sr-only" data-value-path-token={token.reason}>
					Path token unavailable.
				</p>
			)}
		</main>
	)
}

function emailIdFromResourceId(resourceId: string) {
	const [, emailId] = resourceId.split(/\.(.+)/)
	return emailId
}

function getPathTokenSecret() {
	return (
		process.env.AI_HERO_VALUE_PATH_TOKEN_SECRET ?? 'dev-value-path-token-secret'
	)
}
