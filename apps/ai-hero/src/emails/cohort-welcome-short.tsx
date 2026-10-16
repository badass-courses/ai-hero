import * as React from 'react'
import {
	Body,
	Container,
	Head,
	Heading,
	Html,
	Link,
	Preview,
	Text,
} from '@react-email/components'
import {
	cohortWelcomeSubject,
	type CohortWelcomeDetails,
} from '@/lib/cohort-welcome-details'

export default function CohortWelcomeShort({
	details,
	variant,
	quantity = 1,
	userFirstName,
	url,
}: {
	details: CohortWelcomeDetails
	variant: 'individual' | 'team' | 'seat'
	quantity?: number
	userFirstName?: string
	url: string
}) {
	const baseUrl = process.env.NEXT_PUBLIC_URL
	return (
		<Html>
			<Head />
			<Preview>{cohortWelcomeSubject(details, variant, quantity)}</Preview>
			<Body style={{ fontFamily: 'Arial, sans-serif', margin: '0 auto' }}>
				<Container style={{ maxWidth: '580px', padding: '32px 24px' }}>
					<Heading style={{ fontSize: '26px', lineHeight: '34px' }}>
						{variant === 'team'
							? 'Invite your team'
							: `Welcome to ${details.title}`}
					</Heading>
					<Text>{userFirstName ? `Hey ${userFirstName},` : 'Hi there,'}</Text>
					{variant === 'team' ? (
						<>
							<Text>
								You bought {quantity} {quantity === 1 ? 'seat' : 'seats'} for{' '}
								{details.title}. Invite your team from your{' '}
								<Link href={`${baseUrl}/team`}>team dashboard</Link>.
							</Text>
							<Text>
								If you're joining too, claim a seat for yourself there.
							</Text>
						</>
					) : (
						<Text>
							{variant === 'seat'
								? `You're in. You've claimed your team seat for ${details.title}.`
								: `You're in for ${details.title}.`}
						</Text>
					)}
					<Text>{details.schedule}</Text>
					{details.crashCourseUrl && (
						<Text>
							The AI Coding Crash Course is included.{' '}
							<Link href={details.crashCourseUrl}>Start there</Link> while you
							wait.
						</Text>
					)}
					{details.workshops.length > 0 && (
						<>
							<Text>Open now:</Text>
							{details.workshops.map((workshop) => (
								<Text key={workshop.slug}>
									<Link href={`${baseUrl}/workshops/${workshop.slug}`}>
										{workshop.title}
									</Link>
								</Text>
							))}
						</>
					)}
					<Text>
						<Link href={url}>Your cohort page</Link>
					</Text>
					<Text>Need help? Reply to this email.</Text>
					{variant !== 'seat' && (
						<Text>
							Need an invoice? Visit your{' '}
							<Link href={`${baseUrl}/invoices`}>invoices page</Link>.
						</Text>
					)}
					<Text>
						See you inside,
						<br />
						The AI Hero Team
					</Text>
				</Container>
			</Body>
		</Html>
	)
}
