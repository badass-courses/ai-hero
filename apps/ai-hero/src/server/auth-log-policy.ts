type SafeAuthErrorType =
  | "AccessDenied"
  | "AccountNotLinked"
  | "AdapterError"
  | "CallbackRouteError"
  | "CredentialsSignin"
  | "DuplicateConditionalUI"
  | "EmailSignInError"
  | "ErrorPageLoop"
  | "EventError"
  | "ExperimentalFeatureNotEnabled"
  | "InvalidCallbackUrl"
  | "InvalidCheck"
  | "InvalidEndpoints"
  | "InvalidProvider"
  | "JWTSessionError"
  | "MissingAdapter"
  | "MissingAdapterMethods"
  | "MissingAuthorize"
  | "MissingCSRF"
  | "MissingSecret"
  | "MissingWebAuthnAutocomplete"
  | "OAuthAccountNotLinked"
  | "OAuthCallbackError"
  | "OAuthProfileParseError"
  | "OAuthSignInError"
  | "SessionTokenError"
  | "SignInError"
  | "SignOutError"
  | "UnknownAction"
  | "UnsupportedStrategy"
  | "UntrustedHost"
  | "Verification"
  | "WebAuthnVerificationError"
  | "Configuration"
  | "AuthError"
  | "unknown";

type SafeAuthReasonCode =
  | "access-denied"
  | "account-not-linked"
  | "adapter-failed"
  | "auth-failed"
  | "callback-route-failed"
  | "configuration"
  | "credentials-signin"
  | "duplicate-conditional-ui"
  | "email-sign-in-failed"
  | "error-page-loop"
  | "event-error"
  | "experimental-feature-not-enabled"
  | "invalid-callback-url"
  | "invalid-check"
  | "invalid-endpoints"
  | "invalid-provider"
  | "jwt-session-error"
  | "missing-adapter"
  | "missing-adapter-methods"
  | "missing-authorize"
  | "missing-csrf"
  | "missing-secret"
  | "missing-webauthn-autocomplete"
  | "oauth-account-not-linked"
  | "oauth-callback-failed"
  | "oauth-profile-parse-error"
  | "oauth-sign-in-error"
  | "session-token-error"
  | "sign-in-error"
  | "sign-out-error"
  | "unknown-action"
  | "unsupported-strategy"
  | "untrusted-host"
  | "verification"
  | "webauthn-verification-error";

const SAFE_AUTH_ERROR_TYPES: ReadonlySet<unknown> = new Set<SafeAuthErrorType>([
  "AccessDenied",
  "AccountNotLinked",
  "AdapterError",
  "CallbackRouteError",
  "CredentialsSignin",
  "DuplicateConditionalUI",
  "EmailSignInError",
  "ErrorPageLoop",
  "EventError",
  "ExperimentalFeatureNotEnabled",
  "InvalidCallbackUrl",
  "InvalidCheck",
  "InvalidEndpoints",
  "InvalidProvider",
  "JWTSessionError",
  "MissingAdapter",
  "MissingAdapterMethods",
  "MissingAuthorize",
  "MissingCSRF",
  "MissingSecret",
  "MissingWebAuthnAutocomplete",
  "OAuthAccountNotLinked",
  "OAuthCallbackError",
  "OAuthProfileParseError",
  "OAuthSignInError",
  "SessionTokenError",
  "SignInError",
  "SignOutError",
  "UnknownAction",
  "UnsupportedStrategy",
  "UntrustedHost",
  "Verification",
  "WebAuthnVerificationError",
  "Configuration",
  "AuthError",
]);

const REASON_CODE_BY_TYPE: Record<
  Exclude<SafeAuthErrorType, "unknown">,
  SafeAuthReasonCode
> = {
  AccessDenied: "access-denied",
  AccountNotLinked: "account-not-linked",
  AdapterError: "adapter-failed",
  CallbackRouteError: "callback-route-failed",
  CredentialsSignin: "credentials-signin",
  DuplicateConditionalUI: "duplicate-conditional-ui",
  EmailSignInError: "email-sign-in-failed",
  ErrorPageLoop: "error-page-loop",
  EventError: "event-error",
  ExperimentalFeatureNotEnabled: "experimental-feature-not-enabled",
  InvalidCallbackUrl: "invalid-callback-url",
  InvalidCheck: "invalid-check",
  InvalidEndpoints: "invalid-endpoints",
  InvalidProvider: "invalid-provider",
  JWTSessionError: "jwt-session-error",
  MissingAdapter: "missing-adapter",
  MissingAdapterMethods: "missing-adapter-methods",
  MissingAuthorize: "missing-authorize",
  MissingCSRF: "missing-csrf",
  MissingSecret: "missing-secret",
  MissingWebAuthnAutocomplete: "missing-webauthn-autocomplete",
  OAuthAccountNotLinked: "oauth-account-not-linked",
  OAuthCallbackError: "oauth-callback-failed",
  OAuthProfileParseError: "oauth-profile-parse-error",
  OAuthSignInError: "oauth-sign-in-error",
  SessionTokenError: "session-token-error",
  SignInError: "sign-in-error",
  SignOutError: "sign-out-error",
  UnknownAction: "unknown-action",
  UnsupportedStrategy: "unsupported-strategy",
  UntrustedHost: "untrusted-host",
  Verification: "verification",
  WebAuthnVerificationError: "webauthn-verification-error",
  Configuration: "configuration",
  AuthError: "auth-failed",
};

type SafeOAuthProvider = "discord" | "github" | "unknown";
type SafeOAuthResultCode =
  | "access_denied"
  | "invalid_request"
  | "server_error"
  | "temporarily_unavailable"
  | "unknown";

type OAuthCallbackReasonCode =
  | "provider-cancelled"
  | "invalid-request"
  | "provider-unavailable"
  | "unknown-oauth-failure";

function readProperty(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || !value) {
    return undefined;
  }
  return Reflect.get(value, key);
}

function toSafeAuthErrorType(value: unknown): SafeAuthErrorType {
  return SAFE_AUTH_ERROR_TYPES.has(value)
    ? (value as SafeAuthErrorType)
    : "unknown";
}

function toSafeProvider(value: unknown): SafeOAuthProvider {
  return value === "discord" || value === "github" ? value : "unknown";
}

function toSafeOAuthResultCode(value: unknown): SafeOAuthResultCode {
  switch (value) {
    case "access_denied":
    case "invalid_request":
    case "server_error":
    case "temporarily_unavailable":
      return value;
    default:
      return "unknown";
  }
}

function toOAuthCallbackReasonCode(
  resultCode: SafeOAuthResultCode,
): OAuthCallbackReasonCode {
  switch (resultCode) {
    case "access_denied":
      return "provider-cancelled";
    case "invalid_request":
      return "invalid-request";
    case "server_error":
    case "temporarily_unavailable":
      return "provider-unavailable";
    default:
      return "unknown-oauth-failure";
  }
}

function getCauseType(error: unknown): SafeAuthErrorType {
  const cause = readProperty(error, "cause");
  const candidates = [readProperty(cause, "err"), cause];
  for (const candidate of candidates) {
    const type = toSafeAuthErrorType(
      readProperty(candidate, "type") ?? readProperty(candidate, "name"),
    );
    if (type !== "unknown") return type;
  }
  return "unknown";
}

export function getSafeAuthErrorLogData(error: unknown): {
  errorType: SafeAuthErrorType;
  causeType: SafeAuthErrorType;
  reasonCode: SafeAuthReasonCode;
} {
  try {
    const errorType = toSafeAuthErrorType(
      readProperty(error, "type") ?? readProperty(error, "name"),
    );
    const causeType = getCauseType(error);
    if (errorType === "unknown") {
      return { errorType, causeType, reasonCode: "auth-failed" };
    }
    return { errorType, causeType, reasonCode: REASON_CODE_BY_TYPE[errorType] };
  } catch {
    return {
      errorType: "unknown",
      causeType: "unknown",
      reasonCode: "auth-failed",
    };
  }
}

/**
 * Auth.js emits provider callback details through logger.debug, then omits
 * them from OAuthCallbackError. Retain only fixed provider and result codes.
 */
export function getOAuthCallbackLogData(
  message: unknown,
  metadata: unknown,
): {
  provider: SafeOAuthProvider;
  reasonCode: OAuthCallbackReasonCode;
  oauthResultCode: SafeOAuthResultCode;
} | null {
  if (message !== "OAuthCallbackError") return null;
  try {
    const oauthResultCode = toSafeOAuthResultCode(
      readProperty(metadata, "error"),
    );
    return {
      provider: toSafeProvider(readProperty(metadata, "providerId")),
      reasonCode: toOAuthCallbackReasonCode(oauthResultCode),
      oauthResultCode,
    };
  } catch {
    return {
      provider: "unknown",
      reasonCode: "unknown-oauth-failure",
      oauthResultCode: "unknown",
    };
  }
}

/** Generic AccessDenied can wrap callback infrastructure failures. Keep it loud. */
export function getNextAuthErrorLogLevel(_error: unknown): "info" | "error" {
  return "error";
}
