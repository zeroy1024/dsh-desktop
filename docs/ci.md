# Continuous integration

The repository CI is defined in `.github/workflows/ci.yml`. It is a
correctness gate for the pinned upstream patch queue and for the desktop
runtime on Linux, macOS, and Windows; release signing and installer publishing
remain part of P4 and deliberately do not run in pull requests.

## Pipeline

### `workflow-lint` (Linux)

Runs the checksum-verified, version-pinned Actionlint module against every
workflow. It runs independently so workflow semantics report alongside the
upstream and platform results.

### `upstream-contract` (Linux)

1. Check out the repository and `upstream/` submodule.
2. Install only the root synchronization tools.
3. Run `pnpm sync:upstream` to apply registered patches, build upstream, pack
   the affected packages, and create the isolated `vendor/dsh-cli` closure.
4. Derive and run every upstream Vitest spec touched by `patches/*.patch`.
5. Reject upstream lockfile drift and registry-facing vendor lock drift. Local
   tarball integrity is excluded because generated source maps are not
   byte-reproducible, while registry identities and integrity remain pinned.
6. Upload only the platform-neutral tarballs and the three dsh CLI contract
   files. `node_modules` is never uploaded.

The artifact is intentionally small and platform-neutral. Native dependencies
must not be copied from the Linux job to another operating system.

### `platform-check` (Linux, macOS, Windows)

Each runner downloads the upstream contract and then:

1. Installs `vendor/dsh-cli` on that platform using its frozen lockfile.
2. Installs the root workspace with its frozen lockfile.
3. Runs unit tests and builds the desktop shell and all bundled plugins.
4. Loads and exercises `node-pty`, `koffi`, and `sharp` from the installed dsh
   closure.
5. Starts the real dsh Web CLI with a temporary `DSH_HOME`, waits for its
   loopback ready line, fetches the HTML shell, and stops it.
6. Installs the Electron binary and launches the real unpackaged app. The
   smoke succeeds only after dsh is ready, the WebUI mounts, and the desktop
   preload/plugin platform markers agree with the host. Linux configures the
   packaged Chromium SUID helper as `root:root` mode `4755` and runs under
   Xvfb; it does not weaken production behavior with `--no-sandbox`.

Lint and TypeScript checking run once on Linux because their results are not
OS-dependent. The matrix uses `fail-fast: false` so every platform reports its
result even if another platform fails.

### `CI Gate`

`CI Gate` is the stable aggregate check intended for branch protection. It
fails unless both the upstream contract and the complete platform matrix
succeed. Requiring this single name avoids branch-protection churn if matrix
labels change.

## Local verification

With `vendor/dsh-cli` already generated:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm ci:probe-native
pnpm ci:smoke:dsh
pnpm --filter @dsh-desktop/desktop exec install-electron
pnpm ci:smoke:electron
```

After changing `upstream/`, `patches/`, or `scripts/sync-upstream.ts`, also run:

```bash
pnpm sync:upstream
pnpm test:upstream-patches
```

`pnpm ci:verify-vendor-lock` is a post-commit/CI invariant: it compares the
generated registry contract with `HEAD`. It is therefore expected to report a
drift while a newly regenerated vendor lockfile is still uncommitted.

All smoke tests isolate `DSH_HOME` and require no model API key. Failures copy
available logs into `.ci-artifacts/`; GitHub retains the uploaded diagnostics
for a limited period.

## Security and reproducibility

- The workflow token has read-only repository permissions.
- Checkout credentials are not persisted.
- Pull requests use `pull_request`, never `pull_request_target`, and receive no
  signing or service secrets.
- Every Action is pinned to a full commit SHA; Dependabot groups all Action
  updates into one scheduled weekly pull request.
- pnpm stores are cached per OS, architecture, Node version, and all relevant
  lockfiles. `node_modules` and the platform-native vendor closure are not
  cached as cross-job artifacts.
- Obsolete pull-request runs are cancelled; main and merge-queue runs finish.
- Every job has an explicit timeout and the matrix uses explicit runner images.

When P4 packaging lands, signed macOS/Windows releases and Linux checksums must
live in a separate protected tag workflow. That workflow should smoke the
exact signed artifacts and publish them without rebuilding in the release job.
