# Updating @wireapp/core-crypto

chalk pins **`@wireapp/core-crypto`** to an exact version (no `^`, no `~`)
because cryptographic libraries are uniquely sensitive to surprises.
Every upgrade is a deliberate, reviewed change.

## When to update

- A new chalk MLS phase needs an API that's only in a newer version.
- A security advisory affects the version you have.
- You're doing a routine quarterly review (recommended).

## How to update

1. **Check what's current.**

   ```sh
   make crypto-check-version
   ```

   This prints `local: X.Y.Z` and `latest on npm: A.B.C`.

2. **Read the changelog between your version and the target.**

   Open https://github.com/wireapp/core-crypto/blob/main/CHANGELOG.md.
   Look for `[breaking]` markers, API renames, and migration notes.

3. **Update `web/package.json`** with the new exact version:

   ```json
   "dependencies": {
     "@wireapp/core-crypto": "9.3.4"
   }
   ```

   Use the exact string, no SemVer range operators.

4. **Refresh the lockfile and install:**

   ```sh
   cd web && npm install --package-lock-only
   npm install
   ```

5. **Read `web/src/mls/loader.ts` carefully.** This file is the
   smallest blast-radius for upstream API changes: it has a defensive
   `any`-typed probe of the constructor shape so common renames don't
   break our build at compile time, but they WILL show up at runtime.
   If the new version renamed `openDatabase` → `openDB` (for example),
   you'll see a clear error message pointing you here.

6. **Verify the build:**

   ```sh
   cd web && npm run build && npx tsc --noEmit
   make dev
   ```

7. **Verify the runtime:** log in fresh; check DevTools console for
   `[chalk] MLS KP stock: { before: N, after: M, published: K }`.
   Run a DB query to confirm KPs landed:

   ```sh
   docker exec -i chalk-dev-pg psql -U chalk -d chalk -c \
     "SELECT count(*) FROM key_packages WHERE used_at IS NULL;"
   ```

8. **Commit the bump in its own commit:**

   ```sh
   git add web/package.json web/package-lock.json
   git commit -m "chore(mls): bump @wireapp/core-crypto to X.Y.Z"
   ```

## Notes on supply-chain risk

npm has seen multiple supply-chain compromises in 2025-2026 (TanStack,
Antv, etc). The pinned lockfile + exact version + integrity hashes
protect against silently shipping a tampered version. Do NOT use
`npm update` or any "auto-bump" tooling for this dependency.

## License

`@wireapp/core-crypto` is GPL-3.0. chalk is GPL-3.0-or-later
(relicensed from MIT in phase 11a). The licenses are compatible.
