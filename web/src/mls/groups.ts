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
  // Phase 11c-2 PR 2: multi-member operations.
  TypeAddToChannel,
  TypeRemoveFromChannel,
  TypeFetchMlsCommits,
  type AddToChannelPayload,
  type AddToChannelAckPayload,
  type RemoveFromChannelPayload,
  type FetchMlsCommitsPayload,
  type FetchMlsCommitsAckPayload,
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
  // Phase 11c-2 PR 5: plural form. Transport callback fans the
  // same welcome bytes to each recipient (each finds their own
  // entry in the CoreCrypto Welcome bundle; the others are
  // inert). Single-add ops pass a 1-entry array; multi-member
  // bootstrap passes the full peer list. Empty / undefined =
  // no welcomes (e.g. remove ops, key-rotation updates).
  welcomeRecipientUserIDs?: string[];
  send: SendFn;
  // Captured during the callback so the caller can read it post-resolve.
  serverAck?: MlsCommitBundleAckPayload;
  serverError?: Error;
  // Bump per-conversation so we know what epoch to send. The
  // bundle's epoch is what CoreCrypto produced; we just trust it.
  // For first-add, CoreCrypto's internal epoch goes from 0 to 1.
  epoch: number;
  // Phase 11c-2 PR 2: declared membership changes for this op.
  // Server validates these against its in-memory auth cache
  // (populated by add_to_channel / remove_from_channel handlers).
  // Empty arrays / undefined means "no membership change in this
  // commit" (e.g. a key-rotation Update or DM-creation bundle).
  proposedAdds?: string[];     // UUIDs being added
  proposedRemoves?: string[];  // UUIDs being removed
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
        if (
          welcomeBytes &&
          op.welcomeRecipientUserIDs &&
          op.welcomeRecipientUserIDs.length > 0
        ) {
          const welcomeB64 = bytesToBase64(welcomeBytes);
          payload.welcome_for = op.welcomeRecipientUserIDs.map((uid) => ({
            user_id: uid,
            welcome: welcomeB64,
          }));
        }
        // Phase 11c-2 PR 2: thread proposed_adds / proposed_removes
        // into the payload. Server validates against its auth cache.
        if (op.proposedAdds && op.proposedAdds.length > 0) {
          payload.proposed_adds = op.proposedAdds;
        }
        if (op.proposedRemoves && op.proposedRemoves.length > 0) {
          payload.proposed_removes = op.proposedRemoves;
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

  // Phase 11c-2 PR 5: take the op-mutex (latent PR-2 bug fix --
  // without this, a concurrent addMemberToGroup could clobber
  // activeOp mid-bootstrap).
  const dmRelease = await acquireOpMutex();
  try {
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
      welcomeRecipientUserIDs: [peerUserID],
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
  } finally {
    dmRelease();
  }

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

// wipeLocalConversation deletes this device's LOCAL CoreCrypto group
// state for a channel. Called when we're removed from the channel
// (phase 11c-9), so that a later re-add Welcome processes cleanly into
// a fresh group instead of OrphanWelcoming against stale local state.
//
// Best-effort and method-probed (CoreCrypto 9.3.4's method name is
// unreliable in the TS types, same as every other call here). If no
// wipe method matches, or the conversation doesn't exist, it's a no-op
// and never throws -- the caller treats removal-cleanup as advisory.
//
// Does NOT affect readable scrollback: the phase 11c-4 plaintext cache
// is keyed by ciphertext hash, independent of the live group, so wiping
// here leaves cached history intact.
export async function wipeLocalConversation(
  channelID: string,
  input: MlsInitInput,
): Promise<void> {
  try {
    const session = await getMlsSession(input);
    const sAny = session as any;
    const groupID = uuidToBytes(channelID);

    // Nothing to wipe if we have no local group.
    if (!(await probeConversationExists(sAny, groupID))) {
      return;
    }

    // Probe the deletion method (names vary across CoreCrypto versions).
    const c = cid(groupID);
    if (typeof sAny.wipeConversation === "function") {
      await sAny.wipeConversation(c);
      return;
    }
    if (typeof sAny.wipe_conversation === "function") {
      await sAny.wipe_conversation(c);
      return;
    }
    if (typeof sAny.deleteConversation === "function") {
      await sAny.deleteConversation(c);
      return;
    }
    // No known method: leave it. A re-add may still OrphanWelcome, but
    // we've not made anything worse. Log so this is visible.
    console.warn(
      "[chalk] wipeLocalConversation: no CoreCrypto wipe method found; " +
        "stale local group left in place for channel " + channelID,
    );
  } catch (err) {
    // Best-effort: removal-cleanup must never throw into the caller.
    console.warn("[chalk] wipeLocalConversation failed (non-fatal):", err);
  }
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

// ===================================================================
// Phase 11c-2 PR 2: multi-member MLS channel operations.
// ===================================================================
//
// PR 2 adds the client-side primitives for multi-member MLS:
//   * addMemberToGroup     -- alice adds target to an existing group
//   * removeMemberFromGroup -- alice removes target (or self) from group
//   * processCommitEvent   -- inbound mls_commit_event push (live or catchup)
//   * fetchCommitsCatchup  -- client-initiated catchup on reconnect
//
// Wire integration with the existing ensureGroupForDM transport hook
// is via two extensions to ActiveOp: proposedAdds and proposedRemoves
// are now plumbed into the mls_commit_bundle payload so the server
// can validate the declared changes against its in-memory auth cache
// (chalkd's MlsAuthorizationStore, populated by add_to_channel /
// remove_from_channel handlers).

// addMemberToGroup is the multi-member analog of "alice adds bob to
// a DM". It is a 3-step round-trip:
//
//   1. C->S add_to_channel(channel, target)  -> ack returns target's KP
//   2. Local: addClientsToConversation(KP) -> CoreCrypto produces
//      Commit + Welcome via the transport callback
//   3. The transport callback posts mls_commit_bundle with
//      proposed_adds=[target] -- server validates the auth (from
//      step 1's recorded entry), atomically writes the commit and
//      adds the member to channel_members, fans the Welcome.
//
// Caller must be a current member of the channel (server enforces
// this in handleAddToChannel). The channel must already exist and
// be MLS-encrypted.
export async function addMemberToGroup(
  channelID: string,
  targetUserID: string,
  input: MlsInitInput,
  send: SendFn,
): Promise<void> {
  // Step 1: server claims a KeyPackage for the target and records
  // an authorization in the auth cache (60s TTL, single-use).
  const ack = (await send.request(TypeAddToChannel, {
    channel_id: channelID,
    target_user_id: targetUserID,
    ciphersuite: CIPHERSUITE,
  } as AddToChannelPayload)) as AddToChannelAckPayload;

  if (!ack || !ack.key_package || !ack.key_package.key_package_data) {
    throw new Error(
      `add_to_channel returned no KeyPackage for ${targetUserID}`,
    );
  }
  const peerKP = base64ToBytes(ack.key_package.key_package_data);

  // Step 2: local CoreCrypto adds the client. Transport callback
  // (sendCommitBundle, in ensureTransport) fires DURING the call
  // and posts mls_commit_bundle to the server with proposed_adds.
  const session = await getMlsSession(input);
  const sAny = session as any;
  await ensureTransport(sAny);
  const release = await acquireOpMutex();
  try {
    const groupID = uuidToBytes(channelID);
    const currentEpoch = await readCurrentEpoch(sAny, groupID);
    const nextEpoch = currentEpoch + 1;

    await sAny.transaction(async (ctx: any) => {
      activeOp = {
        channelID,
        welcomeRecipientUserIDs: [targetUserID],
        send,
        epoch: nextEpoch,
        proposedAdds: [targetUserID],
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
        const op = activeOp;
        activeOp = null;
        if (op?.serverError) {
          throw op.serverError;
        }
      }
    });
  } finally {
    release();
  }
}

// removeMemberFromGroup is the multi-member analog of "alice removes
// bob from a channel". The flow:
//
//   1. C->S remove_from_channel(channel, target)  -> ack (auth recorded)
//   2. Local: find target's client_id(s) in the conversation
//   3. Local: removeClientsFromConversation(clientIds) -> CoreCrypto
//      produces a Remove Commit via the transport callback
//   4. Transport callback posts mls_commit_bundle with
//      proposed_removes=[target] -- server validates, atomically
//      writes the commit and deletes the member from channel_members,
//      fans mls_commit_event to remaining members.
//
// "target == caller" is the self-leave case; server always allows
// it. "target != caller" requires caller to be the channel creator
// (server enforces).
//
// In chalk 11b/11c, each user has at most one MLS client in a given
// conversation (single-device per user; multi-device is phase 11d).
// We remove that single client. If multi-device is added later, this
// function will need to remove ALL of target's clients.
export async function removeMemberFromGroup(
  channelID: string,
  targetUserID: string,
  input: MlsInitInput,
  send: SendFn,
): Promise<void> {
  // Step 1: server-side authorization. The handler validates
  // permission (self-leave or channel-creator) and records an
  // entry in the auth cache.
  await send.request(TypeRemoveFromChannel, {
    channel_id: channelID,
    target_user_id: targetUserID,
  } as RemoveFromChannelPayload);
  // The ack carries no extra info; the server will surface any
  // permission failures as an error response (sendError) which
  // send.request rejects on.

  // Step 2: find target's client ID(s) in the local conversation.
  const session = await getMlsSession(input);
  const sAny = session as any;
  await ensureTransport(sAny);
  const release = await acquireOpMutex();
  try {
    const groupID = uuidToBytes(channelID);
    const currentEpoch = await readCurrentEpoch(sAny, groupID);
    const nextEpoch = currentEpoch + 1;

    const targetClientIDs = await listClientIdsForUser(
      sAny, groupID, targetUserID,
    );
    if (targetClientIDs.length === 0) {
      throw new Error(
        `target ${targetUserID} has no clients in the local MLS group; ` +
        `local state may be stale -- try fetch_mls_commits to catch up`,
      );
    }

    // Step 3: produce the Remove Commit. Transport callback posts it.
    await sAny.transaction(async (ctx: any) => {
      activeOp = {
        channelID,
        send,
        epoch: nextEpoch,
        proposedRemoves: [targetUserID],
        // No welcome recipient on remove.
      };
      try {
        if (typeof ctx.removeClientsFromConversation === "function") {
          await ctx.removeClientsFromConversation(cid(groupID), targetClientIDs);
        } else if (typeof ctx.removeClients === "function") {
          await ctx.removeClients(cid(groupID), targetClientIDs);
        } else if (typeof ctx.remove_clients_from_conversation === "function") {
          await ctx.remove_clients_from_conversation(cid(groupID), targetClientIDs);
        } else {
          throw new Error("core-crypto: no removeClientsFromConversation method found");
        }
      } finally {
        const op = activeOp;
        activeOp = null;
        if (op?.serverError) {
          throw op.serverError;
        }
      }
    });
  } finally {
    release();
  }
}

// processCommitEvent is called when an mls_commit_event push frame
// arrives (live broadcast from another member's commit, OR a catchup
// commit streamed by handleFetchMlsCommits). Either way we feed the
// commit bytes to CoreCrypto's decryptMessage, which advances the
// local group state.
//
// Returns the new epoch after processing. The caller can use this to
// update any local per-channel epoch tracking (e.g. for deciding
// whether to fetch more catchup commits).
//
// Acquires the op-mutex to serialize against any in-flight
// addMemberToGroup / removeMemberFromGroup: processing an inbound
// commit while we're mid-build of an outbound one would corrupt the
// epoch the outbound commit gets sent at.
//
// Errors:
//   - If the local group doesn't exist (we were never a member, or
//     CoreCrypto state was wiped), throws. Caller should ignore
//     events for unknown channels.
//   - If the commit is malformed or for the wrong epoch, CoreCrypto
//     throws. Caller may want to trigger a full catchup.
// Phase 11c-3 PR 4: sentinel returned by processCommitEvent when the
// local CoreCrypto has no conversation for the channel yet. This is
// the benign commit_event-before-Welcome race: the Welcome that
// follows will install the full group state, so the un-processable
// commit is already reflected and needs no recovery. Distinguishable
// from a real failure (which still throws) so the caller can skip the
// pointless catchup. Mirrors fetchCommitsCatchup, which likewise
// treats "no local conversation" as a no-op (returns 0).
export const COMMIT_EVENT_NO_CONVERSATION = -1;

export async function processCommitEvent(
  channelID: string,
  commitBytes: Uint8Array,
  input: MlsInitInput,
): Promise<number> {
  const session = await getMlsSession(input);
  const sAny = session as any;
  await ensureTransport(sAny);

  const groupID = uuidToBytes(channelID);

  // If we're not in this conversation locally, we can't process
  // commits for it. The caller should buffer or discard.
  const exists = await probeConversationExists(sAny, groupID);
  if (!exists) {
    // Phase 11c-3 PR 4: benign commit_event-before-Welcome race. Do
    // not throw -- the Welcome that follows installs the group state,
    // so this commit is already accounted for. Signal the caller to
    // skip recovery rather than logging a scary error + running a
    // catchup that can do nothing (no local conversation to apply to).
    return COMMIT_EVENT_NO_CONVERSATION;
  }

  const release = await acquireOpMutex();
  try {
    await sAny.transaction(async (ctx: any) => {
      // decryptMessage handles both application messages AND Commits.
      // For a Commit, the returned result has no plaintext (we
      // don't read it); the side effect is the group epoch advance.
      if (typeof ctx.decryptMessage === "function") {
        await ctx.decryptMessage(cid(groupID), commitBytes);
      } else if (typeof ctx.decrypt === "function") {
        await ctx.decrypt(cid(groupID), commitBytes);
      } else if (typeof ctx.decrypt_message === "function") {
        await ctx.decrypt_message(cid(groupID), commitBytes);
      } else {
        throw new Error("core-crypto: no decryptMessage method found");
      }
    });
  } finally {
    release();
  }

  return readCurrentEpoch(sAny, groupID);
}

// fetchCommitsCatchup queries the server for any stored commits past
// the local known epoch and processes them in order. Used:
//   * On reconnect, for every MLS channel we're a member of
//   * After receiving mls_stale_commit on our own commit_bundle (to
//     catch up before retrying)
//   * On startup if we receive an mls_commit_event for a much-later
//     epoch than we expect (probably indicating we missed events)
//
// The server streams each commit as an mls_commit_event push frame,
// then sends fetch_mls_commits_ack with the total count. The push
// frames are processed by the App.tsx dispatcher via
// processCommitEvent -- this function only sends the request and
// awaits the ack.
//
// Returns the number of commits the server reported streaming. The
// caller can compare against how many push frames it actually saw
// dispatched (the WS guarantees in-order delivery, but the ack
// arrives last so caller can correlate).
export async function fetchCommitsCatchup(
  channelID: string,
  input: MlsInitInput,
  send: SendFn,
): Promise<number> {
  const session = await getMlsSession(input);
  const sAny = session as any;
  const groupID = uuidToBytes(channelID);

  // If we don't have a local conversation for this channel, there's
  // nothing to catch up TO -- we'd have nowhere to apply the commits.
  const exists = await probeConversationExists(sAny, groupID);
  if (!exists) {
    return 0;
  }

  const localEpoch = await readCurrentEpoch(sAny, groupID);

  const ack = (await send.request(TypeFetchMlsCommits, {
    channel_id: channelID,
    after_epoch: localEpoch,
  } as FetchMlsCommitsPayload)) as FetchMlsCommitsAckPayload;

  return ack?.count ?? 0;
}

// ---- internal: per-channel CoreCrypto helpers ----------------------

// readCurrentEpoch reads CoreCrypto's stored epoch for a conversation
// and returns it as a JS number. CoreCrypto returns BigInt; we narrow
// here because realistic group lifetimes don't approach Number.MAX_SAFE_INTEGER.
async function readCurrentEpoch(
  sAny: any,
  groupID: Uint8Array,
): Promise<number> {
  if (typeof sAny.conversationEpoch !== "function") {
    throw new Error("core-crypto: no conversationEpoch method found");
  }
  const epoch = await sAny.conversationEpoch(cid(groupID));
  // BigInt | number tolerated.
  return typeof epoch === "bigint" ? Number(epoch) : Number(epoch);
}

// listClientIdsForUser returns every MLS ClientId in the conversation
// whose textual form starts with `<userID>:`. In 11b/11c that's at
// most one per user (single-device); 11d's multi-device support will
// produce multiples, all of which we remove together.
async function listClientIdsForUser(
  sAny: any,
  groupID: Uint8Array,
  userID: string,
): Promise<any[]> {
  let raw: any;
  if (typeof sAny.getClientIds === "function") {
    raw = await sAny.getClientIds(cid(groupID));
  } else if (typeof sAny.clientIds === "function") {
    raw = await sAny.clientIds(cid(groupID));
  } else if (typeof sAny.get_client_ids === "function") {
    raw = await sAny.get_client_ids(cid(groupID));
  } else if (typeof sAny.conversationMembers === "function") {
    raw = await sAny.conversationMembers(cid(groupID));
  } else {
    throw new Error("core-crypto: no getClientIds method found");
  }

  // raw is an array of ClientId-like wrappers or raw byte arrays.
  // Each one's textual form should be "<userID>:<deviceID>". Filter
  // to those that match the target user.
  const prefix = `${userID}:`;
  const out: any[] = [];
  for (const c of raw) {
    const text = decodeClientId(c);
    if (text.startsWith(prefix)) {
      out.push(c);
    }
  }
  return out;
}

// decodeClientId turns a CoreCrypto ClientId-like value into its
// textual "<userID>:<deviceID>" form, defending against several
// possible representations.
function decodeClientId(c: any): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  // Wrapper with a toString or text accessor?
  if (typeof c.toString === "function") {
    const s = c.toString();
    // Default Object.toString returns "[object Object]"; reject.
    if (s && !s.startsWith("[object ")) return s;
  }
  // Byte access?
  const bytes = extractBytes(c) ?? extractBytes(c?.bytes) ?? extractBytes(c?.value);
  if (bytes) return new TextDecoder().decode(bytes);
  return "";
}

// ---- per-operation mutex --------------------------------------------
//
// The transport hook stores per-call context in the module-level
// `activeOp`. Two concurrent commit operations would clobber each
// other. We serialize them with a Promise-based mutex.
//
// This is per-MODULE not per-channel: even concurrent ops on
// DIFFERENT channels serialize. Could be relaxed to per-channel if
// throughput ever matters, but channel ops are user-driven (clicking
// "add member") so contention is essentially zero in practice.
//
// Idiomatic usage:
//   const release = await acquireOpMutex();
//   try { ... } finally { release(); }

let opMutexChain: Promise<void> = Promise.resolve();

async function acquireOpMutex(): Promise<() => void> {
  const prev = opMutexChain;
  let release!: () => void;
  opMutexChain = new Promise<void>((r) => { release = r; });
  await prev;
  return release;
}

// ensureGroupForChannel is the multi-member analog of ensureGroupForDM.
// Idempotent: returns the local groupID if a conversation already
// exists for channelID. Otherwise creates one and adds every peer
// in `otherMemberUserIDs` as MLS members in a single Commit + Welcome
// bundle.
//
// otherMemberUserIDs MUST NOT include the caller's own user_id; the
// caller is implicitly the first member of the group (CoreCrypto's
// createConversation sets that up). Pass the full channel_members
// list minus your own id from the caller.
//
// Empty otherMemberUserIDs is allowed: creates a single-member
// (self-only) group. Useful for receiving someone else's add later
// without needing to bootstrap from scratch on first encrypt.
//
// Throws if any peer has no available KeyPackage (with the peer's
// user_id in the error message so the caller can surface a useful
// banner).
//
// Phase 11c-2 PR 5.
// Phase 11c-6: thrown by ensureGroupForChannel when this client has no
// local MLS group for a channel that ALREADY has a group lineage on the
// server (other members, prior commits). The client cannot self-recover
// -- MLS private state only arrives via a Welcome -- so rather than
// bootstrap a divergent group, we refuse and surface this. The UI can
// match on `name === "MlsLocalStateLostError"` to show a re-add prompt.
export class MlsLocalStateLostError extends Error {
  readonly channelID: string;
  constructor(channelID: string) {
    super(
      `local MLS state for channel ${channelID} is missing, but the ` +
        `channel already has a group on the server; this device must be ` +
        `removed and re-added to rejoin (cannot self-recover from commits)`,
    );
    this.name = "MlsLocalStateLostError";
    this.channelID = channelID;
  }
}

// channelHasServerCommits asks the server whether a channel already has
// any stored MLS commits (i.e. an established group lineage). Uses the
// existing fetch_mls_commits catchup request with after_epoch=0; the
// ack's count reflects the full stored history. Unlike fetchCommitsCatchup
// this does NOT require (or touch) a local conversation -- it's a pure
// existence probe. Any commits the server streams in response are
// harmlessly no-op'd by processCommitEvent when there's no local group
// (COMMIT_EVENT_NO_CONVERSATION).
export async function channelHasServerCommits(
  channelID: string,
  send: SendFn,
): Promise<boolean> {
  const ack = (await send.request(TypeFetchMlsCommits, {
    channel_id: channelID,
    after_epoch: 0,
  } as FetchMlsCommitsPayload)) as FetchMlsCommitsAckPayload;
  return (ack?.count ?? 0) > 0;
}

export async function ensureGroupForChannel(
  channelID: string,
  otherMemberUserIDs: string[],
  input: MlsInitInput,
  send: SendFn,
): Promise<Uint8Array> {
  const session = await getMlsSession(input);
  const sAny = session as any;
  await ensureTransport(sAny);

  const groupID = uuidToBytes(channelID);

  if (await probeConversationExists(sAny, groupID)) {
    return groupID;
  }

  // Empty case: create a self-only group, no commit needed since
  // there are no peers to receive a Welcome. The local epoch starts
  // at 0 and stays there until the first add.
  if (otherMemberUserIDs.length === 0) {
    const release = await acquireOpMutex();
    try {
      await sAny.transaction(async (ctx: any) => {
        await createConversationDefensively(ctx, groupID);
      });
    } finally {
      release();
    }
    return groupID;
  }

  // Phase 11c-6: split-brain guard. We have no local group for this
  // channel but it HAS peers. Before bootstrapping a fresh group,
  // check whether the channel already has a group lineage on the
  // server. If it does, bootstrapping here would create a divergent
  // second group under the same channel id -- the bug that made
  // channels permanently unrecoverable after a local-state reset.
  // We can't self-recover (MLS private state comes only via a Welcome),
  // so refuse and surface a re-add condition instead.
  if (await channelHasServerCommits(channelID, send)) {
    throw new MlsLocalStateLostError(channelID);
  }

  // Fetch KPs for ALL peers in one server round-trip. The server
  // returns one KP per requested user_id; missing peers are absent
  // from the response array (not an error).
  const kpAck = (await send.request(TypeFetchKeyPackages, {
    user_ids: otherMemberUserIDs,
    ciphersuite: CIPHERSUITE,
  } as FetchKeyPackagesPayload)) as FetchKeyPackagesAckPayload;

  // Build the list of KP bytes in the SAME order as
  // otherMemberUserIDs so the welcome_for fan-out below matches up.
  // Throw on any missing peer with their UID for the error banner.
  const peerKPs: Uint8Array[] = [];
  for (const uid of otherMemberUserIDs) {
    const entry = (kpAck.key_packages ?? []).find(
      (k) => k.user_id === uid,
    );
    if (!entry) {
      throw new Error(
        `member ${uid} has no KeyPackages; they need to log in at least once before they can join encrypted channels`,
      );
    }
    peerKPs.push(base64ToBytes(entry.key_package_data));
  }

  const release = await acquireOpMutex();
  try {
    await sAny.transaction(async (ctx: any) => {
      // 1. Create the conversation.
      await createConversationDefensively(ctx, groupID);

      // 2. Add all peers in one call. CoreCrypto produces ONE
      //    Commit + ONE Welcome bundle that contains entries for
      //    every new member. The transport callback fans the same
      //    welcome bytes to each recipient (each finds their own
      //    entry in the bundle; the others are inert to them).
      activeOp = {
        channelID,
        welcomeRecipientUserIDs: otherMemberUserIDs,
        send,
        epoch: 1,
      };
      try {
        if (typeof ctx.addClientsToConversation === "function") {
          await ctx.addClientsToConversation(cid(groupID), peerKPs);
        } else if (typeof ctx.addClients === "function") {
          await ctx.addClients(cid(groupID), peerKPs);
        } else if (typeof ctx.add_clients_to_conversation === "function") {
          await ctx.add_clients_to_conversation(cid(groupID), peerKPs);
        } else {
          throw new Error("core-crypto: no addClientsToConversation method found");
        }
      } finally {
        const op = activeOp;
        activeOp = null;
        if (op?.serverError) {
          throw op.serverError;
        }
        if (op?.serverAck) {
          console.log("[chalk] MLS group bootstrap delivered:", op.serverAck);
        }
      }
    });
  } finally {
    release();
  }

  return groupID;
}

// createConversationDefensively wraps CoreCrypto's createConversation
// with the same method-name probing the existing ensureGroupForDM
// uses (9.3.4 ships two-arg and three-arg signatures; we try both).
async function createConversationDefensively(
  ctx: any,
  groupID: Uint8Array,
): Promise<void> {
  if (typeof ctx.createConversation === "function") {
    try {
      await ctx.createConversation(cid(groupID), CREDENTIAL_TYPE, {
        ciphersuite: CIPHERSUITE,
      });
      return;
    } catch (e) {
      await ctx.createConversation(cid(groupID), {
        ciphersuite: CIPHERSUITE,
        credentialType: CREDENTIAL_TYPE,
      });
      return;
    }
  }
  if (typeof ctx.newConversation === "function") {
    await ctx.newConversation(cid(groupID), {
      ciphersuite: CIPHERSUITE,
      credentialType: CREDENTIAL_TYPE,
    });
    return;
  }
  throw new Error("core-crypto: no createConversation method found");
}

