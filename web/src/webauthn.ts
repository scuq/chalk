// chalk WebAuthn bridge for the SPA.
//
// Two responsibilities:
//
//   1. Base64url helpers. WebAuthn-on-the-wire (and go-webauthn's
//      JSON shape) uses base64url-without-padding for binary fields
//      (challenge, user.id, credential.id, etc). The browser's
//      navigator.credentials.create() / get() APIs want ArrayBuffer.
//      We convert in both directions.
//
//   2. Registration ceremony wrapper. Given the server's
//      CredentialCreation options (with base64url-encoded binaries),
//      decode them into the BufferSource shapes the browser expects,
//      call navigator.credentials.create(), then re-encode the
//      response into the JSON shape go-webauthn's
//      ParseCredentialCreationResponseBytes consumes.
//
// We deliberately do NOT pull in @simplewebauthn/browser or similar:
// the conversion logic is ~80 lines, exposing it directly keeps the
// SPA dependency-free (still just preact) and makes failure modes
// readable in our own code.

// ---- base64url ---------------------------------------------------------

// base64url encode a binary buffer (no padding). Inputs accepted as
// ArrayBuffer or any TypedArray-like.
export function bytesToBase64url(bytes: ArrayBuffer | ArrayBufferView): string {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // btoa works on binary strings. Build the string in chunks to
  // avoid stack overflow on very large buffers (we don't expect any,
  // but cost is zero so do it right).
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(view.subarray(i, i + CHUNK)));
  }
  // Standard base64, then to base64url (strip padding, replace + and /).
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// base64url decode to Uint8Array. Accepts strings with or without
// padding and with either base64url or standard base64 alphabet.
export function base64urlToBytes(s: string): Uint8Array {
  // Restore + and /, add padding to a 4-char multiple.
  let std = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = std.length % 4;
  if (pad === 2) std += "==";
  else if (pad === 3) std += "=";
  else if (pad === 1) throw new Error("base64url: invalid length");
  const bin = atob(std);
  // Allocate a fresh ArrayBuffer so the resulting Uint8Array has
  // ArrayBuffer-typed (not ArrayBufferLike) buffer. This matters
  // when the result is assigned to BufferSource-typed fields
  // (challenge, user.id, credential descriptors).
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- registration ceremony --------------------------------------------

// CredentialCreationOptionsJSON is the JSON shape produced by
// go-webauthn's BeginRegistration and sent as the body of our
// /api/auth/register/begin response. Fields that are []byte on the
// server are base64url strings here.
//
// We define the subset we actually use; the library may include more
// fields but the browser is happy to ignore extras.
export interface CredentialCreationOptionsJSON {
  publicKey: {
    challenge: string;
    rp: { name: string; id?: string };
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
    timeout?: number;
    excludeCredentials?: Array<{
      type: "public-key";
      id: string;
      transports?: string[];
    }>;
    authenticatorSelection?: {
      authenticatorAttachment?: "platform" | "cross-platform";
      residentKey?: "discouraged" | "preferred" | "required";
      requireResidentKey?: boolean;
      userVerification?: "required" | "preferred" | "discouraged";
    };
    attestation?: "none" | "indirect" | "direct" | "enterprise";
    extensions?: Record<string, unknown>;
  };
}

// AttestationResponseJSON is what we POST back to
// /api/auth/register/finish. Mirrors the shape go-webauthn's
// ParseCredentialCreationResponseBytes consumes.
export interface AttestationResponseJSON {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment?: "platform" | "cross-platform" | null;
  clientExtensionResults: Record<string, unknown>;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  };
}

// decodeCreationOptions converts the JSON server response into the
// BufferSource-shaped object navigator.credentials.create() expects.
//
// The `as BufferSource` casts are necessary because base64urlToBytes
// returns Uint8Array (whose buffer type TypeScript can't narrow to
// ArrayBuffer in all configurations), and BufferSource is the strict
// union. The Uint8Array we allocate IS over a plain ArrayBuffer, so
// the cast is just appeasing the type narrower.
export function decodeCreationOptions(json: CredentialCreationOptionsJSON): CredentialCreationOptions {
  const p = json.publicKey;
  return {
    publicKey: {
      challenge: base64urlToBytes(p.challenge) as BufferSource,
      rp: p.rp,
      user: {
        id: base64urlToBytes(p.user.id) as BufferSource,
        name: p.user.name,
        displayName: p.user.displayName,
      },
      pubKeyCredParams: p.pubKeyCredParams,
      timeout: p.timeout,
      excludeCredentials: (p.excludeCredentials ?? []).map((c) => ({
        type: c.type,
        id: base64urlToBytes(c.id) as BufferSource,
        transports: c.transports as AuthenticatorTransport[] | undefined,
      })),
      authenticatorSelection: p.authenticatorSelection,
      attestation: p.attestation,
      extensions: p.extensions as AuthenticationExtensionsClientInputs | undefined,
    },
  };
}

// encodeAttestationResponse converts the browser's PublicKeyCredential
// into the JSON shape the server expects.
export function encodeAttestationResponse(cred: PublicKeyCredential): AttestationResponseJSON {
  const r = cred.response as AuthenticatorAttestationResponse;
  // getTransports is available in modern browsers but not in older
  // Safari. Fall back gracefully.
  const transports = typeof r.getTransports === "function" ? r.getTransports() : undefined;
  return {
    id: cred.id,
    rawId: bytesToBase64url(cred.rawId),
    type: "public-key" as const,
    authenticatorAttachment: cred.authenticatorAttachment as "platform" | "cross-platform" | null | undefined ?? null,
    clientExtensionResults: cred.getClientExtensionResults() as Record<string, unknown>,
    response: {
      clientDataJSON: bytesToBase64url(r.clientDataJSON),
      attestationObject: bytesToBase64url(r.attestationObject),
      ...(transports && transports.length > 0 ? { transports } : {}),
    },
  };
}

// ---- high-level convenience -------------------------------------------

// WebAuthnError discriminates between user-cancel (so the SPA can
// show "you cancelled, try again") and other failures. The browser
// uses DOMException with specific name fields; we map them.
export type WebAuthnErrorKind =
  | "not_supported"   // navigator.credentials missing (insecure context, ancient browser)
  | "user_cancelled"  // NotAllowedError, AbortError
  | "constraint"      // ConstraintError, NotSupportedError (user has no matching authenticator)
  | "security"        // SecurityError (RP ID/origin mismatch)
  | "unknown";

export class WebAuthnError extends Error {
  kind: WebAuthnErrorKind;
  constructor(kind: WebAuthnErrorKind, message: string) {
    super(message);
    this.name = "WebAuthnError";
    this.kind = kind;
  }
}

// classifyWebAuthnError inspects a thrown error (typically a
// DOMException from navigator.credentials.create) and maps it to a
// WebAuthnErrorKind. Exported so tests can pin the mapping.
export function classifyWebAuthnError(e: unknown): WebAuthnError {
  if (e instanceof WebAuthnError) return e;
  if (e instanceof Error) {
    const name = (e as { name?: string }).name ?? "";
    switch (name) {
      case "NotAllowedError":
      case "AbortError":
        return new WebAuthnError("user_cancelled", e.message || "ceremony cancelled");
      case "ConstraintError":
      case "NotSupportedError":
        return new WebAuthnError("constraint", e.message || "authenticator does not meet requirements");
      case "SecurityError":
        return new WebAuthnError("security", e.message || "security check failed");
    }
    return new WebAuthnError("unknown", e.message);
  }
  return new WebAuthnError("unknown", String(e));
}

// performRegistration runs the full client-side half of the
// registration ceremony: takes the server's options JSON, calls
// navigator.credentials.create, returns the encoded response ready
// to POST to /api/auth/register/finish.
export async function performRegistration(
  optionsJSON: CredentialCreationOptionsJSON
): Promise<AttestationResponseJSON> {
  if (typeof navigator === "undefined" || !navigator.credentials || typeof navigator.credentials.create !== "function") {
    throw new WebAuthnError("not_supported", "WebAuthn is not available (HTTPS required, or browser too old)");
  }
  const opts = decodeCreationOptions(optionsJSON);
  let cred: Credential | null;
  try {
    cred = await navigator.credentials.create(opts);
  } catch (e) {
    throw classifyWebAuthnError(e);
  }
  if (!cred) {
    throw new WebAuthnError("unknown", "navigator.credentials.create returned null");
  }
  if (cred.type !== "public-key") {
    throw new WebAuthnError("unknown", `unexpected credential type: ${cred.type}`);
  }
  return encodeAttestationResponse(cred as PublicKeyCredential);
}
