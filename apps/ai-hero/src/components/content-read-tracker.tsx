'use client'

import { useEffect, useRef } from 'react'

export type ContentReadTrackerProps = {
	contentId: string
	contentType:
		| 'post'
		| 'lesson'
		| 'solution'
		| 'skill-changelog'
		| 'dictionary'
		| 'dictionary-entry'
	contentSlug: string
	parentSlug?: string
}

type ReadSignal = 'dwell_30s' | 'scroll_50' | 'cta_click'

function getKitLinkAttribution() {
	const params = new URLSearchParams(window.location.search)
	const kitSubscriberId =
		params.get('ck_subscriber_id') ??
		params.get('subscriber_id') ??
		params.get('kit_subscriber_id') ??
		undefined
	const emailSha256 =
		params.get('ck_email_sha256') ??
		params.get('email_sha256') ??
		params.get('subscriber_hash') ??
		undefined

	return kitSubscriberId || emailSha256
		? { kitSubscriberId, emailSha256 }
		: undefined
}

export function ContentReadTracker(props: ContentReadTrackerProps) {
	const sentSignals = useRef(new Set<ReadSignal>())

	useEffect(() => {
		const sendSignal = (
			readSignal: ReadSignal,
			cta?: { id: string; href?: string },
		) => {
			if (sentSignals.current.has(readSignal)) return
			sentSignals.current.add(readSignal)

			const payload = {
				schemaVersion: 1,
				event: 'content.read',
				contentId: props.contentId,
				contentType: props.contentType,
				contentSlug: props.contentSlug,
				parentSlug: props.parentSlug,
				readSignal,
				occurredAt: new Date().toISOString(),
				clientEventId: crypto.randomUUID(),
				pathname: window.location.pathname,
				kit: getKitLinkAttribution(),
				cta,
			}
			const body = JSON.stringify(payload)

			if (navigator.sendBeacon) {
				const blob = new Blob([body], { type: 'application/json' })
				if (navigator.sendBeacon('/api/content/progress', blob)) return
			}

			void fetch('/api/content/progress', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body,
				keepalive: true,
			})
		}

		const dwellTimer = window.setTimeout(() => {
			if (document.visibilityState === 'visible') sendSignal('dwell_30s')
		}, 30_000)

		const handleScroll = () => {
			const scrollable =
				document.documentElement.scrollHeight - window.innerHeight
			if (scrollable <= 0) return
			const depth = window.scrollY / scrollable
			if (depth >= 0.5) sendSignal('scroll_50')
		}

		const handleClick = (event: MouseEvent) => {
			const target = event.target instanceof Element ? event.target : null
			const link = target?.closest('[data-content-read-cta]')
			if (!(link instanceof HTMLAnchorElement)) return
			sendSignal('cta_click', {
				id: link.dataset.contentReadCta || 'content-cta',
				href: link.href,
			})
		}

		window.addEventListener('scroll', handleScroll, { passive: true })
		document.addEventListener('click', handleClick)

		return () => {
			window.clearTimeout(dwellTimer)
			window.removeEventListener('scroll', handleScroll)
			document.removeEventListener('click', handleClick)
		}
	}, [props.contentId, props.contentSlug, props.contentType, props.parentSlug])

	return null
}
