'use client'

import * as React from 'react'
import { SubscribeToConvertkitForm } from '@/convertkit'
import { ShieldCheckIcon } from 'lucide-react'

export function SlimNewsletterForm() {
	return (
		<div className="flex w-full flex-col items-center gap-3">
			<SubscribeToConvertkitForm
				actionLabel="Stay up to date"
				className="[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_input]:border-foreground/15 [&_input]:bg-muted [&_input]:text-foreground [&_input]:placeholder:text-foreground/60 grid w-full grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] [&_button]:h-11 [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:px-6 [&_button]:text-sm [&_button]:font-semibold [&_input]:h-11 [&_input]:rounded-[9px] [&_input]:min-w-0 [&_input]:border [&_input]:px-5 [&_input]:text-sm [&_label]:hidden"
			/>
			<p className="mt-2 inline-flex items-center gap-2 text-xs opacity-70">
				<ShieldCheckIcon className="h-4 w-4" />
				<span>I respect your privacy. Unsubscribe at any time.</span>
			</p>
		</div>
	)
}
