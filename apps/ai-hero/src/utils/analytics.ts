import { track as defaultTrack } from '@skillrecordings/analytics'

export async function track(event: string, params?: any) {
	console.debug(`track ${event}`, params)
	return defaultTrack(event, params)
}
