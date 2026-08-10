'use client'

import type { ComponentProps } from 'react'
import { api } from '@/trpc/react'

import { NewsletterSection } from './newsletter-section'
import { SlimNewsletterForm } from './slim-newsletter-form'

/** Keeps the homepage shell static while resolving reader-specific CTA state. */
export function PersonalizedNewsletterSection(
	props: ComponentProps<typeof NewsletterSection>,
) {
	const { data, status } = api.ability.getSkillsCourseCtaState.useQuery()

	if (status !== 'success' || data?.state === 'subscribed') return null

	return <NewsletterSection {...props} />
}

export function PersonalizedSlimNewsletterForm() {
	const { data, status } = api.ability.getSkillsCourseCtaState.useQuery()

	if (status !== 'success' || data?.state === 'subscribed') return null

	return <SlimNewsletterForm />
}
