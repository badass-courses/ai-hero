import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ImageResponse } from 'next/og'
import type { PublicValuePathCertificateShare } from '@/lib/subscriber-marketing/value-path-certificate-shares'
import { format } from 'date-fns'

import Logo from './logo'

export const SKILLS_WORKFLOW_CERTIFICATE_OG_SIZE = {
	width: 1200,
	height: 630,
}

export async function renderSkillsWorkflowCertificateOpenGraphImage(
	share: PublicValuePathCertificateShare,
) {
	const fontData = await readFile(
		join(
			process.cwd(),
			'public/fonts/79122e33-d8c9-4b2c-8add-f48bd7b317e0.ttf',
		),
	)

	return new ImageResponse(
		<div
			style={{
				alignItems: 'center',
				background: '#000000',
				color: '#ffffff',
				display: 'flex',
				fontFamily: 'Maison',
				height: '100%',
				justifyContent: 'center',
				width: '100%',
			}}
		>
			<div
				style={{
					border: '1px solid #666666',
					display: 'flex',
					flexDirection: 'column',
					height: 566,
					justifyContent: 'space-between',
					padding: '52px 64px',
					position: 'relative',
					width: 1136,
				}}
			>
				<div
					style={{
						display: 'flex',
						fontSize: 22,
						letterSpacing: '0.18em',
						textTransform: 'uppercase',
					}}
				>
					Certificate of completion
				</div>
				<div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
					<div
						style={{
							display: 'flex',
							fontSize: 72,
							lineHeight: 1,
							maxWidth: 930,
						}}
					>
						{share.learnerName}
					</div>
					<div
						style={{
							borderTop: '1px solid #666666',
							display: 'flex',
							fontSize: 28,
							justifyContent: 'space-between',
							paddingTop: 24,
							width: '100%',
						}}
					>
						<span>{share.courseName}</span>
						<span>{format(share.completedAt, 'MMMM d, yyyy')}</span>
					</div>
				</div>
				<div style={{ display: 'flex' }}>
					<Logo />
				</div>
			</div>
		</div>,
		{
			...SKILLS_WORKFLOW_CERTIFICATE_OG_SIZE,
			fonts: [
				{
					name: 'Maison',
					data: fontData,
					style: 'normal',
				},
			],
		},
	)
}
