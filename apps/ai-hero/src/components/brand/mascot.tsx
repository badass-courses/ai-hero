import * as React from 'react'

import { cn } from '@coursebuilder/utils/cn'

const SPRITE_URL = '/assets/aihero-mascot-sprite.png'

type AiHeroMascotProps = {
	size?: number
	className?: string
	title?: string
}

export function AiHeroMascot({
	size = 32,
	className,
	title = 'AI Hero mascot',
}: AiHeroMascotProps) {
	return (
		<span
			role="img"
			aria-label={title}
			className={cn('aihero-mascot', className)}
			style={
				{
					'--aihero-size': `${size}px`,
					'--aihero-sprite-url': `url(${SPRITE_URL})`,
				} as React.CSSProperties
			}
		/>
	)
}
