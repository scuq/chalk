# Vendored MediaPipe assets

## selfie_segmenter.tflite

The segmentation model behind "blur my background" (52-2). It answers one
question per frame — for each pixel, person or room — and nothing else: it
never leaves the browser, and no frame it sees leaves the device.

| | |
|---|---|
| Source | <https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite> |
| SHA-256 | `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b` |
| Size | 249,537 bytes |
| License | Apache-2.0 (Google, MediaPipe model card: <https://developers.google.com/mediapipe/solutions/vision/image_segmenter>) |
| Vendored | 30 July 2026 |

**Why it is committed rather than downloaded at build time.** It is not on npm,
so the alternative is a network fetch inside the image build — which makes
builds non-reproducible, silently moves under a `latest/` URL, and puts a
third-party host on the critical path of `chalkctl update`. A committed blob
with a recorded hash is auditable and builds offline.

To update: download, verify the size and hash change is expected, replace the
file, and update the table above. The runtime WASM is *not* vendored — it comes
from the `@mediapipe/tasks-vision` npm package and is pinned by
`package-lock.json`; `build.mjs` copies it out of `node_modules` at build time.
