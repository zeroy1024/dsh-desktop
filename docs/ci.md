# Continuous integration

The repository CI is defined in `.github/workflows/ci.yml`. It is a
correctness gate for the pinned upstream patch queue and for the desktop
runtime on Linux, macOS, and Windows; release signing and installer publishing
do not run in pull requests. Unsigned installers and archives are built and
published by the separate `.github/workflows/release.yml` workflow; signing,
notarization, and automatic updates remain deferred.

## Toolchain

Every workflow step installs pnpm with `pnpm/action-setup` (pinned SHA, v6)
and no `version` input: the action defaults to the `packageManager` field of
the root `package.json` when it is present. The version therefore tracks the
root manifest (`packageManager: pnpm@11.24.0`) and is bumped there, not in the
workflows.

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
must not be copied from the Linux job to another operating system. The vendor
artifact uses a fixed per-run name (`dsh-vendor`) and is retained for 1 day —
long enough to retry failed platform jobs, short enough not to accumulate
gigabytes of identical tarballs. Failure diagnostics are retained for 3 days.

### `platform-check` (Linux, macOS, Windows)

Each runner downloads the upstream contract and then:

1. Installs `vendor/dsh-cli` on that platform using its frozen lockfile.
2. Installs the root workspace with its frozen lockfile.
3. Runs unit tests and builds the desktop shell and all bundled plugins.
4. Loads and exercises `node-pty`, `koffi`, and `sharp` from the installed dsh
   closure.
5. Starts the real dsh Web CLI with a temporary `DSH_HOME` and the desktop
   profile, so the app's bundled plugins are loaded by dsh itself. The staged
   plugin closure that the preceding `Build` step produced is materialized into
   the temporary home; the smoke waits for the loopback ready line, fetches the
   HTML shell, and stops the CLI. Running it locally therefore requires
   `pnpm build` first.
6. Installs the Electron binary, probes the patched `koffi.decode.string16`
   copy-based read inside a real `ELECTRON_RUN_AS_NODE` Electron process (V8
   Sandbox is force-enabled in every Electron process on every platform;
   fake-koffi unit tests cannot cover the real host), and launches the real
   unpackaged app. The startup smoke succeeds only after dsh is ready, the
   WebUI mounts, and the desktop preload/plugin platform markers agree with the
   host. Setting `DSH_DESKTOP_CI_SMOKE_STAGE=restart` also runs a restart phase:
   a second app launch, after first ready, triggers one real `restart-agent`
   (restart cooldown and self-heal budget same as production; new random port,
   pid record rewrite, renderer reload) and re-verifies the markers before
   exit. Linux configures the unpackaged `node_modules` Electron
   `chrome-sandbox` helper as `root:root` mode `4755` and runs under Xvfb; it
   does not weaken production behavior with `--no-sandbox`. The packaged
   distributables' SUID helper is asserted separately in the release workflow.

Lint and TypeScript checking run once on Linux because their results are not
OS-dependent. The matrix uses `fail-fast: false` so every platform reports its
result even if another platform fails.

### `packaged-smoke` (Linux, macOS, Windows)

The unpackaged app can pass while packaged resources or runtime extraction fail.
Each platform therefore builds and launches a native application directory in
ordinary CI, with `fail-fast: false`:

1. Downloads the upstream contract and installs platform-native dependencies.
2. Builds plugins and the desktop shell, then stages the runtime archive.
3. Linux uses `package:ci:linux` (`--linux dir tar.gz`); macOS and Windows use
   electron-builder `--dir --publish never`. CI disables signing discovery.
4. Runs `pnpm ci:smoke:packaged` against the release directory. Linux first
   configures the unpacked `chrome-sandbox` helper and launches under Xvfb.

Full installers and portable release archives are checked separately by the
release workflow. A directory-package smoke does not verify installer upgrades,
signing, or notarization.

### Coverage gate (Linux)

Unit tests are run by `platform-check`; the v8 coverage gate runs once on
Linux in the same job (`pnpm -r --if-present test:coverage`, i.e. the
`test:coverage` scripts of `@dsh-desktop/desktop` and
`@dsh-desktop/agent-host`). Thresholds live in each package's
`vitest.config.ts` (`coverage.thresholds`); see
[Local verification](#local-verification) for the exact commands.

### `CI Gate`

`CI Gate` is the stable aggregate check intended for branch protection. It
fails unless the upstream contract, the complete platform matrix, and the
packaged smoke all succeed. Requiring this single name avoids
branch-protection churn if matrix labels change.

## Local verification

With `vendor/dsh-cli` already generated:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build                 # stage:plugins 产出 ci:smoke:dsh 依赖的 staged 闭包
pnpm ci:probe-native
pnpm ci:smoke:dsh
pnpm --filter @dsh-desktop/desktop exec install-electron
pnpm ci:probe-electron-sandbox
pnpm ci:smoke:electron
DSH_DESKTOP_CI_SMOKE_STAGE=restart pnpm ci:smoke:electron   # 追加重启阶段（此开关当前未默认进 CI 工作流）
```

Coverage gate (what CI runs on Linux):

```bash
pnpm --filter @dsh-desktop/desktop test:coverage
pnpm --filter @dsh-desktop/agent-host test:coverage
```

Both commands run the plain unit tests and then enforce the v8 thresholds
configured in the package's `vitest.config.ts` (`coverage.include`,
`coverage.exclude`, `coverage.thresholds`). The desktop scope is
`src/main` + `src/preload` except `src/main/index.ts` (Electron entry,
untestable in plain Node — tracked as a TODO in the config); `agent-host`
covers all of `src`. v8's default output exclusions (`dist/`, `index.html`,
`.runtime-archive/`) apply automatically. Reports are written to `coverage/`
under each package (gitignored).

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
for 3 days.

## Security and reproducibility

- The workflow token has read-only repository permissions.
- Checkout credentials are not persisted.
- Pull requests use `pull_request`, never `pull_request_target`, and receive no
  signing or service secrets.
- Every Action is pinned to a full commit SHA; Dependabot groups all Action
  updates into one scheduled weekly pull request.
- pnpm stores are cached per OS, architecture, Node version, and all relevant
  lockfiles. `node_modules` and the platform-native vendor closure are not
  cached as cross-job artifacts. Vendor tarballs cross the job boundary as a
  1-day Actions artifact; diagnostic uploads expire after 3 days.
- Obsolete pull-request runs are cancelled; main and merge-queue runs finish.
- Every job has an explicit timeout and the matrix uses explicit runner images.

The separate `release.yml` workflow accepts version tags and manual dispatch,
builds all three platforms, validates assets, runs packaged smoke, and generates
SHA256SUMS before publishing a GitHub prerelease. Current artifacts are unsigned.
Future signing/notarization should validate the exact artifacts to be published
and keep release credentials outside pull-request jobs.

See the [documentation index](README.md) for architecture and plugin guides.
