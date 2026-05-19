// Phase 11a: high-level MLS session helpers.
//
// `loader.ts` handles "get me a CoreCrypto session." This file is
// the thin layer above that, exposing chalk-specific operations:
// publishing KeyPackages, checking the stock count, etc.
//
// All functions accept a `send` callback that delegates to the WS
// client -- we don't import the WS module here, to keep MLS code
// loadable independently of the auth+chat path.

import { getMlsSession, type MlsInitInput } from "./loader";
import {
  TypePublishKeyPackages,
  TypeKeyPackageCount,
  type PublishKeyPackagesPayload,
  type PublishKeyPackagesAckPayload,
  type KeyPackageCountAckPayload,
  type KeyPackageEntry,
} from "../proto";

export interface SendFn {
  /** Sends a frame, returns a promise for the matching ack. */
  request(type: string, payload: unknown): Promise<unknown>;
}

const CIPHERSUITE = 1;
const CREDENTIAL_TYPE = 1; // Basic

/**
 * Ensure the device has at least `target` unused KeyPackages on the
 * server. If below `threshold`, generate (target - current) fresh
 * KPs and publish them. No-op when stock is healthy.
 *
 * Idempotent: safe to call on every WS reconnect.
 */
export async function ensureKeyPackageStock(
  input: MlsInitInput,
  send: SendFn,
  opts: { threshold?: number; target?: number } = {},
): Promise<{ before: number; after: number; published: number }> {
  const threshold = opts.threshold ?? 3;
  const target = opts.target ?? 10;

  // Ask the server how many we have.
  const countAck = (await send.request(TypeKeyPackageCount, {})) as KeyPackageCountAckPayload;
  const before = countAck.count;
  if (before >= threshold) {
    return { before, after: before, published: 0 };
  }

  const need = target - before;
  const session = await getMlsSession(input);

  // Generate `need` fresh KPs via a transaction.
  const sessionAny = session as any;
  const clientIdClaimed = `${input.userID}:${input.deviceID}`;
  const entries: KeyPackageEntry[] = [];

  await sessionAny.transaction(async (ctx: any) => {
    for (let i = 0; i < need; i++) {
      // 9.x: ctx.generateKeypackage(ciphersuite, credentialType) returns
      // a KeyPackage object whose .buffer is the bytes. Older docs
      // suggested client_keypackages(n) returning an array; both
      // patterns observed across versions. We probe.
      let bytes: Uint8Array;
      if (typeof ctx.generateKeypackage === "function") {
        const kp = await ctx.generateKeypackage(CIPHERSUITE, CREDENTIAL_TYPE);
        bytes = kp instanceof Uint8Array ? kp : (kp.buffer ?? kp);
        if (!(bytes instanceof Uint8Array)) {
          bytes = new Uint8Array(bytes);
        }
      } else if (typeof ctx.clientKeypackages === "function") {
        const arr = await ctx.clientKeypackages(CIPHERSUITE, CREDENTIAL_TYPE, 1);
        bytes = arr[0] instanceof Uint8Array ? arr[0] : new Uint8Array(arr[0]);
      } else {
        throw new Error("core-crypto: KP generation method not found");
      }
      entries.push({
        ciphersuite: CIPHERSUITE,
        credential_type: CREDENTIAL_TYPE,
        client_id_claimed: clientIdClaimed,
        key_package_data: bytesToBase64(bytes),
      });
    }
  });

  const ack = (await send.request(TypePublishKeyPackages, {
    key_packages: entries,
  } as PublishKeyPackagesPayload)) as PublishKeyPackagesAckPayload;

  return { before, after: before + ack.accepted, published: ack.accepted };
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
