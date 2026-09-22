# Changes

This repository is derived from the Cline plugin `jev-browser` in
cline/plugins at commit `96bde661f630ec23c1ce0cd86a2361a9959ef65a`,
directory `plugins/jev-browser`. The comparison below is against that
tree. It is an inventory, not a license determination. See [NOTICE](NOTICE).

In-file modification notices are not in the copied sources yet. If
upstream confirms Apache-2.0, Apache License 2.0 section 4(b) still
requires a notice in each modified file. A central list does not
satisfy that requirement.

## Copied unchanged

- `src/actions.ts`
- `src/browser-setup.ts`
- `test/browser-setup.test.ts`

## Modified from that plugin

- `src/config.ts`
- `src/credentials.ts`
- `src/jev-browser.ts`
- `src/jev-model.ts`
- `src/jev-run.ts`
- `src/recording-overlay.ts`
- `src/runtime.ts`
- `src/stream.ts`
- `src/types.ts`
- `test/credentials.test.ts`
- `test/ipc.test.ts`
- `test/jev.test.ts`
- `test/navigation-observation.test.ts`
- `test/smoke-config.json`
- `package.json`
- `.gitignore`
- `README.md`
- `tsconfig.json`

## Added in this repository

- `bin/jb`
- `src/cli.ts`
- `src/ipc.ts`
- `src/server.ts`
- `src/daemon-identity.ts`
- `src/summary.ts`
- `skills/jev-browser/` (skill and launcher)
- `test/config.test.ts`
- `test/summary.test.ts`
- `test/daemon.test.ts`
- `test/offline-jev-fetch.mjs`
- `config.example.json`
- `NOTICE`
- `CHANGES.md`
- `LICENSE`
- `.github/workflows/ci.yml`
- `scripts/block-publish.mjs`

## Present upstream and not copied

- `index.ts` (Cline plugin entry)
- `test/plugin.test.ts`
- `cline-jev-browser.config.example.json`
- `bun.lock`

## Behavior that diverged

- jb is a standalone CLI and daemon (`bin/jb`), not a Cline plugin tool.
- `jb stop` closes one session. `jb shutdown` closes every session and
  the daemon.
- When Jev chooses a text field, the run returns `needs_text` and the
  host answers with `jb reply`. There is no second text model.
- An optional TypeSafe provider can choose actions.
- `textModel` and `JEV_TEXT_MODEL` were removed. The live credential
  field is `credentials.gatewayApiKey`; the JSON config key remains
  `gateway.apiKey`.
- Cline identifiers and prompts now say the host agent (or jb),
  including `__jbHost`, the overlay cursor id and attribute, and the
  live viewer title.
- The skill `skills/jev-browser/SKILL.md` (name `jb-browser`) and
  `demo/title.html` did not exist in that plugin directory.
