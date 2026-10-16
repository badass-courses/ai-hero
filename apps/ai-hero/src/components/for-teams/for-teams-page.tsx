import * as React from 'react'
import Link from 'next/link'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import { BADGE_NEUTRAL, TYPE } from '@/components/landing/type'
import LayoutClient from '@/components/layout-client'
import { TeamInquiryForm } from '@/components/team-inquiry/team-inquiry-form'
import { TeamInvoiceForm } from '@/components/team-invoice/team-invoice-form'
import { WORKSHOP_CTA_BUTTON } from '@/app/(content)/workshops/_components/workshop-cta-button'
import { ArrowLeft, ArrowRight, Percent, Receipt, User } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

/** What a seat is, for the person deciding how many to buy. */
export const SEAT_FACTS = [
	{ icon: User, text: 'One licence per engineer, yours to assign from your account' },
	{ icon: Percent, text: 'Volume pricing from five seats, applied in the card' },
	{
		icon: Receipt,
		text: 'Pay by card, or by invoice with your company details and tax ID',
	},
] as const

/** The inner pad every band shares (DESIGN rules 1 and 3). */
export const FOR_TEAMS_INNER = 'px-[18px] py-12 sm:px-11 md:py-[52px]'

const OUTLINE_BUTTON =
	'border-foreground/20 hover:bg-secondary focus-visible:ring-ring inline-flex h-[46px] items-center justify-center rounded-[9px] border px-5 text-[15px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2'

const INNER = FOR_TEAMS_INNER

export type ForTeamsInvoice = {
	productId: string
	/** `request` hands the details to support instead of sending an invoice. */
	mode: 'invoice' | 'request'
	/** Replaces the band's lead, e.g. when seats open. */
	lead?: string
}

export type ForTeamsPageProps = {
	/** The product page this team page belongs to. */
	backHref: string
	title: string
	description?: string | null
	/** The cover, already sized for a 16:9 frame. */
	cover?: React.ReactNode
	/** One line under the hero actions. */
	heroNote?: string
	/** The compiled `forTeamsBody`. */
	story: React.ReactNode
	/** The team pricing card. Null means no checkout on this page. */
	seats: React.ReactNode | null
	/** "Pay by invoice". Null hides the band. */
	invoice: ForTeamsInvoice | null
	/** The page path, for the inquiry and invoice context. */
	location: string
	/** Names the product in the inquiry email, e.g. a slug. */
	source: string
}

/**
 * The team story for one product: `/workshops/[module]/for-teams` and
 * `/cohorts/[slug]/for-teams`.
 *
 * The page owns the order: hero, the authored story, proof, seats, invoice,
 * contact. The product's `forTeamsBody` supplies everything between the hero
 * and the proof. The things a champion came to do (buy seats, get an invoice,
 * ask a question) are anchors in the hero and sections at the end, so the page
 * reads top to bottom as pitch, then action.
 *
 * Callers decide the 404: no body, no page, because nothing alerts on a
 * chrome-only 200.
 */
export function ForTeamsPage({
	backHref,
	title,
	description,
	cover,
	heroNote = 'One licence per person. Everyone learns on their own schedule.',
	story,
	seats,
	invoice,
	location,
	source,
}: ForTeamsPageProps) {
	return (
		<LayoutClient withContainer>
			<main className="flex min-h-screen w-full flex-col">
				{/* Hero: a balanced editorial split (DESIGN rule 4), the cover at
				    its own 16:9 on the right. The cover is a card with the title
				    drawn into it, so it is never cropped: it sits on the column's
				    ground at the gutter, not stretched to fill it. */}
				<header className="relative overflow-hidden border-b">
					<div className="relative z-10 flex flex-col-reverse md:grid md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
						<div className="flex w-full flex-col items-start px-[18px] pb-12 pt-8 sm:px-11 md:justify-center md:py-[52px]">
							<Link
								href={backHref}
								className={cn(
									TYPE.metaSm,
									'text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-1.5 transition-colors',
								)}
							>
								<ArrowLeft className="size-3.5" aria-hidden="true" />
								{title}
							</Link>
							<span className={cn(TYPE.badge, BADGE_NEUTRAL, 'mb-5')}>
								For teams
							</span>
							<h1 className={cn(TYPE.title, 'max-w-[18ch] text-balance')}>
								{title} for your team
							</h1>
							{description && (
								<p
									className={cn(
										TYPE.lead,
										'text-foreground/80 mt-5 max-w-[60ch] text-balance',
									)}
								>
									{description}
								</p>
							)}
							<div className="mt-8 flex flex-wrap items-center gap-3">
								{seats ? (
									<a
										href="#seats"
										className={cn(WORKSHOP_CTA_BUTTON, 'inline-flex items-center')}
									>
										Buy team seats
									</a>
								) : invoice ? (
									<a
										href="#invoice"
										className={cn(WORKSHOP_CTA_BUTTON, 'inline-flex items-center')}
									>
										{invoice.mode === 'invoice'
											? 'Pay by invoice'
											: 'Request an invoice'}
									</a>
								) : null}
								{/* Every ask stays on this page, so none wears an arrow. */}
								<a href="#contact" className={OUTLINE_BUTTON}>
									Get a quote for your team
								</a>
							</div>
							<p className={cn(TYPE.metaSm, 'text-muted-foreground mt-4')}>
								{heroNote}
							</p>
						</div>
						{cover && (
							<div className="flex items-center px-[18px] pb-2 pt-8 sm:px-11 md:border-l md:py-[52px]">
								<div className="relative aspect-video w-full overflow-hidden rounded-[9px]">
									{cover}
								</div>
							</div>
						)}
					</div>
					<div className="absolute right-0 top-0 z-0 w-full">
						<div
							className="bg-stripes opacity-8! h-[320px] w-full"
							aria-hidden="true"
						/>
						<div
							className="to-background via-background bg-linear-to-bl absolute left-0 top-0 z-10 h-full w-full from-transparent"
							aria-hidden="true"
						/>
					</div>
				</header>

				{/* The authored story. Prose at the article measure, the same
				    typography the product's own body gets. */}
				<section className="border-b">
					<article
						className={cn(
							// Centred at the article measure, the way the landing's Prose
							// block sits, rather than hugging the left edge of a wide band.
							'prose dark:prose-invert sm:prose-lg prose-headings:tracking-tight mx-auto max-w-3xl',
							INNER,
						)}
					>
						{story}
					</article>
				</section>

				<section className="border-b">
					<CompanyLogoGrid className="pt-8" />
				</section>

				{/* Seats: the same pricing card the product page shows, booted in
				    team mode so the stepper, per-seat price, coupons and sold-out
				    states are the ones checkout already trusts. */}
				{seats && (
					<section
						id="seats"
						aria-labelledby="seats-title"
						className="scroll-mt-(--nav-height) border-b"
					>
						<div className="grid grid-cols-1 md:grid-cols-6">
							<div
								className={cn(
									'col-span-3 flex flex-col justify-center lg:col-span-4',
									INNER,
								)}
							>
								<p className={cn(TYPE.groupLabel, 'mb-4')}>Self-serve</p>
								<h2 id="seats-title" className={cn(TYPE.heading, 'max-w-[20ch]')}>
									Bring the course to your team.
								</h2>
								<p
									className={cn(
										TYPE.lead,
										'text-foreground/80 mt-5 max-w-[52ch]',
									)}
								>
									Choose how many seats you need and buy online. Every seat
									is a full licence, and you assign them from your account
									whenever you are ready.
								</p>
								<ul className="mt-8 flex max-w-[52ch] flex-col">
									{SEAT_FACTS.map(({ icon: Icon, text }) => (
										<li
											key={text}
											className={cn(
												TYPE.meta,
												'flex items-center gap-3 border-t border-[color:var(--ah-line-soft)] py-3 font-normal first:border-t-0 first:pt-0 last:pb-0',
											)}
										>
											<span className="border-border bg-background flex size-9 shrink-0 items-center justify-center rounded-[6px] border text-[color:var(--ah-fg-muted)]">
												<Icon className="size-4" aria-hidden="true" />
											</span>
											{text}
										</li>
									))}
								</ul>
								<a
									href={invoice ? '#invoice' : '#contact'}
									className={cn(
										TYPE.meta,
										'text-muted-foreground hover:text-foreground mt-6 inline-flex items-center gap-1.5 underline-offset-4 hover:underline',
									)}
								>
									{invoice
										? 'Need an invoice up front? Pay by invoice'
										: 'Need an invoice up front or a bigger group? Get a quote'}
									<ArrowRight className="size-3.5" aria-hidden="true" />
								</a>
							</div>
							<div className="col-span-3 flex flex-col md:border-l lg:col-span-2">
								{seats}
							</div>
						</div>
					</section>
				)}

				{/* Invoice: the seats above, paid by bank transfer or card from a
				    Stripe invoice instead of at checkout. Priced on the server from
				    the team rules; the form never carries a price. */}
				{invoice && (
					<section
						id="invoice"
						aria-labelledby="invoice-title"
						className="scroll-mt-(--nav-height) border-b"
					>
						<div className="grid grid-cols-1 md:grid-cols-6">
							<div className={cn('col-span-3 lg:col-span-2', INNER)}>
								<p className={cn(TYPE.groupLabel, 'mb-4')}>Invoice</p>
								<h2 id="invoice-title" className={cn(TYPE.heading)}>
									{invoice.mode === 'invoice'
										? 'Pay by invoice'
										: 'Request an invoice'}
								</h2>
								<p
									className={cn(
										TYPE.lead,
										'text-foreground/80 mt-5 max-w-[40ch]',
									)}
								>
									{invoice.lead ??
										(invoice.mode === 'invoice'
											? 'Tell us who to bill and how many seats. We email the billing address a link to confirm, then Stripe sends the invoice at the team price, ready for your finance team. Once it is paid, you assign the seats from your account.'
											: 'Tell us who to bill and how many seats, and we will send the invoice at the team price.')}
								</p>
								<p className={cn(TYPE.metaSm, 'text-muted-foreground mt-4')}>
									From 2 to 100 seats. Due on receipt, or Net 30 (by the
									enrollment close for a cohort).
								</p>
							</div>
							<div
								className={cn(
									'col-span-3 md:border-l lg:col-span-4',
									INNER,
									// Stacked under the copy on mobile, the two pads would double up.
									'pt-0 md:pt-[52px]',
								)}
							>
								<TeamInvoiceForm
									productId={invoice.productId}
									location={location}
									mode={invoice.mode}
								/>
							</div>
						</div>
					</section>
				)}

				{/* Contact: the same inquiry that /for-your-team takes, tagged with
				    this product so the reply can start from the right one. */}
				<section
					id="contact"
					aria-labelledby="contact-title"
					className="scroll-mt-(--nav-height)"
				>
					<div className="grid grid-cols-1 md:grid-cols-6">
						<div className={cn('col-span-3 lg:col-span-2', INNER)}>
							<p className={cn(TYPE.groupLabel, 'mb-4')}>Team pricing</p>
							<h2 id="contact-title" className={cn(TYPE.heading)}>
								Get a quote for your team
							</h2>
							<p
								className={cn(
									TYPE.lead,
									'text-foreground/80 mt-5 max-w-[40ch]',
								)}
							>
								Bigger group, custom terms, or a question the page did not
								answer? Tell us how many engineers and what you want them to
								improve. You get pricing and the fastest way to get everyone
								started, within a working day.
							</p>
						</div>
						<div
							className={cn(
								'col-span-3 md:border-l lg:col-span-4',
								INNER,
								// Stacked under the copy on mobile, the two pads would double up.
								'pt-0 md:pt-[52px]',
							)}
						>
							<div>
								<TeamInquiryForm location={location} source={source} />
							</div>
						</div>
					</div>
				</section>
			</main>
		</LayoutClient>
	)
}
