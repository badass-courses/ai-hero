'use client'

import * as React from 'react'
import {
	SKILLS_FORM_ID,
	SKILLS_INTEREST_FIELDS,
} from '@/app/(content)/skills/_components/skills-newsletter-config'
import { SubscribeToConvertkitForm } from '@/convertkit'
import { ShieldCheckIcon } from 'lucide-react'

export function SlimNewsletterForm() {
	return (
		<div className="flex w-full flex-col items-center gap-16">
			<SubscribeToConvertkitForm
				formId={SKILLS_FORM_ID}
				fields={{ ...SKILLS_INTEREST_FIELDS, source: 'aihero_homepage' }}
				actionLabel="Start the free course"
				className="[&_button]:bg-foreground [&_button]:text-background [&_input]:border-foreground/15 [&_input]:bg-muted [&_input]:text-foreground [&_input]:placeholder:text-foreground/60 grid w-full grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] [&_button]:h-[62px] [&_button]:rounded-none [&_button]:border-0 [&_button]:px-8 [&_button]:text-base [&_button]:font-semibold [&_input]:h-[62px] [&_input]:rounded-none [&_input]:border [&_input]:px-7 [&_input]:text-base [&_label]:hidden"
			/>
			<p className="inline-flex items-center gap-2 text-sm opacity-70">
				<ShieldCheckIcon className="h-4 w-4" />
				<span>I respect your privacy. Unsubscribe at any time.</span>
			</p>
		</div>
	)
}
