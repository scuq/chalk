// Phase 11b-2 (fix2): high-level MLS group operations.
//
// CoreCrypto 9.x architectural shift: commit-producing operations
// (addClientsToConversation, removeClientsFromConversation, ...) do
// not return commit/welcome bytes anymore. Instead they invoke a
// transport callback you registered once via
// session.provideTransport(transport).
//
// The callback receives a CommitBundle, posts it to the server,
// and returns "success" / "retry" / {abort: {reason}}.
// CoreCrypto then merges (or rolls back) the local epoch based on
// the response. The caller of addClientsToConversation never sees
// the bundle.
//
// Our approach: a module-level "active op" captures the wire
// context (channel_id, peer_user_id, send fn) before the
// CoreCrypto call. The transport callback reads from it. Single
// active op per session at a time -- 11b-2 only does sequential
// DM bring-up; multi-op concurrency is a later phase.

import { getMlsSession, type MlsInitInput } from "./loader";
import {
  initWasmModule,
  ConversationId,
  Welcome,
} from "@wireapp/core-crypto";
import {
  TypeFetchKeyPackages,
  TypeMlsCommitBundle,
  type FetchKeyPackagesPayload,
  type FetchKeyPackagesAckPayload,
  type MlsCommitBundlePayload,
  type MlsCommitBundleAckPayload,
} from "../proto";

export interface SendFn {
  request(type: string, payload: unknown): Promise<unknown>;
}

const CIPHERSUITE = 1;       // MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519
const CREDENTIAL_TYPE = 1;   // Basic

// ---- byte helpers ----------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function cid(bytes: Uint8Array): any {
  return new (ConversationId as any)(bytes);
}

// ---- module-level state ---------------------------------------------

// Active "transport op" -- the wire context for the next
// sendCommitBundle invocation. Set just before an
// addClientsToConversation call; consumed by the transport
// callback; cleared after.
interface ActiveOp {
  channelID: string;
  // For "add a peer to a brand-new DM", we have one welcome
  // recipient. For multi-member or removeClients ops, this would
  // be a list of user_ids to fan welcomes to (always empty for
  // remove). 11b-2 only does the single-peer DM bring-up.
  welcomeRecipientUserID?: string;
  send: SendFn;
  // Captured during the callback so the caller can read it post-resolve.
  serverAck?: MlsCommitBundleAckPayload;
  serverError?: Error;
  // Bump per-conversation so we know what epoch to send. The
  // bundle's epoch is what CoreCrypto produced; we just trust it.
  // For first-add, CoreCrypto's internal epoch goes from 0 to 1.
  epoch: number;
}

let activeOp: ActiveOp | null = null;
let transportInstalled: WeakSet<object> = new WeakSet();

function getActiveOp(): ActiveOp {
  if (!activeOp) {
    throw new Error("no active MLS transport op (was set up before commit?)");
  }
  return activeOp;
}

// ---- transport installation ----------------------------------------

async function ensureTransport(session: any): Promise<void> {
  if (transportInstalled.has(session)) return;

  const transport = {
    // Called by CoreCrypto when a commit-producing op needs the
    // bundle delivered. We post mls_commit_bundle to the chalk
    // server. Return "success" iff the server accepted it.
    sendCommitBundle: async (bundle: any): Promise<any> => {
      try {
        const op = getActiveOp();
        const commitBytes = extractBytes(bundle.commit);
        const welcomeBytes =
          bundle.welcome != null
            ? extractBytes(bundle.welcome) ??
              (typeof bundle.welcome?.copyBytes === "function"
                ? bundle.welcome.copyBytes()
                : null)
            : null;

        if (!commitBytes) {
          op.serverError = new Error("transport: commit bytes missing from bundle");
          return { abort: { reason: "missing commit" } };
        }

        // mls_group_id: derive from active channelID (the group is
        // 1:1 with channel in 11b-2). Same derivation as
        // ensureGroupForDM uses.
        const groupID = uuidToBytes(op.channelID);

        const payload: MlsCommitBundlePayload = {
          channel_id: op.channelID,
          mls_group_id: bytesToBase64(groupID),
          commit: bytesToBase64(commitBytes),
          welcome_for: [],
          epoch: op.epoch,
        };
        if (welcomeBytes && op.welcomeRecipientUserID) {
          payload.welcome_for = [{
            user_id: op.welcomeRecipientUserID,
            welcome: bytesToBase64(welcomeBytes),
          }];
        }

        const ack = (await op.send.request(
          TypeMlsCommitBundle,
          payload,
        )) as MlsCommitBundleAckPayload;
        op.serverAck = ack;
        return "success";
      } catch (err) {
        const op = activeOp;
        if (op) {
          op.serverError = err instanceof Error ? err : new Error(String(err));
        }
        return { abort: { reason: (err as any)?.message ?? "transport error" } };
      }
    },

    // We do not use sendMessage. CoreCrypto only invokes this for
    // certain protocol-mediated message routes (typically for the
    // proteus interop or specific MLS server-managed flows).
    // Returning "success" without delivery is safe for our use --
    // application messages are sent via our own onSend path, not
    // via the transport.
    sendMessage: async (_message: Uint8Array): Promise<any> => {
      console.warn("[chalk] MlsTransport.sendMessage called -- ignored (11b-2)");
      return "success";
    },

    // History-secret flows aren't used in 11b-2. Return an empty
    // MlsTransportData stub if called.
    prepareForTransport: async (_secret: any): Promise<any> => {
      throw new Error("MlsTransport.prepareForTransport not implemented (11b-2)");
    },
  };

  if (typeof session.provideTransport === "function") {
    await session.provideTransport(transport);
  } else if (typeof session.provide_transport === "function") {
    await session.provide_transport(transport);
  } else {
    throw new Error("core-crypto: no provideTransport method on session");
  }
  transportInstalled.add(session);
}

// ---- group create / ensure ------------------------------------------

export async function ensureGroupForDM(
  channelID: string,
  peerUserID: string,
  input: MlsInitInput,
  send: SendFn,
): Promise<Uint8Array> {
  const session = await getMlsSession(input);
  const sAny = session as any;
  await ensureTransport(sAny);

  const groupID = uuidToBytes(channelID);

  const exists = await probeConversationExists(sAny, groupID);
  if (exists) {
    return groupID;
  }

  // Fetch peer's KP.
  const kpAck = (await send.request(TypeFetchKeyPackages, {
    user_ids: [peerUserID],
    ciphersuite: CIPHERSUITE,
  } as FetchKeyPackagesPayload)) as FetchKeyPackagesAckPayload;

  if (!kpAck.key_packages || kpAck.key_packages.length === 0) {
    throw new Error(
      `peer ${peerUserID} has no KeyPackages available; they need to log in once to enable encrypted DMs`,
    );
  }
  const peerKP = base64ToBytes(kpAck.key_packages[0].key_package_data);

  await sAny.transaction(async (ctx: any) => {
    // 1. Create the conversation.
    if (typeof ctx.createConversation === "function") {
      try {
        await ctx.createConversation(cid(groupID), CREDENTIAL_TYPE, {
          ciphersuite: CIPHERSUITE,
        });
      } catch (e) {
        await ctx.createConversation(cid(groupID), {
          ciphersuite: CIPHERSUITE,
          credentialType: CREDENTIAL_TYPE,
        });
      }
    } else if (typeof ctx.newConversation === "function") {
      await ctx.newConversation(cid(groupID), {
        ciphersuite: CIPHERSUITE,
        credentialType: CREDENTIAL_TYPE,
      });
    } else {
      throw new Error("core-crypto: no createConversation method found");
    }

    // 2. Set the active transport op, then add the peer. The
    //    sendCommitBundle callback will fire DURING this call and
    //    handle the wire post. Epoch goes 0 -> 1 on the first add.
    activeOp = {
      channelID,
      welcomeRecipientUserID: peerUserID,
      send,
      epoch: 1,
    };
    try {
      if (typeof ctx.addClientsToConversation === "function") {
        await ctx.addClientsToConversation(cid(groupID), [peerKP]);
      } else if (typeof ctx.addClients === "function") {
        await ctx.addClients(cid(groupID), [peerKP]);
      } else if (typeof ctx.add_clients_to_conversation === "function") {
        await ctx.add_clients_to_conversation(cid(groupID), [peerKP]);
      } else {
        throw new Error("core-crypto: no addClientsToConversation method found");
      }
    } finally {
      // Always read+clear the op so a thrown error during the add
      // doesn't leave stale state.
      const op = activeOp;
      activeOp = null;
      if (op?.serverError) {
        throw op.serverError;
      }
      // For ack inspection by the caller, expose any "delivered"
      // count via a console log.
      if (op?.serverAck) {
        console.log("[chalk] MLS commit_bundle delivered:", op.serverAck);
      }
    }
  });

  return groupID;
}

// ---- welcome processing ---------------------------------------------

// Phase 11b-2 fix3: WelcomeBundle.id is broken in core-crypto 9.3.4
// (the getter calls __wbg_get_groupinfobundle_payload, a copy-paste
// bug). We avoid reading it entirely. The caller knows the channel
// ID and computes the group ID via the same derivation alice2
// used, so no extraction from the return value is needed.
//
// processWelcome's only useful side-effect from our perspective is
// to install the group into the local CoreCrypto keystore so
// subsequent encrypt/decrypt calls can reference it.
export async function processWelcome(
  welcomeBytes: Uint8Array,
  input: MlsInitInput,
): Promise<void> {
  const session = await getMlsSession(input);
  const sAny = session as any;
  await ensureTransport(sAny);

  await sAny.transaction(async (ctx: any) => {
    // Phase 11b-2 fix4: processWelcomeMessage's wasm-bindgen FFI
    // calls _assertClass(welcome, Welcome) on its first argument.
    // We must wrap our raw bytes in a Welcome instance.
    // (Same wrapper pattern as DatabaseKey / ClientId / ConversationId.)
    //
    // The configuration argument is built as
    //   new CustomConfiguration(keyRotationSpan, wirePolicy)
    // where both fields are optional. {} or undefined are equivalent.
    const welcome = new (Welcome as any)(welcomeBytes);
    if (typeof ctx.processWelcomeMessage === "function") {
      await ctx.processWelcomeMessage(welcome, {});
    } else if (typeof ctx.processWelcome === "function") {
      await ctx.processWelcome(welcome, {});
    } else if (typeof ctx.process_welcome_message === "function") {
      await ctx.process_welcome_message(welcome, {});
    } else {
      throw new Error("core-crypto: no processWelcome method found");
    }
    // Result intentionally discarded. WelcomeBundle.id is broken in
    // 9.3.4 (fix3); the caller derives the group ID from channel_id.
  });
}

// ---- encrypt / decrypt ---------------------------------------------

export async function encryptForGroup(
  groupID: Uint8Array,
  plaintext: Uint8Array,
  input: MlsInitInput,
): Promise<Uint8Array> {
  const session = await getMlsSession(input);
  const sAny = session as any;
  await ensureTransport(sAny);

  let ciphertext: Uint8Array | null = null;
  await sAny.transaction(async (ctx: any) => {
    let result: any;
    if (typeof ctx.encryptMessage === "function") {
      result = await ctx.encryptMessage(cid(groupID), plaintext);
    } else if (typeof ctx.encrypt === "function") {
      result = await ctx.encrypt(cid(groupID), plaintext);
    } else if (typeof ctx.encrypt_message === "function") {
      result = await ctx.encrypt_message(cid(groupID), plaintext);
    } else {
      throw new Error("core-crypto: no encryptMessage method found");
    }
    ciphertext = extractBytes(result);
  });
  if (!ciphertext) {
    throw new Error("core-crypto: encryptMessage returned no bytes");
  }
  return ciphertext;
}

export async function decryptForGroup(
  groupID: Uint8Array,
  ciphertext: Uint8Array,
  input: MlsInitInput,
): Promise<Uint8Array> {
  const session = await getMlsSession(input);
  const sAny = session as any;
  await ensureTransport(sAny);

  let plaintext: Uint8Array | null = null;
  await sAny.transaction(async (ctx: any) => {
    let result: any;
    if (typeof ctx.decryptMessage === "function") {
      result = await ctx.decryptMessage(cid(groupID), ciphertext);
    } else if (typeof ctx.decrypt === "function") {
      result = await ctx.decrypt(cid(groupID), ciphertext);
    } else if (typeof ctx.decrypt_message === "function") {
      result = await ctx.decrypt_message(cid(groupID), ciphertext);
    } else {
      throw new Error("core-crypto: no decryptMessage method found");
    }
    plaintext =
      extractBytes(result) ??
      extractBytes(result?.message) ??
      extractBytes(result?.plaintext);
  });
  if (!plaintext) {
    throw new Error("core-crypto: decryptMessage returned no bytes");
  }
  return plaintext;
}

// ---- internal helpers -----------------------------------------------

function extractBytes(v: any): Uint8Array | null {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v.buffer instanceof Uint8Array) return v.buffer;
  if (v.buffer instanceof ArrayBuffer) return new Uint8Array(v.buffer);
  if (v.bytes instanceof Uint8Array) return v.bytes;
  if (typeof v.copyBytes === "function") {
    try { return v.copyBytes(); } catch { /* ignore */ }
  }
  return null;
}

async function probeConversationExists(
  sAny: any,
  groupID: Uint8Array,
): Promise<boolean> {
  try {
    if (typeof sAny.conversationExists === "function") {
      return !!(await sAny.conversationExists(cid(groupID)));
    }
  } catch { /* ignore */ }
  try {
    if (typeof sAny.conversation_exists === "function") {
      return !!(await sAny.conversation_exists(cid(groupID)));
    }
  } catch { /* ignore */ }
  try {
    if (typeof sAny.conversationEpoch === "function") {
      await sAny.conversationEpoch(cid(groupID));
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) {
    throw new Error(`uuidToBytes: not a 16-byte UUID: ${uuid}`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Helper for callers (App.tsx) that need to derive the group ID
// from a channel UUID without importing uuidToBytes directly.
export function channelToGroupID(channelID: string): Uint8Array {
  return uuidToBytes(channelID);
}

export { initWasmModule };
