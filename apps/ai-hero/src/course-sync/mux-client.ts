import { CourseSyncError } from './errors'
import type {
	CourseSyncMuxAsset,
	CourseSyncMuxClient,
	CourseSyncMuxInput,
} from './types'

type Fetch = typeof fetch

type MuxAssetResponse = {
	data?: {
		id?: string
		status?: string
		duration?: number
		playback_ids?: Array<{ id?: string; policy?: string }>
		errors?: { messages?: string[] }
	}
	error?: { messages?: string[] }
}

export function buildMuxCourseSyncAssetInput(input: CourseSyncMuxInput) {
	return {
		inputs: [
			{
				url: input.url,
				generated_subtitles: [
					{ language_code: 'en', name: 'English CC' },
				],
			},
		],
		playback_policies: ['public'],
		video_quality: 'plus',
		max_resolution_tier: '2160p',
		static_renditions: [{ resolution: 'highest' }],
		passthrough: input.passthrough,
	}
}

function muxAsset(payload: MuxAssetResponse): CourseSyncMuxAsset {
	const asset = payload.data
	if (!asset?.id || !asset.status) {
		throw new CourseSyncError(
			'MUX_ASSET_RESPONSE_INVALID',
			'Mux returned an invalid asset response.',
			502,
		)
	}
	const status = asset.status
	if (status !== 'preparing' && status !== 'ready' && status !== 'errored') {
		throw new CourseSyncError(
			'MUX_ASSET_STATUS_INVALID',
			`Mux returned unsupported asset status ${status}.`,
			502,
		)
	}
	return {
		id: asset.id,
		status,
		playbackId:
			asset.playback_ids?.find((playback) => playback.policy === 'public')?.id ??
			null,
		duration:
			typeof asset.duration === 'number' && Number.isFinite(asset.duration)
				? asset.duration
				: null,
	}
}

export function createCourseSyncMuxClient(input: {
	accessTokenId: string
	secretKey: string
	fetchImpl?: Fetch
	sleep?: (milliseconds: number) => Promise<void>
	pollIntervalMs?: number
	maxPollAttempts?: number
}): CourseSyncMuxClient {
	const fetchImpl = input.fetchImpl ?? fetch
	const sleep =
		input.sleep ??
		((milliseconds: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
	const authorization = `Basic ${Buffer.from(
		`${input.accessTokenId}:${input.secretKey}`,
	).toString('base64')}`

	const request = async (
		path: string,
		init?: RequestInit,
	): Promise<MuxAssetResponse | null> => {
		const response = await fetchImpl(`https://api.mux.com${path}`, {
			...init,
			headers: {
				Authorization: authorization,
				'Content-Type': 'application/json',
				...init?.headers,
			},
		})
		if (response.status === 404) return null
		const body = (await response.json()) as MuxAssetResponse
		if (!response.ok) {
			throw new CourseSyncError(
				'MUX_API_FAILED',
				`Mux API failed (${response.status}): ${[
					...(body.error?.messages ?? []),
					...(body.data?.errors?.messages ?? []),
				]
					.join('; ')
					.slice(0, 300)}`,
				502,
			)
		}
		return body
	}

	return {
		async getAsset(assetId) {
			const payload = await request(`/video/v1/assets/${encodeURIComponent(assetId)}`)
			return payload ? muxAsset(payload) : null
		},
		async createAsset(assetInput) {
			const payload = await request('/video/v1/assets', {
				method: 'POST',
				body: JSON.stringify(buildMuxCourseSyncAssetInput(assetInput)),
			})
			if (!payload) {
				throw new CourseSyncError(
					'MUX_ASSET_CREATE_FAILED',
					'Mux asset creation returned no asset.',
					502,
				)
			}
			return muxAsset(payload)
		},
		async waitForReady(assetId) {
			for (
				let attempt = 0;
				attempt < (input.maxPollAttempts ?? 75);
				attempt += 1
			) {
				const asset = await this.getAsset(assetId)
				if (!asset) {
					throw new CourseSyncError(
						'MUX_ASSET_DISAPPEARED',
						`Mux asset ${assetId} disappeared while preparing.`,
						502,
					)
				}
				if (asset.status === 'errored') {
					throw new CourseSyncError(
						'MUX_ASSET_ERRORED',
						`Mux asset ${assetId} failed to prepare.`,
						502,
					)
				}
				if (asset.status === 'ready') {
					if (!asset.playbackId || asset.duration === null) {
						throw new CourseSyncError(
							'MUX_READY_ASSET_INCOMPLETE',
							`Mux asset ${assetId} is ready without playback metadata.`,
							502,
						)
					}
					return asset
				}
				await sleep(input.pollIntervalMs ?? 10_000)
			}
			throw new CourseSyncError(
				'MUX_ASSET_READY_TIMEOUT',
				`Mux asset ${assetId} did not become ready before the freeze step deadline.`,
				504,
			)
		},
	}
}
