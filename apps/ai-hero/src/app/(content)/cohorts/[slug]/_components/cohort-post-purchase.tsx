import type { ReactNode } from 'react'
import Link from 'next/link'
import { OfficeHoursSchedule } from '@/components/office-hours-schedule'
import { TYPE } from '@/components/landing/type'
import type { Cohort } from '@/lib/cohort'
import { isWorkshopAvailable } from '@/lib/cohort-navigation'
import type { Workshop } from '@/lib/workshops'
import {
	PurchaseCard,
	PurchaseCardSection,
	PurchaseColumn,
	PurchaseHeading,
	PURCHASE_PRIMARY_BUTTON,
} from '../../../../(commerce)/_components/post-purchase-parts'
import { PostPurchaseDiscordAccess } from '../../../../(commerce)/welcome/welcome-discord-entry'
import { welcomeStart } from '../../../../(commerce)/welcome/welcome-start'

/** Server-only composition. Call only after resolving the viewer's cohort access. */
export function CohortPostPurchase({
	cohort,
	workshops,
	isDiscordConnected,
	override,
	now = new Date(),
}: {
	cohort: Cohort
	workshops: Workshop[]
	isDiscordConnected: boolean
	override?: ReactNode
	now?: Date
}) {
	const { fields } = cohort
	const start = welcomeStart({
		product: { type: 'cohort', resources: [{ resource: { fields } }] },
		productResources: [cohort],
		ownsASeat: true,
		now,
	})
	const firstOpenWorkshop = workshops.find((workshop, position) =>
		isWorkshopAvailable(
			{
				id: workshop.id,
				slug: workshop.fields.slug,
				title: workshop.fields.title,
				position,
				state: workshop.fields.state,
				startsAt: workshop.fields.startsAt ?? null,
				timezone: fields.timezone || 'America/Los_Angeles',
				firstLesson: null,
			},
			now,
		),
	)

	return (
		<PurchaseColumn>
			<PurchaseCard>
				<PurchaseCardSection>
					<PurchaseHeading
						artwork={fields.image}
						eyebrow="You're in"
						title={fields.title}
					>
						{start?.startsLabel ? (
							<p className={`${TYPE.metaProse} text-muted-foreground`}>
								{start.startsLabel}
							</p>
						) : null}
					</PurchaseHeading>
				</PurchaseCardSection>
				{override ? (
					<PurchaseCardSection>
						<article className="prose dark:prose-invert max-w-none">
							{override}
						</article>
					</PurchaseCardSection>
				) : (
					<>
						{firstOpenWorkshop ? (
							<PurchaseCardSection>
								<h2 className={TYPE.panelTitle}>Start here</h2>
								<p className={`${TYPE.body} mt-2 mb-4`}>
									{firstOpenWorkshop.fields.title}
								</p>
								<Link
									className={PURCHASE_PRIMARY_BUTTON}
									href={`/workshops/${firstOpenWorkshop.fields.slug}`}
								>
									Start learning
								</Link>
							</PurchaseCardSection>
						) : null}
						{fields.officeHoursSessions?.length ? (
							<PurchaseCardSection>
								<h2 className={`${TYPE.panelTitle} mb-4`}>Office hours</h2>
								<OfficeHoursSchedule
									sessions={fields.officeHoursSessions}
									variant="lesson"
									timeZone={fields.timezone || 'America/Los_Angeles'}
								/>
							</PurchaseCardSection>
						) : null}
						{!isDiscordConnected ? (
							<PurchaseCardSection>
								<PostPurchaseDiscordAccess
									isDiscordConnected={isDiscordConnected}
								/>
							</PurchaseCardSection>
						) : null}
					</>
				)}
			</PurchaseCard>
		</PurchaseColumn>
	)
}
