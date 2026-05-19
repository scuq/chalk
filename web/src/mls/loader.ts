// Phase 11a (fix4): lazy loader for @wireapp/core-crypto.
//
// CoreCrypto 9.3.4 init flow:
//   1. await initWasmModule()    -- wasm-bindgen bootstrap
//   2. await CoreCrypto.init({
//        databaseName,           -- string
//        key,                    -- DatabaseKey instance (bytes->wrapper)
//        clientId,               -- ClientId instance (bytes->wrapper)
//        ciphersuites,           -- number[]
//      })
//
// CoreCrypto.init opens the database itself; no separate openDatabase
// call is needed. And when clientId + ciphersuites are present, it
// performs MLS initialization automatically -- no explicit mlsInit
// in a transaction.
//
// The d.ts comments in 9.3.4 are stale (they show string args for key
// and clientId); read corecrypto.js for the truth -- _assertClass
// calls confirm the runtime expects the wrapper instances.

import {
  initWasmModule,
  CoreCrypto,
  DatabaseKey,
  ClientId,
} from "@wireapp/core-crypto";

export interface MlsInitInput {
  /** UUID of the user. The client_id will be `${userID}:${deviceID}`. */
  userID: string;
  /** UUID of this device. */
  deviceID: string;
  /** 32-byte device-local secret used as the IndexedDB keystore key. */
  databaseKey: Uint8Array;
}

// Singletons: only the first call does work; subsequent calls reuse.
let wasmInitPromise: Promise<void> | null = null;
let sessionPromise: Promise<unknown> | null = null;

async function ensureWasmInit(): Promise<void> {
  if (!wasmInitPromise) {
    wasmInitPromise = (initWasmModule as any)();
  }
  await wasmInitPromise;
}

/**
 * Load CoreCrypto (lazily) and return an initialized session. Safe
 * to call repeatedly; only the first call does work.
 */
export async function getMlsSession(input: MlsInitInput): Promise<unknown> {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    await ensureWasmInit();

    // Wrap raw bytes in the wasm-bindgen wrapper classes that
    // CoreCrypto.init asserts on internally.
    const dbKey = new DatabaseKey(input.databaseKey);
    const clientIdBytes = new TextEncoder().encode(`${input.userID}:${input.deviceID}`);
    const clientId = new ClientId(clientIdBytes);

    const ciphersuites = [1]; // MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519
    const databaseName = `chalk-mls-${input.userID}`;

    // CoreCrypto.init opens the DB and (when clientId + ciphersuites
    // are present) performs MLS init in one shot. The TS types in
    // 9.3.4 are incomplete, hence the `any` cast on the static call.
    const session = await (CoreCrypto as any).init({
      databaseName,
      key: dbKey,
      clientId,
      ciphersuites,
    });

    return session;
  })();
  return sessionPromise;
}

/**
 * Reset the cached session promise. Used on logout (where we want
 * the next user on the same browser to get a fresh session).
 */
export function clearMlsSession(): void {
  sessionPromise = null;
}
