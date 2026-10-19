import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ImageResponse } from 'next/og'

export const SANDCASTLE_OG_SIZE = { width: 1200, height: 630 }

// The README's dark tower tile, the same Cloudinary crop the sidebar shows.
const TOWER =
	'https://res.cloudinary.com/total-typescript/image/upload/c_crop,x_206,y_0,w_148,h_148/v1775033787/readme-sandcastle-ondark_2x.png'

// The site's dark tokens: --background, --foreground, --ah-fg-muted, gold.
const INK = '#0b0b0b'
const FG = '#f4f3f1'
const MUTED = 'rgba(244, 243, 241, 0.6)'
const LINE = 'rgba(244, 243, 241, 0.1)'
const GOLD = '#f5c451'

type SandcastleOgCard = {
	/** The sidebar group a docs page sits in; none on the landing card. */
	eyebrow?: string
	title: string
	description?: string
	/** Shown in the footer, as the address the card leads to. */
	path: string
	stats?: { value: string; label: string }[]
}

function fonts() {
	const font = (file: string) =>
		readFile(join(process.cwd(), 'public/fonts', file))
	return Promise.all([font('DMSans-Bold.ttf'), font('DMSans-Medium.ttf')])
}

/**
 * The share card for /sandcastle and every docs page: the tool's mark and
 * name, then the page's own title and opening sentence, all read from the
 * README like the page itself.
 */
export async function renderSandcastleOg(card: SandcastleOgCard) {
	const [bold, medium] = await fonts()
	const isLanding = !card.eyebrow

	return new ImageResponse(
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				width: '100%',
				height: '100%',
				padding: '64px 72px 56px',
				background: INK,
				backgroundImage:
					'radial-gradient(circle at 92% 8%, rgba(245, 196, 81, 0.16), rgba(245, 196, 81, 0) 46%)',
				color: FG,
				fontFamily: 'DM Sans',
			}}
		>
			<div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
				<img src={TOWER} width={68} height={68} />
				<div style={{ fontSize: 36, fontWeight: 700, letterSpacing: -0.5 }}>
					Sandcastle
				</div>
				<div
					style={{
						display: 'flex',
						marginLeft: 'auto',
						fontSize: 26,
						fontWeight: 500,
						color: MUTED,
					}}
				>
					AI Hero
				</div>
			</div>

			<div
				style={{
					display: 'flex',
					flexDirection: 'column',
					marginTop: 'auto',
					maxWidth: isLanding ? 940 : 1000,
				}}
			>
				{card.eyebrow ? (
					<div
						style={{
							fontSize: 22,
							fontWeight: 500,
							color: GOLD,
							letterSpacing: 3,
							textTransform: 'uppercase',
							marginBottom: 18,
						}}
					>
						{card.eyebrow}
					</div>
				) : null}
				<div
					style={{
						fontSize: isLanding ? 62 : card.title.length > 22 ? 72 : 88,
						fontWeight: 700,
						lineHeight: 1.06,
						letterSpacing: -2,
					}}
				>
					{card.title}
				</div>
				{card.description ? (
					<div
						style={{
							marginTop: 22,
							fontSize: 30,
							fontWeight: 500,
							lineHeight: 1.35,
							color: MUTED,
						}}
					>
						{card.description}
					</div>
				) : null}
			</div>

			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 48,
					marginTop: 44,
					paddingTop: 26,
					borderTop: `1px solid ${LINE}`,
					fontSize: 24,
					fontWeight: 500,
					color: MUTED,
				}}
			>
				{(card.stats ?? []).map((stat) => (
					<div
						key={stat.label}
						style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}
					>
						<span style={{ fontSize: 30, fontWeight: 700, color: GOLD }}>
							{stat.value}
						</span>
						<span>{stat.label}</span>
					</div>
				))}
				<div style={{ display: 'flex', marginLeft: 'auto' }}>
					{`aihero.dev${card.path}`}
				</div>
			</div>
		</div>,
		{
			...SANDCASTLE_OG_SIZE,
			fonts: [
				{ name: 'DM Sans', data: bold, weight: 700, style: 'normal' },
				{ name: 'DM Sans', data: medium, weight: 500, style: 'normal' },
			],
		},
	)
}
