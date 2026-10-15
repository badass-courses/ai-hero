'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { WorkshopResourceList } from '@/app/(content)/workshops/_components/workshop-resource-list'
import { MenuIcon } from 'lucide-react'

import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from '@coursebuilder/ui'

/**
 * The mobile lesson list. The (learn) layout survives lesson changes, so the
 * sheet no longer closes by remounting: it is open only for the path it was
 * opened on, and picking a lesson closes it, the one already open too (its
 * path does not change).
 */
export function LessonsSheet() {
	const pathname = usePathname()
	const [openedOn, setOpenedOn] = React.useState<string | null>(null)

	return (
		<Sheet
			open={openedOn === pathname}
			onOpenChange={(open) => setOpenedOn(open ? pathname : null)}
		>
			<SheetTrigger className="bg-card/90 border-foreground/10 fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded border px-3 py-2 shadow-lg backdrop-blur-md lg:hidden dark:bg-gray-800/80">
				<MenuIcon className="size-4" /> Lessons
			</SheetTrigger>
			<SheetContent
				className="px-0 pt-0"
				onClickCapture={(e) => {
					if ((e.target as Element).closest('a[href]')) setOpenedOn(null)
				}}
			>
				<SheetHeader>
					<SheetTitle className="sr-only">Workshop Contents</SheetTitle>
				</SheetHeader>
				<WorkshopResourceList
					isCollapsible={false}
					className="max-w-full border-r-0 border-t-0"
				/>
			</SheetContent>
		</Sheet>
	)
}
