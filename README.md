# jb

Isolated Playwright Chromium driven by Jev. A coding agent (or you) runs a
narrowly scoped browser goal; Jev chooses in-page actions. The default
provider is Vercel AI Gateway; set `provider` to `typesafe` to call TypeSafe's
System One API instead.

The repository is `jev-browser-skill`. The skill name is `jb-browser`. The
local command is `jb`.

Requires **Node.js 22.18.0 or newer** (type stripping). Node 24 works.
Earlier Node 22 releases do not provide `--experimental-strip-types`.

Distribute it as this GitHub clone: the `jb-browser` skill plus the `jb`
script. It is not an npm package. `package.json` is `private`; `npm publish`
is refused. `jev-browser` and `jb` on npm are unrelated. Clone this
repository, then `npm install` only to fetch dependencies.

## Install

```bash
git clone git@github.com:hqman/jev-browser-skill.git
cd jev-browser-skill
npm install
npx playwright install chromium
```

The skill is [`skills/jev-browser/SKILL.md`](skills/jev-browser/SKILL.md). Name:
`jb-browser`. `AGENTS.md` in this clone loads it. The script is `./bin/jb`, or
`skills/jev-browser/bin/jb` from any working directory (follow the symlink).
Do not copy the skill folder away from this clone. `.cursor/` and `.agents/`
are local only; they are not in the GitHub repo.

```bash
mkdir -p ~/.cursor/skills ~/.agents/skills
ln -s /absolute/path/to/jev-browser-skill/skills/jev-browser ~/.cursor/skills/jb-browser
ln -s /absolute/path/to/jev-browser-skill/skills/jev-browser ~/.agents/skills/jb-browser
```

Credentials: `~/.jb/config.json` (see `config.example.json`) or env.
`provider` is `gateway` (default) or `typesafe`. Gateway:
`AI_GATEWAY_API_KEY` / `gateway.apiKey`. TypeSafe: `TYPESAFE_API_KEY` /
`typesafe.apiKey`. Artifacts: `~/.jb/data`.

## Example

```bash
./bin/jb run --url https://example.com --goal "Find the More information link and open it. Stop when that page is visible." --max-steps 10
./bin/jb state
./bin/jb stop
./bin/jb shutdown
```

The daemon auto-starts on `run`. `stop` closes that session's browser and
leaves the daemon up. `shutdown` closes every session and the daemon.

## If the daemon will not start

jb does not delete a socket it did not bind. If startup says the socket is
already in use, read `~/.jb/jb.pid` (or `$JB_RUNTIME_DIR/jb.pid`). When that
process is still running, use it or `jb shutdown` it. When the process is
gone, remove `jb.sock` and `jb.pid` in that directory yourself, then start
again.

## Security

These are the boundaries in the current code. They are not a guarantee that
every sensitive action is blocked.

- API keys stay in the Node process (`AI_GATEWAY_API_KEY`, `TYPESAFE_API_KEY`, or `~/.jb/config.json`). They are sent to the model provider. They are not written into the Chromium page.
- Page text, field values, and recent action history are included in each model request.
- `allowedOrigins` blocks navigations outside the list in `~/.jb/config.json`. It does not block other network requests the page makes. The sample list allows every `http` and `https` origin.
- Password, file, and hidden inputs are omitted from the observation sent to the model. `jb actions` can still click and type on the page.
- A Jev run returns `needs_review` only when the model selects `REVIEW`. That is a model policy. It does not guarantee that login, payment, CAPTCHA, or other sensitive steps are intercepted.
- The prompt tells the model to treat page text as untrusted data. That is guidance to the model, not an enforcement layer.
- Video recording is on unless `recordVideo` is `false`. Files go under the configured output directory (`~/.jb/data` by default).
- Do not print keys from `~/.jb/config.json`.

## Origin

The original Cline plugin is
[cline/plugins `plugins/jev-browser`](https://github.com/cline/plugins/tree/main/plugins/jev-browser).

This repository is an independently maintained **standalone CLI** (`jb`)
derived from that plugin at commit
[`96bde661f630ec23c1ce0cd86a2361a9959ef65a`](https://github.com/cline/plugins/tree/96bde661f630ec23c1ce0cd86a2361a9959ef65a/plugins/jev-browser).
It is not a Cline plugin, not installed with `cline plugin install`, and not
affiliated with or endorsed by Cline. Differences (CLI/daemon, `needs_text` +
`jb reply`, optional TypeSafe provider) are listed in
[CHANGES.md](CHANGES.md). License status is in [NOTICE](NOTICE).

At that commit the `cline/plugins` root LICENSE is Apache-2.0, Copyright 2026
Cline Bot Inc., and `plugins/jev-browser/package.json` says MIT. This
repository does not treat that as a dual license and is not published to npm.
