// chalk-web -- one type assertion for the typed-array boundary.
//
// TypeScript 5.7 made typed arrays generic over their buffer, and the DOM lib
// that came with 5.9 tightened BufferSource and BlobPart to views over a real
// ArrayBuffer. chalk's byte helpers are declared as plain `Uint8Array`, which
// now means `Uint8Array<ArrayBufferLike>` -- "maybe a SharedArrayBuffer" --
// and every WebCrypto, Blob and WebSocket call site rejects it.
//
// chalk never creates a SharedArrayBuffer: every byte array here comes from
// `new Uint8Array(...)`, TextEncoder, getRandomValues, a WebCrypto result, or
// a subarray of one of those. So this is a statement of fact for the
// compiler, not a copy and not a runtime check. Use it at the boundary, not
// to launder unknown input.

export type Bytes = Uint8Array<ArrayBuffer>;

export function asBytes(b: Uint8Array): Bytes {
  return b as Bytes;
}
