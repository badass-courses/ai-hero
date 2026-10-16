import type { ContactProfileVersion } from './contact-profile-version'
import type {
	AckEvidenceExpired,
	ProfileAckReference,
} from './contact-sync-profile-ack-schema'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

/** Deliberately has no requestId/coordinatorKey. An old SDK or missing original
 * ownership cannot invent a frozen request from today's snapshot or history. */
export type LogicalProfileAckRequest = {
	target?: string
	contactId: string
	profileVersion: number
	request: ProfileAckReference['request']
}
export type ProfileAckUnavailableReason =
	| 'legacy-sdk-unregistered'
	| 'unchanged-unregistered-version'
	| 'registration-epoch-unavailable'
	| 'registration-epoch-expired'
	| 'outbox-unconfigured'
	| 'version-superseded'
	| 'already-confirmed-without-retained-request'
	| 'ambiguous-legacy-ownership'
	| 'restatement-period-unavailable'

export type ProfileAckPreparation =
	| { _tag: 'ProfileAckDisabled' }
	| { _tag: 'ProfileAckCaptured'; ref: ProfileAckReference }
	| { _tag: 'ProfileAckKnown'; ref: ProfileAckReference }
	| {
			_tag: 'ProfileAckUnavailable'
			logical: LogicalProfileAckRequest
			reason: ProfileAckUnavailableReason
	  }

export type ProfileAckRegistrationInput = {
	contactId: string
	version: ContactProfileVersion
	contentHash: string
	request: ProfileAckReference['request']
	/** DB UTC, memoized in an earlier successful SDK effect, not ACK proof. */
	registrationEpoch?: string
	events: readonly DrovrShadowEvent[]
}
export type ProfileAckProducerCompletion =
	| AckEvidenceExpired
	| { _tag: 'ProfileAckAwaitingProof' }
	| { _tag: 'ProfileAckReceiverRefused' }
	| {
			_tag: 'ProfileAckConfirmed'
			ref: ProfileAckReference
			links: number
			confirmationClock: string
			disposition: 'acknowledged' | 'version-superseded'
	  }
export type ProfileAckPublication =
	| { _tag: 'ProfileAckPublished' }
	| { _tag: 'ProfileAckPublicationRetained'; reason: 'native-gate' | 'already-delivered' }
	| AckEvidenceExpired

/** All control returns are immutable SDK values. Publication reads retained
 * first-owned bodies by explicit frozen reference; it never invokes capture. */
export type ProfileAckProducerPorts = {
	registrationEpoch: () => Promise<string>
	prepare: (
		input: ProfileAckRegistrationInput,
	) => Promise<ProfileAckPreparation>
	/** Fresh non-memoized admission; never confirmation authority. */
	admit: (ref: ProfileAckReference) => Promise<AckEvidenceExpired | undefined>
	publish: (ref: ProfileAckReference) => Promise<ProfileAckPublication>
	complete: (ref: ProfileAckReference) => Promise<ProfileAckProducerCompletion>
}
