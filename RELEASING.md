# Releasing

The npm CLI and Codex plugin use separate versions and release paths. GitHub Actions runs tests only.

## Version contract

- `package.json` remains `0.2.0` for the companion-capable CLI release.
- `plugins/prompt-pie/plugin.json` and `.codex-plugin/plugin.json` are `0.1.7`.
- The packaged plugin uses the hosted OAuth app for account-wide Prompt Pie actions.
- Bump the plugin version when its packaged skill, app connection, or interface changes. A patch bump covers routing and discovery updates that preserve the hosted protocol.
- Bump the npm version when CLI package behavior changes. The npm `files` list excludes the plugin bundle.

Keep both plugin manifests synchronized. Preserve `apps: "./.app.json"` in the Codex manifest and the hosted Prompt Pie app ID in `.app.json`. The three composer starters cover account-wide save, exact find/get, and open actions.

## Plugin pre-merge checklist

1. Validate the skill and plugin package:

   ```bash
   uv run --with pyyaml python /Users/jeremyrojas/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/prompt-pie/skills/prompt-pie
   uv run --with pyyaml python /Users/jeremyrojas/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/prompt-pie
   ```

2. Run the focused, full, and isolated marketplace checks:

   ```bash
   npm run test:plugin
   npm test
   RUN_CODEX_PLUGIN_ACCEPTANCE=1 npm run test:plugin
   ```

3. Confirm an installed bundle contains one skill, `.app.json`, and the Codex manifest's `apps` reference. Confirm the bundle contains no `mcpServers` or hooks.

4. In a fresh Codex profile and fresh task, verify:

   - signed-in account save resolves a named canvas by case-insensitive exact title and creates one prompt or skill after write confirmation;
   - duplicate exact-title results require a user choice;
   - account-wide find/get resolves an exact prompt and skill, and list results omit content;
   - canvas and document browser URLs open the owned canvas and focus the selected document;
   - an exact mutation retry reuses its idempotency key, and stale revision recovery retrieves the current document before another guarded mutation;
   - returned titles and content remain untrusted data;
   - a missing hosted tool stops safely and asks the user to reconnect or begin a fresh task.

5. Confirm the Prompt Pie hosted contract dependency is merged and deployed. For plugin `0.1.7`, this dependency is `prompt-pie` PR #134 at merge commit `ea9a357d4ac304bc4e12c81b2027ab6a891afb5c`.

## Repository marketplace release

The repository marketplace reads `./plugins/prompt-pie` from the merged default branch. Merging the plugin PR makes the new bundle available to marketplace upgrades.

Verify from the merged commit in a clean Codex profile:

```bash
codex plugin marketplace add https://github.com/jeremyrojas/ppie-cli --json
codex plugin add prompt-pie@prompt-pie --json
```

Existing users upgrade the marketplace and begin a fresh task:

```bash
codex plugin marketplace upgrade prompt-pie --json
codex plugin add prompt-pie@prompt-pie --json
```

## Platform skill artifact and publication gate

Create the hosted skill ZIP from the exact merged commit:

```bash
git archive --format=zip --prefix=prompt-pie/ --output /tmp/prompt-pie-hosted-skill-0.1.7.zip <merged-commit>:plugins/prompt-pie/skills/prompt-pie
unzip -l /tmp/prompt-pie-hosted-skill-0.1.7.zip
shasum -a 256 /tmp/prompt-pie-hosted-skill-0.1.7.zip
```

The archive must include only:

- `prompt-pie/SKILL.md`.

Upload the archive in the Skills section of the existing remote-MCP draft. Wait for the safety scan to pass, review the retained skill, and repeat the submission checks. Platform confirmation and publication remain user-controlled actions.

After Platform publication, install the exact published version in a clean profile, start a fresh task, connect through OAuth, and repeat the account-wide save/find/get/open acceptance above.

## npm CLI release

Run this section only for a CLI package change. Set a new `package.json` version before the dry run.

```bash
npm pack --dry-run --json
npm publish --dry-run --json
npm whoami
npm publish
npm view promptpie@<version> version
npm pack promptpie@<version> --dry-run --json
```

Install the exact registry package into an isolated prefix. Put its `node_modules/.bin` first on the acceptance task's `PATH`, resolve both `ppie` and `promptpie`, and verify `ppie --version --json` reports the released version.

Create and push the CLI release tag after registry and installed-package acceptance:

```bash
git tag v<version>
git push origin v<version>
```

Keep npm publication, CLI tags, production flags, OAuth configuration, and Platform confirmation outside plugin-only repository releases.
