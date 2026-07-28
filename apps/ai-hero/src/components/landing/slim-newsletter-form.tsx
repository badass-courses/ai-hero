'use client'

import * as React from 'react'
import { SubscribeToConvertkitForm } from '@/convertkit'
import { ShieldCheckIcon } from 'lucide-react'

export function SlimNewsletterForm() {
	return (
		<div className="flex w-full flex-col items-center gap-3">
			<SubscribeToConvertkitForm
				actionLabel="Stay up to date"
				className="[&_button]:bg-primary [&_button]:text-primary-foreground [&_button]:hover:bg-primary/90 [&_input]:border-foreground/15 [&_input]:bg-muted [&_input]:text-foreground [&_input]:placeholder:text-foreground/60 grid w-full grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] [&_button]:h-11 [&_button]:rounded-full [&_button]:border-0 [&_button]:px-6 [&_button]:text-sm [&_button]:font-semibold [&_input]:h-11 [&_input]:rounded-full [&_input]:border [&_input]:px-5 [&_input]:text-sm [&_label]:hidden"
			/>
			<p className="inline-flex items-center gap-2 text-sm opacity-70">
				<ShieldCheckIcon className="h-4 w-4" />
				<span>I respect your privacy. Unsubscribe at any time.</span>
			</p>
		</div>
	)
}
