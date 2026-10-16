export interface DecodeIssue {
    readonly message: string;
    readonly path: readonly string[];
}
export type Decoded<A> = {
    readonly ok: true;
    readonly value: A;
} | {
    readonly issues: readonly DecodeIssue[];
    readonly ok: false;
};
export type Decoder<A> = (input: unknown) => Decoded<A>;
export type Ruling<A> = {
    readonly source: string;
    readonly value: A;
} | {
    readonly question: string;
};
export interface TeamBandData {
    readonly minSeats: number;
    readonly percent: number;
}
export interface LegendManifestData {
    readonly excludes: readonly string[];
    readonly ownership: "own-purchases";
    readonly products: readonly string[];
    readonly statuses: readonly ("Valid" | "Restricted")[];
    readonly version: string;
}
export interface PricingPolicyData {
    readonly alumniPercent: Ruling<number>;
    readonly checkoutStopsAt: Ruling<string>;
    readonly closesAt: Ruling<string>;
    readonly creditAmounts: Ruling<readonly number[]>;
    readonly earlyEndsAt: Ruling<string>;
    readonly enabled: boolean;
    readonly legend: Ruling<{
        readonly credit: number;
        readonly manifest: LegendManifestData;
        readonly percent: number;
    }>;
    readonly list: number;
    readonly newBuyerEarlyPercent: Ruling<number>;
    readonly opensAt: Ruling<string | null>;
    readonly ppp: Ruling<"better-of-formula-or-ppp">;
    readonly product: string;
    readonly teamBands: Ruling<{
        readonly early: readonly TeamBandData[];
        readonly standard: readonly TeamBandData[];
    }>;
    readonly version: string;
}
export interface BindingQuoteData {
    readonly amount: number;
    readonly basis: "Unit" | "Total" | "Unknown";
    readonly currency: string;
    readonly expiresAt: string | null;
    readonly product: string;
    readonly quantity: number | null;
    readonly ref: string;
}
export type FactGapData = "FactsUnavailable" | "IdentityUnverified" | "PaymentAmbiguous";
export type FactData<A> = {
    readonly sourceRefs: readonly string[];
    readonly value: A;
} | {
    readonly gap: FactGapData;
};
export interface CodeData {
    readonly codeRef: string;
    readonly unitPrice: number;
    readonly maxUses: number;
    readonly usesTaken: number;
    readonly expiresAt: string;
}
export interface BuyerFactsData {
    readonly code?: FactData<CodeData | null>;
    readonly alumni: FactData<"none" | "c3" | "c4" | "both">;
    readonly credit: FactData<{
        readonly paid: number;
        readonly source: string;
    } | null>;
    readonly creditUse: FactData<"available" | "reserved-by-this-attempt" | "spent">;
    readonly existingSeats: FactData<number>;
    readonly legend: FactData<"no" | "verified">;
    readonly order: FactData<"individual" | "team">;
    readonly ppp: FactData<{
        readonly accepted: boolean;
        readonly percent: number;
    } | null>;
}
export interface ProductData {
    readonly id: string;
    readonly merchantUnit: number;
    readonly policy: PricingPolicyData;
}
export type ReasonCodeData = "policy-disabled" | "policy-unresolved" | "merchant-price-mismatch" | "not-open" | "checkout-stopped" | "enrollment-closed" | "fact-unknown" | "credit-amount-unrecognized" | "credit-spent" | "individual-quantity" | "quote-basis-unknown" | "quote-expired" | "quote-out-of-scope" | "early-window" | "standard-window" | "selected";
export interface ReasonData {
    readonly code: ReasonCodeData;
    readonly detail: string;
}
export interface CandidateData {
    readonly amount: number;
    readonly basis: "formula" | "ppp" | "team" | "quote" | "code";
    readonly consent: "region" | null;
    readonly creditSource: string | null;
    readonly quoteRefs: readonly string[];
    readonly restriction: "none" | "region";
    readonly rule: string;
    readonly unitAmount: number | null;
}
export interface UnresolvedData {
    readonly candidate: "code" | "alumni" | "credit" | "legend" | "ppp";
    readonly fact: "code" | "alumni" | "credit" | "creditUse" | "legend" | "ppp";
    readonly gap: FactGapData;
    readonly needs: string;
}
export interface AcceptedFactData {
    readonly fact: "code" | "alumni" | "credit" | "creditUse" | "existingSeats" | "legend" | "order" | "ppp";
    readonly productRefs: readonly string[];
}
export interface PricedData extends CandidateData {
    readonly codeRef?: string;
    readonly acceptedFacts: readonly AcceptedFactData[];
    readonly candidates: readonly CandidateData[];
    readonly engineVersion: string;
    readonly offers: readonly CandidateData[];
    readonly policyVersion: string;
    readonly reasons: readonly ReasonData[];
}
export interface RefusalData<K extends "not-open" | "closed" | "held"> {
    readonly kind: K;
    readonly reasons: readonly ReasonData[];
}
export type PricingResultData = (PricedData & {
    readonly kind: "priced";
}) | (PricedData & {
    readonly kind: "bounded";
    readonly unresolved: readonly UnresolvedData[];
}) | RefusalData<"not-open"> | RefusalData<"closed"> | RefusalData<"held">;
export interface PriceRequestData {
    readonly facts: BuyerFactsData;
    readonly now: string;
    readonly product: ProductData;
    readonly quantity: number;
    readonly quotes: readonly BindingQuoteData[];
}
