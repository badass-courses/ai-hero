import Link from 'next/link'
import config from '@/config'

export default {
	'newsletter-subscribed-logged-in': ({
		resource,
	}: {
		resource?: {
			path: string
			title: string
		}
	}) => {
		const defaultResource = {
			path: '/vercel-ai-sdk-tutorial',
			title: 'AI SDK tutorial',
		}
		return (
			<>
				Ready to learn? Check out{' '}
				<Link
					className="underline underline-offset-2"
					href={resource?.path || defaultResource.path}
				>
					{resource?.title || defaultResource.title}
				</Link>
				.
			</>
		)
	},
	'newsletter-subscribed-logged-out': ({
		resource,
	}: {
		resource?: {
			path: string
			title: string
		}
	}) => {
		const defaultResource = {
			path: '/vercel-ai-sdk-tutorial',
			title: 'AI SDK tutorial',
		}
		return (
			<>
				Ready to learn?{' '}
				<Link href="/login" className="underline underline-offset-2">
					Log in
				</Link>{' '}
				to track your progress and check out{' '}
				<Link
					href={resource?.path || defaultResource.path}
					className="underline underline-offset-2"
				>
					{resource?.title || defaultResource.title}
				</Link>
				.
			</>
		)
	},

	'primary-newsletter-button-cta-label': 'Subscribe',
	// Static FALLBACK only — consumers ('use client' CTAs) can't fetch the live
	// Kit count. Server call sites should override `title` with
	// <SubscriberCount /> (src/components/subscriber-count.tsx) instead, e.g.
	// title={<>Join over <SubscriberCount /> Developers Becoming AI Heroes</>}.
	'primary-newsletter-tittle': 'Join over 90,000 Developers Becoming AI Heroes',
	'primary-newsletter-byline': (
		<>
			Engineering fundamentals are your biggest advantage. Learn how to leverage
			them and leave vibe coding behind.
		</>
	),
	'tip-newsletter-button-cta-label': 'Subscribe',
	'tip-newsletter-tittle': 'New AI Engineering tips delivered to your inbox:',
	'video-newsletter-title': 'Ship AI Apps That Work',
	'video-newsletter-subtitle':
		'New AI Engineering content straight to your inbox',
}
