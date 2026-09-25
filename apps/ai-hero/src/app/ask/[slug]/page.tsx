import Image from 'next/image'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Logo } from '@/components/brand/logo'
import LayoutClient from '@/components/layout-client'
import { isSyntheticPrincipalId } from '@/lib/synthetic-principal'
import { log } from '@/server/logger'
import { checkSkillsWorkflowValuePathCertificateEligibility } from '@/lib/subscriber-marketing/value-path-certificates'
import {
	buildSkillsWorkflowCertificateShareImageUrl,
	buildSkillsWorkflowCertificateShareUrl,
	findSkillsWorkflowCertificateShare,
	SKILLS_WORKFLOW_CERTIFICATE_COURSE_NAME,
} from '@/lib/subscriber-marketing/value-path-certificate-shares'
import { Download, Plus } from 'lucide-react'

import {
	answerLandingPath,
	errorMessage,
	isCertificateAnswer as isCertificateAnswerPage,
	resolveAnswerLanding,
	type AnswerPage,
} from './answer-landing'
import { CertificateShareActions } from './certificate-share-actions'

/**
 * The emailed answer link lands here. A GET records nothing and emits
 * nothing: mail gateways fetch links before delivery and at click. With a
 * valid pt it renders the chosen answer and a confirm button that POSTs to
 * /ask/{slug}/confirm, the only place an answer is recorded. The confirm
 * redirects back with `confirmed=1`, which renders the result (read-only).
 */
export default async function ValuePathAnswerPage(props: {
	params: Promise<{ slug: string }>
	searchParams: Promise<{
		pt?: string
		answer?: string
		confirmed?: string
		retry?: string
	}>
}) {
	const [{ slug }, searchParams] = await Promise.all([
		props.params,
		props.searchParams,
	])
	const { token, answerPage } = await resolveAnswerLanding({
		slug,
		pt: searchParams.pt,
		answer: searchParams.answer,
	})
	if (!answerPage) notFound()

	const confirmed = searchParams.confirmed === '1'
	if (token.valid && !confirmed) {
		return (
			<ConfirmAnswerPage
				answerPage={answerPage}
				confirmPath={`/ask/${encodeURIComponent(slug)}/confirm`}
				pt={searchParams.pt}
				answer={searchParams.answer}
				retry={searchParams.retry === '1'}
			/>
		)
	}

	const isCertificateAnswer = isCertificateAnswerPage(answerPage)
	let certificateEligibilityUnavailable = false
	// Read-only: the confirm POST creates the share. A synthetic principal
	// never has one.
	const certificateEligibility =
		isCertificateAnswer &&
		token.valid &&
		!isSyntheticPrincipalId(token.payload.contactId)
			? await checkSkillsWorkflowValuePathCertificateEligibility({
					contactId: token.payload.contactId,
				}).catch(async (error) => {
					certificateEligibilityUnavailable = true
					await log.error('value-path.certificate.eligibility_failed', {
						slug,
						contactId: token.payload.contactId,
						error: errorMessage(error),
					})
					return undefined
				})
			: undefined
	const certificateShare =
		certificateEligibility?.eligible && certificateEligibility.contactId
			? await findSkillsWorkflowCertificateShare(
					certificateEligibility.contactId,
				).catch(() => null)
			: null

	if (certificateEligibility?.eligible && !certificateShare) {
		await log.warn('value-path.certificate.share_unavailable', {
			slug,
			contactId: certificateEligibility.contactId,
			reason: 'share-not-found',
		})
	}

	if (isCertificateAnswer && token.valid && certificateShare) {
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
				valuePathSlug={token.payload.valuePathResourceId}
			/>
		)
	}

	const retryPath = token.valid
		? answerLandingPath({
				slug,
				pt: searchParams.pt,
				answer: searchParams.answer,
			})
		: undefined

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
				<main
					className="border-border bg-card relative col-span-4 mx-auto flex w-full shrink-0 justify-center p-5 pt-10 sm:border sm:p-10"
					// Link tests assert this, not the page copy: an invalid pt still
					// renders the generic answer page. Carries no token or contact id.
					data-value-path-token={token.valid ? 'valid' : 'invalid'}
				>
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
							) : certificateEligibility?.eligible ? (
								<section
									className="border-l-2 border-amber-600 pl-5 text-base leading-7 dark:border-amber-300"
									data-value-path-certificate="share-unavailable"
								>
									Your certificate is ready, but the share page could not load.{' '}
									{retryPath ? (
										<Link className="underline" href={retryPath}>
											Try again
										</Link>
									) : (
										'Open this link again in a moment.'
									)}
								</section>
							) : certificateEligibilityUnavailable ? (
								<section
									className="border-l-2 border-amber-600 pl-5 text-base leading-7 dark:border-amber-300"
									data-value-path-certificate="eligibility-unavailable"
								>
									We could not load your certificate. Open this link again in a
									moment.
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
								data-value-path-answer="confirmed"
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
	valuePathSlug,
}: {
	answerPage: AnswerPage
	certificateImageUrl: string
	downloadUrl: string
	learnerName: string
	permalink: string
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
					<div className="px-[18px] py-16 sm:px-11 md:py-24">
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
					<div className="px-4 py-16 sm:px-8 md:py-24">
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
					<div className="grid gap-8 px-[18px] py-16 sm:px-11 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:gap-16 md:py-24">
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
					data-value-path-answer="confirmed"
				>
					Path token verified for {valuePathSlug}.
				</p>
			</main>
		</LayoutClient>
	)
}

function ConfirmAnswerPage({
	answerPage,
	confirmPath,
	pt,
	answer,
	retry,
}: {
	answerPage: AnswerPage
	confirmPath: string
	pt?: string
	answer?: string
	retry?: boolean
}) {
	const choice =
		answerPage.fields.title ??
		answerPage.fields.optionValue ??
		answerPage.fields.headline
	return (
		<LayoutClient withContainer withNavigation={false} withFooter={false}>
			<main
				className="mx-auto flex min-h-[100svh] w-full max-w-2xl flex-col justify-center gap-8 p-5 sm:p-10"
				data-value-path-token="valid"
				data-value-path-answer="unconfirmed"
			>
				<div className="space-y-3">
					<p className="text-primary text-sm font-medium uppercase tracking-[0.3em]">
						AI Hero Skills Workflow
					</p>
					<h1 className="font-heading text-balance text-4xl font-bold leading-tight">
						Confirm your answer
					</h1>
				</div>
				{retry ? (
					<p
						className="border-l-2 border-amber-600 pl-5 text-base leading-7 dark:border-amber-300"
						data-value-path-answer-retry="true"
					>
						We could not save your answer. Please confirm again.
					</p>
				) : null}
				{choice ? (
					<p className="text-lg leading-relaxed">
						You picked: <strong>{choice}</strong>
					</p>
				) : null}
				<form action={confirmPath} method="post">
					{pt ? <input name="pt" type="hidden" value={pt} /> : null}
					{answer ? <input name="answer" type="hidden" value={answer} /> : null}
					<button
						className="bg-primary text-primary-foreground inline-flex min-h-11 items-center justify-center px-6 py-2 font-medium"
						type="submit"
					>
						Confirm
					</button>
				</form>
			</main>
		</LayoutClient>
	)
}
