'use client'

import { useEffect, useState } from 'react'

export interface ChartColors {
	primary: string
	primaryMuted: string
	foreground: string
	mutedForeground: string
	gridLine: string
	cardBg: string
	hoverBg: string
}

const FALLBACK: ChartColors = {
	primary: '#d4a053',
	primaryMuted: 'rgba(212, 160, 83, 0.2)',
	foreground: '#e5e5e5',
	mutedForeground: '#999',
	gridLine: '#333',
	cardBg: '#1a1a1a',
	hoverBg: '#222',
}

function getCSSVar(name: string): string {
	return getComputedStyle(document.documentElement)
		.getPropertyValue(name)
		.trim()
}

function oklchToUsable(raw: string): string {
	if (!raw) return ''
	// raw is like "oklch(0.85 0.12 79.28)" — browsers handle it fine
	return raw.startsWith('oklch') ? raw : raw
}

export function useChartColors(): ChartColors {
	const [colors, setColors] = useState<ChartColors>(FALLBACK)

	useEffect(() => {
		function update() {
			const primary = getCSSVar('--primary')
			const muted = getCSSVar('--muted')
			const mutedFg = getCSSVar('--muted-foreground')
			const fg = getCSSVar('--foreground')
			const border = getCSSVar('--border')
			const card = getCSSVar('--card')

			if (!primary) return

			setColors({
				primary: oklchToUsable(primary),
				primaryMuted: oklchToUsable(primary).replace(')', ' / 0.2)'),
				foreground: oklchToUsable(fg),
				mutedForeground: oklchToUsable(mutedFg),
				gridLine: oklchToUsable(border),
				cardBg: oklchToUsable(card),
				hoverBg: oklchToUsable(muted),
			})
		}

		update()

		// Re-read when theme changes (class mutation on <html>)
		const observer = new MutationObserver(update)
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class'],
		})

		return () => observer.disconnect()
	}, [])

	return colors
}
