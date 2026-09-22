# jb

Isolated Playwright Chromium driven by Jev. A coding agent (or you) runs a
narrowly scoped browser goal; Jev chooses in-page actions. The default
provider is Vercel AI Gateway; set `provider` to `typesafe` to call TypeSafe's
System One API instead.

Requires **Node 22+**.

Agent skill (give a site → generate `--goal` → run `./bin/jb`):
[`skills/jev-browser/SKILL.md`](skills/jev-browser/SKILL.md). The skill name is
`jb-browser`.

## Install

From this repo root:

```bash
npm install && npx playwright install chromium
```

Credentials live in `~/.jb/config.json` (see `config.example.json`) or env:

- `provider`: `"gateway"` (default) or `"typesafe"`; override with `JB_PROVIDER`
- Gateway: `AI_GATEWAY_API_KEY` or `gateway.apiKey`
- TypeSafe: `TYPESAFE_API_KEY` or `typesafe.apiKey` (optional `TYPESAFE_MODEL`, default `jev-latest`)

When Jev selects a text field, the run stops with `needs_text` and leaves the
browser open. Answer with the same session:

```bash
./bin/jb --session <id> reply --text "the value"
```

Do not stop the browser between that question and the reply. Config:
`~/.jb/config.json`. Artifacts: `~/.jb/data`.

## Example

```bash
./bin/jb run --url https://example.com --goal "Find the More information link and open it. Stop when that page is visible." --max-steps 10
./bin/jb state
./bin/jb stop
```

The daemon auto-starts. `./bin/jb stop` closes the browser and the daemon.

## Origin

This CLI is derived from the Cline plugin `jev-browser` in the
[cline/plugins](https://github.com/cline/plugins) repository. Attribution and
the upstream Apache-2.0 copyright are in [NOTICE](NOTICE). What changed is in
[CHANGES.md](CHANGES.md).
