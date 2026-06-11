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
	Hr,
	Html,
	Link,
	Preview,
	Section,
	Text,
} from '@react-email/components'

export interface WelcomeCohortEmailProps {
	cohortTitle: string
	url: string
	userFirstName?: string
	supportEmail?: string
	availableNow?: WorkshopSummary[]
	upcoming?: UpcomingGroup[]
	/** @deprecated Use availableNow/upcoming instead */
	dayOneUnlockDate?: string
}

export default function WelcomeCohortEmail({
	cohortTitle,
	url,
	userFirstName,
	supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL,
	availableNow = [],
	upcoming = [],
}: WelcomeCohortEmailProps) {
	if (process.env.LOG_LEVEL === 'debug') {
		console.debug('Rendering WelcomeCohortEmail', { cohortTitle })
	}

	const greeting = userFirstName ? `Hey ${userFirstName},` : 'Hi there,'

	return (
		<Html>
			<Head />
			<Preview>Welcome to {cohortTitle}!</Preview>
			<Body style={main}>
				<Container style={container}>
					<Section style={section}>
						<Heading style={heading}>Welcome to {cohortTitle}!</Heading>

						<Section style={contentSection}>
							<Text style={text}>{greeting}</Text>

							{availableNow.length > 0 ? (
								<>
									<Text style={text}>
										You have access to {availableNow.length} workshop
										{availableNow.length === 1 ? '' : 's'} right now:
									</Text>
									{availableNow.map((workshop) => (
										<Text key={workshop.slug} style={workshopItem}>
											<Link
												href={`${process.env.NEXT_PUBLIC_URL}/workshops/${workshop.slug}`}
												style={link}
											>
												{workshop.title}
											</Link>
										</Text>
									))}
									<Section style={{ textAlign: 'center', marginTop: '20px' }}>
										<Link href={url} style={buttonStyle}>
											Get Started with {cohortTitle}
										</Link>
									</Section>
								</>
							) : (
								<Text style={text}>
									You&apos;re all set! We&apos;ll email you when the first
									workshops unlock.
								</Text>
							)}
						</Section>

						{upcoming.length > 0 && (
							<Section style={contentSection}>
								<Hr style={divider} />
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
									We&apos;ll email you when new workshops open.
								</Text>
							</Section>
						)}

						<Section style={contentSection}>
							<Hr style={divider} />
							<Text style={text}>Need anything? We&apos;re here to help.</Text>
							<Text style={textSmall}>
								You can access your invoice anytime on your{' '}
								<Link
									href={`${process.env.NEXT_PUBLIC_URL}/invoices`}
									style={link}
								>
									invoices page
								</Link>
								.
							</Text>
							<Text style={textSmall}>
								Questions? Reply to this email or reach out to{' '}
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

const workshopItem = {
	...text,
	margin: '0 0 8px',
}

const divider = {
	borderTop: '1px solid #eee',
	margin: '24px 0',
}
