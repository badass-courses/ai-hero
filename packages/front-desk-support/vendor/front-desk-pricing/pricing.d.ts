import type { BindingQuoteData, Decoded, Decoder, PriceRequestData, PricingPolicyData, PricingResultData } from "./types.js";
export type * from "./types.js";
export declare const ENGINE_VERSION: string;
export declare const decodePolicy: Decoder<PricingPolicyData>;
export declare const decodeBindingQuotes: Decoder<readonly BindingQuoteData[]>;
export declare const price: (request: PriceRequestData) => Decoded<PricingResultData>;
