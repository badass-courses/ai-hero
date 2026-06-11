import * as React from 'react'
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

export interface ArchiveWorkshopSummary {
	title: string
	slug: string
	cohortTitle: string
}

export interface WelcomeArchiveEmailProps {
	productName: string
	userFirstName?: string
	supportEmail?: string
	workshops: ArchiveWorkshopSummary[]
	expiresAt: string
	cohortCount: number
}

export default function WelcomeArchiveEmail({
	productName,
	userFirstName,
	supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL,
	workshops = [],
	expiresAt,
	cohortCount,
}: WelcomeArchiveEmailProps) {
	const greeting = userFirstName ? `Hey ${userFirstName},` : 'Hi there,'
	const formattedExpiry = new Date(expiresAt).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	})

	const groupedByCohort = workshops.reduce<
		Record<string, ArchiveWorkshopSummary[]>
	>((acc, w) => {
		const key = w.cohortTitle
		if (!acc[key]) acc[key] = []
		acc[key]!.push(w)
		return acc
	}, {})

	return (
		<Html>
			<Head />
			<Preview>
				{`You now have access to ${cohortCount} cohort${cohortCount === 1 ? '' : 's'} worth of workshops!`}
			</Preview>
			<Body style={main}>
				<Container style={container}>
					<Section style={section}>
						<Heading style={heading}>Welcome to {productName}!</Heading>

						<Section style={contentSection}>
							<Text style={text}>{greeting}</Text>

							<Text style={text}>
								You now have access to{' '}
								<strong>
									{`${workshops.length} workshop${workshops.length === 1 ? '' : 's'}`}
								</strong>{' '}
								from{' '}
								<strong>
									{`${cohortCount} past cohort${cohortCount === 1 ? '' : 's'}`}
								</strong>
								. Your access is valid until <strong>{formattedExpiry}</strong>.
							</Text>
						</Section>

						{Object.entries(groupedByCohort).map(
							([cohortTitle, cohortWorkshops]) => (
								<Section key={cohortTitle} style={contentSection}>
									<Text style={cohortHeading}>{cohortTitle}</Text>
									{cohortWorkshops.map((workshop) => (
										<Text key={workshop.slug} style={workshopItem}>
											<Link
												href={`${process.env.NEXT_PUBLIC_URL}/workshops/${workshop.slug}`}
												style={link}
											>
												{workshop.title}
											</Link>
										</Text>
									))}
								</Section>
							),
						)}

						<Section style={{ textAlign: 'center', marginTop: '24px' }}>
							<Link
								href={`${process.env.NEXT_PUBLIC_URL}/workshops`}
								style={buttonStyle}
							>
								Browse Your Workshops
							</Link>
						</Section>

						<Section style={contentSection}>
							<Hr style={divider} />
							<Text style={textSmall}>
								As new cohort archives become available during your access
								window, they&apos;ll be added automatically.
							</Text>
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

const cohortHeading = {
	...text,
	fontWeight: 'bold' as const,
	fontSize: '15px',
	margin: '0 0 8px',
	color: '#1a202c',
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
