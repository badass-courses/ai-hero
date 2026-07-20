import Image from 'next/image'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Logo } from '@/components/brand/logo'
import LayoutClient from '@/components/layout-client'
import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { db } from '@/db'
import { VALUE_PATH_ANSWER_SELECTED_EVENT } from '@/inngest/events/value-path'
import { inngest } from '@/inngest/inngest.server'
import { redis } from '@/server/redis-client'
import { log } from '@/server/logger'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import { verifyValuePathToken } from '@/lib/subscriber-marketing/path-token'
import {
	getValuePathAnswerPageBySlug,
	SHARED_SKILLS_WORKFLOW_CERTIFICATE_ANSWER_SLUG,
} from '@/lib/subscriber-marketing/value-path-answer-page'
import { checkSkillsWorkflowValuePathCertificateEligibility } from '@/lib/subscriber-marketing/value-path-certificates'
import {
	buildSkillsWorkflowCertificateShareImageUrl,
	buildSkillsWorkflowCertificateShareUrl,
	ensureSkillsWorkflowCertificateShare,
	SKILLS_WORKFLOW_CERTIFICATE_COURSE_NAME,
} from '@/lib/subscriber-marketing/value-path-certificate-shares'
import { recordValuePathAnswerProgression } from '@/lib/subscriber-marketing/value-path-click-progression'
import { parseExecutorList } from '@/lib/subscriber-marketing/value-path-email-executor'
import {
	readActiveGateDRuntimeAllowlist,
	resolveGateDPreAuthorizedReviewReasons,
} from '@/lib/subscriber-marketing/value-path-gate-d-allowlist'
import { Download, Plus } from 'lucide-react'

import { CertificateShareActions } from './certificate-share-actions'

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
		expirationPolicy:
			slug === SHARED_SKILLS_WORKFLOW_CERTIFICATE_ANSWER_SLUG
				? 'allow-expired'
				: 'enforce',
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
	const certificateShareResult = certificateEligibility?.eligible
		? await ensureSkillsWorkflowCertificateShare({
				eligibility: certificateEligibility,
			}).catch(() => ({
				available: false as const,
				reason: 'share-persistence-failed',
			}))
		: undefined
	const certificateShare = certificateShareResult?.available
		? certificateShareResult.share
		: undefined

	if (certificateEligibility?.eligible && !certificateShare) {
		await log.warn('value-path.certificate.share_unavailable', {
			slug,
			contactId: certificateEligibility.contactId,
			reason:
				certificateShareResult && !certificateShareResult.available
					? certificateShareResult.reason
					: 'share-not-created',
		})
	}

	if (isCertificateAnswer && token.valid && answerAccepted && certificateShare) {
		const baseUrl = process.env.NEXT_PUBLIC_URL ?? 'https://www.aihero.dev'
		return (
			<CertificateTrophyPage
				answerPage={answerPage}
				certificateImageUrl={buildSkillsWorkflowCertificateShareImageUrl({
					slug: certificateShare.slug,
				})}
				downloadUrl={buildSkillsWorkflowCertificateShareImageUrl({
					slug: certificateShare.slug,
					download: true,
				})}
				learnerName={certificateShare.learnerName}
				permalink={buildSkillsWorkflowCertificateShareUrl({
					slug: certificateShare.slug,
					baseUrl,
				})}
				progressionStatus={progression?.status}
				valuePathSlug={token.payload.valuePathResourceId}
			/>
		)
	}

	return (
		<LayoutClient withContainer withNavigation={false} withFooter={false}>
			<div className="bg-size-[12px_12px] flex h-full min-h-[100svh] w-full grid-cols-6 grid-rows-[1fr_auto_1fr] bg-[radial-gradient(rgba(0,0,0,0.08)_1px,transparent_1px)] sm:grid sm:bg-none dark:bg-[radial-gradient(rgba(255,255,255,0.08)_1px,transparent_1px)] sm:dark:bg-none">
				<div className="hidden h-full w-full sm:flex" />
				<div className="border-border col-span-4 hidden h-full w-full items-start justify-center border-x p-10 sm:flex">
					<Link href="/">
						<span className="leading-none! inline-flex flex-col items-center justify-center gap-2 text-xl font-semibold">
							<Logo
								className="inline-flex opacity-80 transition-all ease-out hover:opacity-100"
								withAuthor={true}
							/>
						</span>
					</Link>
				</div>
				<div className="hidden h-full w-full sm:flex" />
				<div className="border-border bg-size-[12px_12px] hidden h-full w-full border-y bg-transparent bg-[radial-gradient(rgba(0,0,0,0.08)_1px,transparent_1px)] sm:flex dark:bg-[radial-gradient(rgba(255,255,255,0.08)_1px,transparent_1px)]" />
				<main className="border-border bg-card relative col-span-4 mx-auto flex w-full shrink-0 justify-center p-5 pt-10 sm:border sm:p-10">
					<Plus
						className="absolute -left-2 -top-2 hidden size-4 opacity-50 sm:block"
						strokeWidth={1}
					/>
					<Plus
						className="absolute -right-2 -top-2 hidden size-4 opacity-50 sm:block"
						strokeWidth={1}
					/>
					<div className="flex w-full max-w-2xl flex-col gap-8">
						<div className="space-y-3">
							<p className="text-primary text-sm font-medium uppercase tracking-[0.3em]">
								AI Hero Skills Workflow
							</p>
							<h1 className="font-heading text-balance text-4xl font-bold leading-tight md:text-5xl">
								{answerPage.fields.headline ??
									answerPage.fields.title ??
									'Good answer.'}
							</h1>
						</div>

						{answerPage.fields.body ? (
							<div className="whitespace-pre-wrap text-lg font-light leading-relaxed">
								{answerPage.fields.body}
							</div>
						) : null}

						{answerPage.fields.takeaway ? (
							<section className="border-primary border-l-2 pl-5 text-lg font-light leading-relaxed">
								{answerPage.fields.takeaway}
							</section>
						) : null}

						{answerPage.fields.nextNotice ? (
							<p className="text-muted-foreground text-base leading-7">
								{answerPage.fields.nextNotice}
							</p>
						) : null}

						{isCertificateAnswer ? (
							!token.valid ? (
								<section
									className="border-l-2 border-amber-600 pl-5 text-base leading-7 dark:border-amber-300"
									data-value-path-certificate="identity-unavailable"
								>
									Open the signed link from your course email to get your
									certificate.
								</section>
							) : !answerAccepted ? (
								<section
									className="border-l-2 border-amber-600 pl-5 text-base leading-7 dark:border-amber-300"
									data-value-path-certificate="answer-not-recorded"
								>
									We could not save your answer. Open the link again in a
									moment.
								</section>
							) : certificateEligibility?.eligible ? (
								<section
									className="border-l-2 border-amber-600 pl-5 text-base leading-7 dark:border-amber-300"
									data-value-path-certificate="share-unavailable"
								>
									Your certificate is ready, but the share page could not load.
									Open this link again in a moment.
								</section>
							) : (
								<section
									className="border-l-2 border-amber-600 pl-5 text-base leading-7 dark:border-amber-300"
									data-value-path-certificate="ineligible"
								>
									Your certificate unlocks after you complete the full Skills
									Workflow.
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
					</div>
					<Plus
						className="absolute -bottom-2 -left-2 hidden size-4 opacity-50 sm:block"
						strokeWidth={1}
					/>
					<Plus
						className="absolute -bottom-2 -right-2 hidden size-4 opacity-50 sm:block"
						strokeWidth={1}
					/>
				</main>
				<div className="border-border bg-size-[12px_12px] hidden h-full w-full border-y bg-transparent bg-[radial-gradient(rgba(0,0,0,0.08)_1px,transparent_1px)] sm:flex dark:bg-[radial-gradient(rgba(255,255,255,0.06)_1px,transparent_1px)]" />
				<div className="hidden h-full w-full sm:flex" />
				<div className="border-border col-span-4 hidden h-full w-full border-x sm:flex" />
				<div className="hidden h-full w-full sm:flex" />
			</div>
		</LayoutClient>
	)
}

function CertificateTrophyPage({
	answerPage,
	certificateImageUrl,
	downloadUrl,
	learnerName,
	permalink,
	progressionStatus,
	valuePathSlug,
}: {
	answerPage: NonNullable<
		Awaited<ReturnType<typeof getValuePathAnswerPageBySlug>>
	>
	certificateImageUrl: string
	downloadUrl: string
	learnerName: string
	permalink: string
	progressionStatus?: string
	valuePathSlug: string
}) {
	return (
		<LayoutClient
			withContainer
			withNavigation={false}
			withFooter={false}
			className="min-h-screen"
		>
			<main className="bg-background text-foreground min-h-screen">
				<section className="border-border border-b">
					<div className="px-8 py-16 sm:px-16 md:py-24 lg:px-24">
						<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
							Certificate of completion
						</p>
						<h1 className="mt-4 max-w-4xl text-balance text-4xl font-medium leading-tight tracking-tight sm:text-5xl lg:text-6xl">
							You finished the AI Hero Skills Workflow.
						</h1>
					</div>
				</section>

				<section
					className="border-border border-b"
					data-value-path-certificate="available"
				>
					<div className="px-4 py-16 sm:px-8 md:py-24 lg:px-16">
						<div className="border-border bg-card border p-1 sm:p-2">
							<Image
								alt={`${learnerName}'s ${SKILLS_WORKFLOW_CERTIFICATE_COURSE_NAME} certificate`}
								className="h-auto w-full"
								height={1190}
								priority
								src={certificateImageUrl}
								unoptimized
								width={1684}
							/>
						</div>
						<div className="mt-4 flex justify-end">
							<a
								className="focus-visible:ring-ring focus-visible:ring-offset-background inline-flex min-h-11 items-center justify-center gap-2 border border-border bg-background px-4 py-2 font-mono text-xs font-medium uppercase tracking-wider transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
								download
								href={downloadUrl}
							>
								<Download aria-hidden="true" className="size-4" />
								Download PNG
							</a>
						</div>
					</div>
				</section>

				<section>
					<div className="grid gap-8 px-8 py-16 sm:px-16 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:gap-16 md:py-24 lg:px-24">
						<div>
							<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
								Share the work
							</p>
						</div>
						<div className="max-w-[70ch] space-y-6">
							<p className="text-xl font-medium leading-relaxed tracking-tight sm:text-2xl">
								{answerPage.fields.headline ?? 'Noted. Your certificate is ready.'}
							</p>
							{answerPage.fields.body ? (
								<p className="text-base leading-relaxed opacity-80 sm:text-lg">
									{answerPage.fields.body}
								</p>
							) : null}
							{answerPage.fields.takeaway ? (
								<p className="text-base leading-relaxed opacity-80 sm:text-lg">
									{answerPage.fields.takeaway}
								</p>
							) : null}
							{answerPage.fields.nextNotice ? (
								<p className="text-muted-foreground text-base leading-relaxed sm:text-lg">
									{answerPage.fields.nextNotice}
								</p>
							) : null}
							<CertificateShareActions
								courseName={SKILLS_WORKFLOW_CERTIFICATE_COURSE_NAME}
								permalink={permalink}
							/>
						</div>
					</div>
				</section>

				<p
					className="sr-only"
					data-value-path-token="valid"
					data-value-path-progression={progressionStatus}
				>
					Path token verified for {valuePathSlug}.
				</p>
			</main>
		</LayoutClient>
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
