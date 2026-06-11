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

export interface WelcomeCohortEmailTeamRedeemerProps {
	cohortTitle: string
	url: string
	userFirstName?: string
	supportEmail?: string
	availableNow?: WorkshopSummary[]
	upcoming?: UpcomingGroup[]
	benefitTitles?: string[]
	/** @deprecated */
	dayOneUnlockDate?: string
	isZeroDayAccess?: boolean
}

export default function WelcomeCohortEmailForTeamRedeemer({
	cohortTitle,
	url,
	userFirstName,
	supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL,
	availableNow = [],
	upcoming = [],
	benefitTitles = [],
	isZeroDayAccess = false,
}: WelcomeCohortEmailTeamRedeemerProps) {
	if (process.env.LOG_LEVEL === 'debug') {
		console.debug('Rendering WelcomeCohortEmailForTeamRedeemer', {
			cohortTitle,
		})
	}

	const greeting = userFirstName ? `Hey ${userFirstName},` : 'Hi there,'

	return (
		<Html>
			<Head />
			<Preview>You've claimed your seat for {cohortTitle}!</Preview>
			<Body style={main}>
				<Container style={container}>
					<Section style={section}>
						<Heading style={heading}>Welcome to {cohortTitle}! 🎉</Heading>

						<Section style={contentSection}>
							<Text style={text}>{greeting}</Text>
							<Text style={text}>
								You've successfully claimed your seat via your team's purchase.
							</Text>
							<Section style={{ textAlign: 'center', marginTop: '20px' }}>
								<Link href={url} style={buttonStyle}>
									Get Started with {cohortTitle}
								</Link>
							</Section>
						</Section>

						{benefitTitles.length > 0 && (
							<Section style={contentSection}>
								<Text style={text}>
									Your team's purchase also includes access to:
								</Text>
								{benefitTitles.map((title, index) => (
									<Text key={`${title}-${index}`} style={workshopItem}>
										{title}
									</Text>
								))}
							</Section>
						)}

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
							<Text style={textSmall}>
								Questions? Contact{' '}
								<Link href={`mailto:${supportEmail}`} style={link}>
									{supportEmail}
								</Link>
								.
							</Text>
						</Section>

						<Section style={contentSection}>
							<Text style={text}>See you inside,</Text>
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
