import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ImageResponse } from 'next/og'

export const SANDCASTLE_OG_SIZE = { width: 1200, height: 630 }

// The README's light tower tile, the same Cloudinary crop the sidebar shows.
const TOWER =
	'https://res.cloudinary.com/total-typescript/image/upload/c_crop,x_206,y_0,w_148,h_148/v1775033787/readme-sandcastle-onlight_2x.png'

// The site's light tokens: --background, --foreground, --ah-fg-muted, --ah-line.
const PAPER = '#fbfbfc'
const INK = '#14161a'
const MUTED = 'rgba(20, 22, 26, 0.62)'
const LINE = 'rgba(20, 22, 26, 0.12)'

type SandcastleOgCard = {
	/** The sidebar group a docs page sits in; none on the landing card. */
	eyebrow?: string
	title: string
	description?: string
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
				background: PAPER,
				color: INK,
				fontFamily: 'DM Sans',
			}}
		>
			<div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
				<img src={TOWER} width={68} height={68} />
				<div style={{ fontSize: 36, fontWeight: 700, letterSpacing: -0.5 }}>
					Sandcastle
				</div>
				{/* AI Hero's mark, the glyph from the site's own share cards. */}
				<svg
					width={48}
					height={48}
					viewBox="0 0 58 58"
					style={{ marginLeft: 'auto' }}
				>
					<path
						fill={INK}
						fillRule="evenodd"
						clipRule="evenodd"
						d="m58.966-.978.228-.206-3.849-3.464-23.86 21.477V-.414h-5.178V16.27L3.068-4.648-.769-1.195l-.001-.001-3.465 3.849 20.919 23.239H.024v5.178h17.219L-4.235 54.93l3.465 3.849L26.223 28.79-.666-1.08l29.873 26.89L56.899.881l-25.122 27.91L58.77 58.778l3.465-3.85L40.758 31.07h17.218v-5.178h-16.66l20.919-23.24-3.269-3.63Zm.228 60.16L29.207 32.19-.781 59.183l3.85 3.464L26.306 41.73V58h5.178V41.17l23.86 21.477 3.85-3.464Z"
					/>
				</svg>
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
							color: MUTED,
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

			{card.stats?.length ? (
				<div
					style={{
						display: 'flex',
						gap: 72,
						marginTop: 44,
						paddingTop: 30,
						borderTop: `1px solid ${LINE}`,
					}}
				>
					{/* Number over label, as the landing page sets them, so each
					    pair lines up on its left edge. */}
					{card.stats.map((stat) => (
						<div
							key={stat.label}
							style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
						>
							<span
								style={{
									fontSize: 40,
									fontWeight: 700,
									lineHeight: 1,
									letterSpacing: -1,
								}}
							>
								{stat.value}
							</span>
							<span
								style={{
									fontSize: 22,
									fontWeight: 500,
									lineHeight: 1,
									color: MUTED,
								}}
							>
								{stat.label}
							</span>
						</div>
					))}
				</div>
			) : null}
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
