# Releasing

GitHub pushes do not publish this package to npm. The workflow in `.github/workflows/test.yml` only runs tests.

Publish manually when you want `npm i -g promptpie` and `npx promptpie` users to receive a new version.

## Version contract

The npm package and Codex plugin have independent versions:

- `package.json` is `0.2.0` for the first public companion-capable CLI release.
- `plugins/prompt-pie/plugin.json` and its Codex overlay are `0.1.1`.
- The Prompt Pie skill requires CLI `0.2.0` or newer.

Keep both plugin manifests synchronized. Bump the plugin version when its packaged skill, reference, or interface changes. A patch bump covers truthful positioning and activation-language updates that leave the CLI protocol unchanged. Bump the npm version when the CLI package changes.

## Pre-merge checklist

1. Run the focused and full checks:

   ```bash
   npm run test:plugin
   npm test
   ```

2. Preview and inspect the npm tarball with npm 11:

   ```bash
   npm pack --dry-run --json
   ```

   Confirm npm reports no package corrections and the tarball contains current `bin/`, `lib/`, `docs/`, `README.md`, `LICENSE`, and package metadata. Install the packed artifact into an isolated prefix, confirm both `ppie` and `promptpie` command shims exist, and verify `ppie --version --json` reports `0.2.0`.

   For an npm CLI release, set the new `package.json` version first, then also run `npm publish --dry-run --json` before publishing. npm rejects a dry run for a version that already exists in the registry.

3. Validate repository and implicit personal marketplace installs with disposable OS, Codex, and Prompt Pie homes:

   ```bash
   RUN_CODEX_PLUGIN_ACCEPTANCE=1 npm run test:plugin
   ```

   Confirm the installed plugin has one skill and no MCP server or hooks. Run activation checks in a fresh task for `$prompt-pie`, connect, send, get, a single-file `SKILL.md` draft, an explanation-only request, and a contextual “send that one” follow-up. Confirm that a skill draft remains a one-document handoff until a separate user-directed local skill command finalizes it.

4. From the Prompt Pie repository, run the isolated browser harness against this CLI checkout:

   ```bash
   PPIE_CLI_REPO=/absolute/path/to/ppie-cli npm run test:e2e:local-companion
   ```

   The harness must use `--no-open`, temporary `PPIE_HOME`, and a disposable browser profile. The system Chrome profile stays untouched.

## Post-merge publish and acceptance

1. Confirm npm authentication, publish the merged source, and verify the exact artifact:

   ```bash
   npm whoami
   npm publish
   npm view promptpie@0.2.0 version
   npm pack promptpie@0.2.0 --dry-run --json
   ```

2. Install the exact registry package into an isolated prefix. Put its `node_modules/.bin` first on the acceptance task's `PATH`, resolve `ppie`, and verify JSON version `0.2.0`.

3. Install or upgrade the marketplace from the merged commit and install `prompt-pie@prompt-pie` in a clean Codex profile using that exact CLI path.

4. In a dedicated signed-out browser profile, complete connect, send, browser edit, get, direct `$prompt-pie`, stale-revision conflict, disconnect recovery, and Local Network Access denial/recovery checks. Repeat the installed flow on macOS and native Windows PowerShell. Keep Windows labeled preview until its gate passes.

5. Create and push the release tag only after the published artifact and installed-plugin checks pass:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

## Notes

- npm requires every publish to use a new `package.json` version.
- Do not run `npm publish` from the old Prompt Pie app repo.
- Keep release changes in this standalone repository: `github.com/jeremyrojas/ppie-cli`.
- Publishing, production installed-plugin acceptance, and the availability announcement happen after the implementation PR merges.
