// chalk-web -- ambient types for file assets the bundle imports.
//
// 102-1: esbuild's file loader (build.mjs) turns an import of a .wav into
// its content-hashed URL. tsc never sees build.mjs, so this is where it
// learns the same thing. 102-4 adds .mp3 for the arcade theme, whose cues
// ship in the form upstream publishes rather than transcoded.
declare module "*.wav" {
  const url: string;
  export default url;
}

declare module "*.mp3" {
  const url: string;
  export default url;
}
