import * as React from 'react'
import type {
	UpcomingGroup,
	WorkshopSummary,
} from '@/lib/get-workshop-availability'
import {
	Body,
	Container,
	Head,
	Heading,
	Html,
	Link,
	Preview,
	Section,
	Text,
} from '@react-email/components'

export interface WelcomeCohortEmailTeamProps {
	cohortTitle: string
	url: string
	quantity: number
	userFirstName?: string
	supportEmail?: string
	availableNow?: WorkshopSummary[]
	upcoming?: UpcomingGroup[]
	/** @deprecated */
	dayOneUnlockDate?: string
}

export default function WelcomeCohortEmailForTeam({
	cohortTitle,
	url,
	quantity,
	userFirstName,
	supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL,
	availableNow = [],
	upcoming = [],
}: WelcomeCohortEmailTeamProps) {
	if (process.env.LOG_LEVEL === 'debug') {
		console.debug('Rendering WelcomeCohortEmailForTeam', {
			cohortTitle,
			quantity,
		})
	}

	const greeting = userFirstName ? `Hey ${userFirstName},` : 'Hi there,'
	const teamDashboardUrl = `${process.env.COURSEBUILDER_URL}/team`

	return (
		<Html>
			<Head />
			<Preview>Welcome! Manage your {String(quantity)} cohort seats</Preview>
			<Body style={main}>
				<Container style={container}>
					<Section style={section}>
						<Heading style={heading}>
							Your Team is Registered for {cohortTitle}! 🎉
						</Heading>

						<Section style={contentSection}>
							<Text style={text}>{greeting}</Text>
							<Text style={text}>
								You've purchased <strong>{quantity}</strong>{' '}
								{quantity === 1 ? 'seat' : 'seats'} to{' '}
								<strong>{cohortTitle}</strong>.
							</Text>
							<Text style={text}>
								(You will need to redeem a seat on your team.)
							</Text>
							<Section style={{ textAlign: 'center', marginTop: '20px' }}>
								<Link href={url} style={buttonStyle}>
									Get Started with {cohortTitle}
								</Link>
							</Section>
						</Section>

						{availableNow.length > 0 && (
							<Section style={contentSection}>
								<Text style={text}>
									You have access to <strong>{availableNow.length}</strong>{' '}
									{availableNow.length === 1 ? 'workshop' : 'workshops'} right
									now:
								</Text>
								{availableNow.map((workshop) => (
									<Text key={workshop.slug} style={workshopItem}>
										{workshop.title}
									</Text>
								))}
							</Section>
						)}

						{upcoming.length > 0 && (
							<Section style={contentSection}>
								{upcoming.map((group) => (
									<React.Fragment key={group.date}>
										<Text style={text}>
											<strong>Opening {group.date}:</strong>
										</Text>
										{group.workshops.map((workshop) => (
											<Text key={workshop.slug} style={workshopItem}>
												{workshop.title}
											</Text>
										))}
									</React.Fragment>
								))}
								<Text style={text}>
									We'll email you when new workshops open.
								</Text>
							</Section>
						)}

						<Section style={contentSection}>
							<Text style={text}>
								Manage your team seats anytime from your dashboard:
							</Text>
							<Section style={{ textAlign: 'center', marginTop: '20px' }}>
								<Link href={teamDashboardUrl} style={buttonStyle}>
									Manage Seats
								</Link>
							</Section>
						</Section>

						<Section style={contentSection}>
							<Text style={textSmall}>
								Need an invoice? Visit your{' '}
								<Link
									href={`${process.env.COURSEBUILDER_URL}/invoices`}
									style={link}
								>
									invoices page
								</Link>
								. Questions? Contact{' '}
								<Link href={`mailto:${supportEmail}`} style={link}>
									{supportEmail}
								</Link>
								.
							</Text>
						</Section>

						<Section style={contentSection}>
							<Text style={text}>Thank you!</Text>
							<Text style={text}>
								The {process.env.NEXT_PUBLIC_SITE_TITLE} Team
							</Text>
						</Section>
					</Section>
				</Container>
			</Body>
		</Html>
	)
}

const main = {
	backgroundColor: '#f6f9fc',
	fontFamily:
		'-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif',
	padding: '20px 0',
}

const container = {
	backgroundColor: '#ffffff',
	border: '1px solid #dfe3e8',
	borderRadius: '12px',
	margin: '0 auto',
	padding: '0',
	maxWidth: '580px',
}

const section = {
	padding: '32px',
}

const heading = {
	color: '#1a202c',
	fontSize: '28px',
	fontWeight: 'bold' as const,
	lineHeight: '36px',
	textAlign: 'center' as const,
	margin: '0 0 30px',
}

const contentSection = {
	marginTop: '24px',
}

const text = {
	color: '#333333',
	fontSize: '16px',
	lineHeight: '26px',
	margin: '0 0 16px',
}

const workshopItem = {
	...text,
	margin: '0 0 8px',
	paddingLeft: '8px',
}

const textSmall = {
	...text,
	fontSize: '14px',
	lineHeight: '22px',
	color: '#555555',
}

const link = {
	color: '#007bff',
	textDecoration: 'underline',
}

const buttonStyle = {
	backgroundColor: '#007bff',
	color: '#ffffff',
	padding: '12px 20px',
	textDecoration: 'none',
	borderRadius: '5px',
	display: 'inline-block',
	fontWeight: 'bold' as const,
}
