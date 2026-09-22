# Changes

This distribution is a derivative work of the Cline plugin `jev-browser` in the
cline/plugins repository at commit `96bde66`. The original plugin is
Apache-2.0. The files below were modified after that plugin was copied into
this standalone tree, as required by Apache License 2.0 section 4(b).

What diverged from the plugin:

- jb is a standalone CLI and daemon (`./bin/jb`), not a Cline plugin tool.
- When Jev chooses a text field, the run returns `needs_text` and the host
  answers with `jb reply`. There is no second text model.
- An optional TypeSafe provider can choose actions.
- `textModel` and `JEV_TEXT_MODEL` were removed. The live credential field is
  `credentials.gatewayApiKey`; the JSON config key remains `gateway.apiKey`.
- Cline identifiers and prompts now say the host agent (or jb), including
  `__jbHost`, the overlay cursor id and attribute, and the live viewer title.
- This repo ships a single skill, `skills/jev-browser/SKILL.md`, named
  `jb-browser`.

Source files changed relative to the copied tree:

- `package.json` — license set to Apache-2.0
- `README.md` — repo-root install, `needs_text` / `jb reply`, origin
- `skills/jev-browser/SKILL.md` — skill name, `./bin/jb` paths, `needs_text` run rules
- `src/jev-model.ts` — prompt returns control to the host agent
- `src/jev-run.ts` — review and completion messages name the host agent
- `src/runtime.ts` — host-process comments, visible-window warning, `__jbHost`
- `src/server.ts` — `__jbHost`
- `src/stream.ts` — live viewer title
- `src/recording-overlay.ts` — jb-prefixed cursor id and overlay attribute
