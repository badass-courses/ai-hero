import * as React from 'react'

import { cn } from '@coursebuilder/utils/cn'

/**
 * The mark beside the free email course ask in the `/skills` hero.
 *
 * A folder branching into three — the shape of the thing the course is about:
 * one codebase, and the judgement calls that fan out of it. It is the glyph the
 * design return draws in this slot (`Skills Hero.dc.html` § wide / default /
 * 390), sitting on the placeholder tile at 96 / 84 / 60px.
 *
 * Stroked rather than filled, and the one accent-coloured mark in the hero:
 * `text-primary` is gold in dark and ink in light (DESIGN rule 7), so it reads
 * as a drawing in both themes rather than as a second yellow control competing
 * with the submit button under it.
 *
 * The tile it sits on stays `bg-stripes` — the app's own "image slot" mark
 * (DESIGN rule 6). A spot illustration is coming for this position; until it
 * exists the stripes say the slot is deliberate and the glyph says what will go
 * in it.
 */
export function CourseMark({ className }: { className?: string }) {
	return (
		<span
			aria-hidden
			className={cn(
				'bg-stripes flex items-center justify-center rounded-[10px]',
				className,
			)}
		>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth={1.5}
				strokeLinecap="round"
				strokeLinejoin="round"
				className="text-primary size-1/3"
			>
				<path
					strokeLinejoin="miter"
					d="M7 6H16.75C18.8567 6 19.91 6 20.6667 6.50559C20.9943 6.72447 21.2755 7.00572 21.4944 7.33329C22 8.08996 22 9.14331 22 11.25C22 14.7612 22 16.5167 21.1573 17.7779C20.975 18.0508 20.7666 18.3045 20.5355 18.5355M3.46447 18.5355C2 17.0711 2 14.714 2 10V6.94427C2 5.1278 2 4.21956 2.38032 3.53806C2.65142 3.05227 3.05227 2.65142 3.53806 2.38032C4.21956 2 5.1278 2 6.94427 2C8.10802 2 8.6899 2 9.19926 2.19101C10.3622 2.62712 10.8418 3.68358 11.3666 4.73313L12 6"
				/>
				<path d="M18.25 21.25L16 19L16 16M18.25 20.5C17.8358 20.5 17.5 20.8358 17.5 21.25C17.5 21.6642 17.8358 22 18.25 22C18.6642 22 19 21.6642 19 21.25C19 20.8358 18.6642 20.5 18.25 20.5Z" />
				<path d="M5.75 21.25L8 19L8 16M5.75 20.5C6.16421 20.5 6.5 20.8358 6.5 21.25C6.5 21.6642 6.16421 22 5.75 22C5.33579 22 5 21.6642 5 21.25C5 20.8358 5.33579 20.5 5.75 20.5Z" />
				<path d="M12 21.25L12 16M12 20.5C11.5858 20.5 11.25 20.8358 11.25 21.25C11.25 21.6642 11.5858 22 12 22C12.4142 22 12.75 21.6642 12.75 21.25C12.75 20.8358 12.4142 20.5 12 20.5Z" />
			</svg>
		</span>
	)
}
