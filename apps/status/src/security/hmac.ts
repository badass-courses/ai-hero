const encoder = new TextEncoder();

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function signDetectorRequest(
  secret: string,
  timestampSeconds: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestampSeconds}.${body}`),
  );
  return `v1=${bytesToHex(signature)}`;
}

export async function verifyDetectorRequest(input: {
  secret: string;
  body: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  nowMs?: number;
  replayWindowSeconds?: number;
}): Promise<{ ok: true; timestampSeconds: number } | { ok: false; code: string }> {
  const {
    secret,
    body,
    timestampHeader,
    signatureHeader,
    nowMs = Date.now(),
    replayWindowSeconds = 300,
  } = input;
  if (!timestampHeader || !signatureHeader) return { ok: false, code: "unsigned" };
  const timestampSeconds = Number(timestampHeader);
  if (!Number.isInteger(timestampSeconds)) return { ok: false, code: "invalid_timestamp" };
  if (Math.abs(Math.floor(nowMs / 1000) - timestampSeconds) > replayWindowSeconds) {
    return { ok: false, code: "outside_replay_window" };
  }
  const expected = await signDetectorRequest(secret, timestampSeconds, body);
  if (!constantTimeEqual(expected, signatureHeader))
    return { ok: false, code: "invalid_signature" };
  return { ok: true, timestampSeconds };
}
