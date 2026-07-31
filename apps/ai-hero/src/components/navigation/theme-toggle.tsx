'use client'

import * as React from 'react'
import { Check, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

export function ThemeToggle({ className }: { className?: string }) {
	const { setTheme, theme } = useTheme()
	const [mounted, setMounted] = React.useState(false)

	React.useEffect(() => {
		setMounted(true)
	}, [])

	// if (!mounted) return null

	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					className={cn(
						'text-foreground flex gap-2 rounded-sm sm:aspect-square',
						className,
					)}
				>
					{/* `relative`, and that is the whole fix for the missing moon.
					    The two glyphs cross-fade in one slot, so the second is
					    `absolute` — but this wrapper was static, so it was not the
					    containing block. The moon resolved against the nearest
					    positioned ancestor instead, which in the mobile drawer is the
					    `fixed z-50` sheet, and it drew in the sheet's top-left corner
					    rather than in the footer. In dark mode the sun is scaled to 0,
					    so the control looked empty.

					    Fixed size on the slot too: `h-full w-full` measured a flex item
					    that had nothing to take its height from, so centring had
					    nothing to centre within. Both icons are absolutely centred in a
					    box that is a known size, which is also what keeps the button
					    from resizing as they swap. */}
					<span className="relative inline-flex size-5 shrink-0 items-center justify-center">
						<Sun className="absolute size-3.5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0 motion-reduce:transition-none" />
						<Moon className="absolute size-3.5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100 motion-reduce:transition-none" />
					</span>
					<span className="text-xs font-normal capitalize opacity-80 sm:text-sm">
						{mounted && theme} Theme
					</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuLabel>Theme</DropdownMenuLabel>
				<DropdownMenuItem
					onClick={() => setTheme('light')}
					className="flex items-center justify-between gap-2"
				>
					Light {theme === 'light' && <Check className="h-4 w-4" />}
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => setTheme('dark')}
					className="flex items-center justify-between gap-2"
				>
					Dark {theme === 'dark' && <Check className="h-4 w-4" />}
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => setTheme('system')}
					className="flex items-center justify-between gap-2"
				>
					System {theme === 'system' && <Check className="h-4 w-4" />}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
