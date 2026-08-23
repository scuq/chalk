// chalk-web -- ambient types for file assets the bundle imports.
//
// 102-1: esbuild's file loader (build.mjs) turns an import of a .wav into
// its content-hashed URL. tsc never sees build.mjs, so this is where it
// learns the same thing.
declare module "*.wav" {
  const url: string;
  export default url;
}
