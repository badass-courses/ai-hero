import { Schema } from "effect";

export const FakeApprovalV1 = Schema.Struct({
  schemaVersion: Schema.Literal("aih.status.fake-approval.v1"),
  proposalId: Schema.NonEmptyString,
  nonce: Schema.NonEmptyString,
  actor: Schema.NonEmptyString,
  incidentVersion: Schema.Number.check(Schema.isGreaterThan(0)),
  publicProjectionDigest: Schema.NonEmptyString,
  observedAt: Schema.String,
  signatureValid: Schema.Boolean,
});
export type FakeApproval = typeof FakeApprovalV1.Type;

export function decodeFakeApproval(input: unknown): FakeApproval {
  const approval = Schema.decodeUnknownSync(FakeApprovalV1, {
    errors: "all",
    onExcessProperty: "error",
  })(input);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(approval.observedAt)) {
    throw new Error("approval observedAt must be a canonical UTC timestamp");
  }
  return approval;
}

export const STATUS_OPERATOR_ALLOWLIST = new Set(["status-operator-1"]);
