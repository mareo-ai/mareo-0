# Mareo

Mareo is a thin macOS desktop host for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It packages the published DSH runtime without forking or patching its source, starts the local Web UI automatically, and displays it in a secured Electron window.

## V0 scope

- macOS arm64
- unsigned internal-test DMG
- pinned `@deepseek-ai/dsh` runtime
- pinned official Node.js runtime bundled inside the app
- isolated user data under `~/Library/Application Support/Mareo`

The current version intentionally excludes signing, notarization, automatic updates, Windows builds, tray behavior, deep DSH UI customization, and IPC transport.

## Development

Install the desktop build dependencies:

```sh
npm install
```

Run Mareo:

```sh
npm start
```

The staging step installs the locked DSH dependency tree and verifies both DSH and the bundled Node executable before Electron starts. The official Node archive is cached under `.cache/node` after its SHA-256 checksum matches the value pinned in `runtime/package.json`.

Useful checks:

```sh
npm run typecheck
npm test
npm run verify:runtime
npm run verify:brand
npm run server:test
```

## Package

Create the macOS arm64 application and DMG:

```sh
npm run make
npm run verify:package
```

Artifacts are written to:

```text
out/Mareo-darwin-arm64/Mareo.app
out/make/Mareo-0.1.0-arm64.dmg
```

The V0 DMG is unsigned and is intended only for internal testing.

The desktop brand is `Mareo`, with bundle ID `app.mareo.desktop`. The application and Dock use `assets/app-icon.png`: the original logo on a white rounded plate, with transparent margins and a subtle shadow. The startup page independently uses `assets/logo-white.png`, a white-background composite. Neither asset redraws the original `assets/logo.png`. When the original changes, run `python3 scripts/compose-app-icon.py` and `python3 scripts/flatten-logo.py` (requires Pillow), then commit the original and generated images. Normal development and packaging use the committed images and do not require Python. Forge generates the macOS application icon automatically using `sips` and `iconutil`. The existing `Mareo` user-data directory is retained so branding changes do not reset settings or conversations.

## DSH brand extension

`brand/` owns the `mareo-brand` plugin. Staging packages its browser factory and embedded original logo alongside the unmodified npm dependencies. The launcher writes an app-owned `mareo-brand.patch.json` under DSH home and passes it through the official `--patch` option. The overlay disables `ui-brand-official` and loads our package by its installed file URL, so moving the application does not break package resolution. It never overwrites the user's profile or settings.

The brand presentation uses `sidebar.brand.mark`, `sidebar.brand.name`, `conversation.hero.brand.mark`, and `shell.overlay`. The sidebar shows the Mareo logo and a single-line `Mareo` name; `Built on DeepSeek Harness` remains at the bottom right, outside the primary brand area. The default hero headline and Preview badge are retained. There is no DOM rewriting, global CSS override, source patch, or fork. Attribution follows the [official brand guidelines](https://github.com/deepseek-ai/deepseek-harness/blob/master/BRAND_GUIDELINES.md).

The same launcher overlay disables `ui-settings-models`, removing the Models settings page (API keys, endpoint URLs, and provider management) and its bundled welcome and API-key onboarding dialogs. The independent `ui-model-selection` plugin remains enabled for model selection in chat. This hides configuration entry points; it does not remove existing user configuration or restrict the model catalog to gateway-supported models.

Run `npm run verify:brand` after staging, or `node scripts/verify-brand.mjs "out/Mareo-darwin-arm64/Mareo.app/Contents/Resources"` after packaging. This boots an isolated temporary DSH home and checks authenticated loading and brand composition without an API key. Add `--serve` after the resources path to keep the test instance available for visual checks. When upgrading DSH, also verify sidebar folding, both themes, and attribution placement in the UI.

## Model access and account

End users never configure a DeepSeek API key. Mareo authenticates against the
Mareo gateway ([`server/README.md`](server/README.md)), stores the user's
gateway token with Electron `safeStorage` (encrypted into `account.dat` under
the app's user-data directory), and hands model credentials to DSH only as
launch environment variables when the runtime starts:

```text
DEEPSEEK_API_KEY = the user's gateway token
DEEPSEEK_BASE_URL = the gateway URL
```

DSH's DeepSeek adapter reads both from the launch environment, so the bundled
runtime and its UI stay untouched.

- An unauthenticated launch shows the sign-in screen (`assets/signin.html`),
  which accepts a gateway token pasted by the user; validation and storage
  happen in the Electron main process.
- Packaged builds talk to the production gateway at `https://api.svc.mareo.cn`;
  running from source (`npm start`) defaults to a local gateway at
  `http://127.0.0.1:3000`. The `MAREO_GATEWAY_URL` environment variable
  overrides either default (see the `GATEWAY_URL` constant in `src/account.ts`).
- The gateway (`server/`) proxies model traffic to DeepSeek with your own API
  key, enforces per-user daily limits, and records one usage row per request.
  Run it locally with `npm run server:start` (after filling `server/.env`) and
  issue a user token with `npm run server:issue-token -- <name>`.
- WeChat QR sign-in is designed for a later phase in
  [`server/docs/wechat-login-design.md`](server/docs/wechat-login-design.md);
  until its credentials exist, self-issued gateway tokens remain the only login.

## Runtime boundary

```text
Mareo Electron main process
    -> bundled official Node.js
        -> published @deepseek-ai/dsh CLI
            -> 127.0.0.1 on an OS-assigned port
                -> secured Mareo BrowserWindow
```

Model traffic leaves DSH as ordinary DeepSeek chat-completions requests against
`DEEPSEEK_BASE_URL`. In a normal run that endpoint is the Mareo gateway, which
authenticates the user's token and forwards each request to DeepSeek with your
API key; running the gateway pointed at `https://api.deepseek.com` is therefore
the only place the key lives. A DeepSeek key never reaches an end-user machine:
it is not stored, displayed, or shipped by Mareo.

The DSH launch token is used only for the local authenticated URL and is redacted from Mareo's runtime log. Mareo never runs `npx` or downloads DSH on an end user's machine.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the primary packaged runtimes.
