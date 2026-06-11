import * as React from 'react'
import {
	Body,
	Button,
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

interface WorkshopInfo {
	fields: {
		title: string
		description?: string
		slug?: string
	}
}

interface WorkshopBatchAccessEmailProps {
	user: {
		name?: string
		email: string
	}
	workshops: WorkshopInfo[]
}

export function WorkshopBatchAccessEmail({
	user,
	workshops,
}: WorkshopBatchAccessEmailProps) {
	const count = workshops.length
	const subject =
		count === 1
			? `${count} new workshop is now available`
			: `${count} new workshops are now available`

	return (
		<Html>
			<Head />
			<Preview>{subject}</Preview>
			<Body style={main}>
				<Container style={container}>
					<Section style={section}>
						<Heading style={h1}>{subject}</Heading>
						<Text style={text}>Hi {user.name || 'there'},</Text>
						<Text style={text}>
							{count === 1
								? 'A new workshop is ready for you:'
								: `${count} new workshops are ready for you:`}
						</Text>
						{workshops.map((workshop, index) => (
							<Section key={workshop.fields.slug || index} style={workshopCard}>
								<Text style={workshopTitle}>
									<Link
										href={`${process.env.NEXT_PUBLIC_URL}/workshops/${workshop.fields.slug}`}
										style={workshopLink}
									>
										{workshop.fields.title}
									</Link>
								</Text>
								{workshop.fields.description && (
									<Text style={workshopDescription}>
										{workshop.fields.description}
									</Text>
								)}
								<Button
									href={`${process.env.NEXT_PUBLIC_URL}/workshops/${workshop.fields.slug}`}
									style={buttonStyle}
								>
									Start Learning
								</Button>
								{index < count - 1 && <Hr style={divider} />}
							</Section>
						))}
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

const h1 = {
	color: '#1a202c',
	fontSize: '24px',
	fontWeight: '700' as const,
	margin: '0 0 24px',
	lineHeight: '32px',
}

const text = {
	color: '#333333',
	fontSize: '16px',
	lineHeight: '26px',
	margin: '0 0 16px',
}

const workshopCard = {
	margin: '16px 0',
	padding: '0',
}

const workshopTitle = {
	color: '#1a202c',
	fontSize: '18px',
	fontWeight: '600' as const,
	lineHeight: '24px',
	margin: '0 0 4px',
}

const workshopLink = {
	color: '#007bff',
	textDecoration: 'none',
}

const workshopDescription = {
	color: '#555555',
	fontSize: '14px',
	lineHeight: '22px',
	margin: '0 0 12px',
}

const buttonStyle = {
	backgroundColor: '#007bff',
	color: '#ffffff',
	padding: '10px 18px',
	textDecoration: 'none',
	borderRadius: '5px',
	display: 'inline-block',
	fontWeight: 'bold' as const,
	fontSize: '14px',
}

const divider = {
	borderTop: '1px solid #eee',
	margin: '20px 0',
}

export default WorkshopBatchAccessEmail
