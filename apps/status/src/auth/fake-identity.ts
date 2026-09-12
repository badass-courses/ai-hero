export interface IdentityAdapter {
  authorizeBearer(input: {
    authorization: string | null;
    expectedToken: string | undefined;
  }): boolean;
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export const fakeBearerIdentityAdapter: IdentityAdapter = {
  authorizeBearer({ authorization, expectedToken }) {
    if (!expectedToken || !authorization?.startsWith("Bearer ")) return false;
    return constantTimeEqual(authorization.slice("Bearer ".length), expectedToken);
  },
};
