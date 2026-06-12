# Releasing

GitHub pushes do not publish this package to npm. The workflow in `.github/workflows/test.yml` only runs tests.

Publish manually when you want `npm i -g promptpie` and `npx promptpie` users to receive a new version.

## Checklist

1. Confirm npm auth:

   ```bash
   npm whoami
   ```

2. Run the standalone test suite:

   ```bash
   npm test
   ```

3. Preview the npm tarball:

   ```bash
   npm pack --dry-run
   ```

   The package should contain `LICENSE`, `README.md`, `bin/`, `lib/`, and `package.json`.

4. Bump the version:

   ```bash
   npm version patch
   ```

   Use `minor` or `major` instead of `patch` when the change warrants it.

5. Publish:

   ```bash
   npm publish
   ```

6. Push the release commit and tag:

   ```bash
   git push --follow-tags
   ```

7. Verify npm:

   ```bash
   npm view promptpie name version description
   npx promptpie --version
   ```

## Notes

- npm requires every publish to use a new `package.json` version.
- Do not run `npm publish` from the old Prompt Pie app repo.
- Keep release changes in this standalone repository: `github.com/jeremyrojas/ppie-cli`.
