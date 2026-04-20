# Publishing

How to cut a new dapp3 extension release and ship it to the Chrome Web Store.

## Cut a release

From `extension/`:

```bash
pnpm release:patch   # 1.0.0 → 1.0.1
pnpm release:minor   # 1.0.0 → 1.1.0
pnpm release:major   # 1.0.0 → 2.0.0
```

What this does:

1. Bumps `version` in `extension/package.json` (manifest picks it up automatically via `@crxjs/vite-plugin`).
2. Commits the bump from the repo root with message `chore: release v<version>`.
3. Tags `v<version>` and pushes `main` + tags to `origin`.

Requires a clean working tree. Aborts if uncommitted changes exist.

## GitHub release (automatic)

The tag push triggers `.github/workflows/release.yml`:

1. Installs deps with pnpm (Node version from `.nvmrc`).
2. Runs `pnpm zip` which builds into `extension/dist/` and packs `extension/zip/dapp3-v<version>.zip`.
3. Creates a GitHub release with auto-generated notes and the zip attached.

Watch the run under the repo's Actions tab. If it fails, fix and re-tag (`git tag -d v<version> && git push --delete origin v<version>`, then re-run the release script).

## Chrome Web Store upload

1. Download `dapp3-v<version>.zip` from the GitHub release page.
2. Go to the [CWS developer dashboard](https://chrome.google.com/webstore/devconsole).
3. Open the dapp3 item, upload the zip under Package, fill in any listing changes, submit for review.

The zip is already CWS-clean: no `key`, `update_url`, `_metadata/`, or `.pem`. No extra stripping needed.

## Local zip (no tag)

To produce a zip without cutting a release (e.g. to sanity-check before pushing a tag):

```bash
cd extension && pnpm zip
```

Output lands in `extension/zip/` (gitignored).
