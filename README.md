# dsh-text-explain

[简体中文](README.zh.md) ｜ English

**Made for people who don't speak AI.** Select a passage in a DeepSeek Harness
conversation — a term, an error message, a wall of jargon — and get it explained
in plain words, right where you are reading.

> 🎬 **Demo (20 seconds):** select → explain → switch depth → hand off.
> Recording pending; the GIF will live at `assets/demo.gif` and appear here.

## Why this exists

AI output is full of words you are expected to already know. The usual advice is
"just ask the model" — but you have to know *what* to ask, and the answer often
comes back in the same jargon you were stuck on.

This plugin removes that step: **select the confusing part, click once, read the
plain-words version.** No prompt engineering, no second tab, no API key.

## Features

- **Context-aware.** When you select text, it also grabs the *whole message* the
  passage came from and hands both to the model. "It will transfer the funds at
  the end" is ambiguous — until the model can see that "it" means the finance
  department.
- **Depth knob (讲给谁听).** Four depths — **Plain / General / Pro / Expert**,
  defaulting to Plain. Switch one and it **re-explains the current question on
  the spot**: the same sentence goes from kitchen-table analogy to engineering
  vocabulary. A switch in the popup lasts that popup only; set a default in
  Settings and press Save.
- **Standby handoff (✦ New session).** The button packs the selection, its
  source message and everything already asked into a handoff document, drops it
  into a fresh session and jumps you there. **The new session answers with a
  single line — "背景已了解，等你开口" — and waits**: no summary, no
  questions, no expansion. You already had your explanation; the new session is
  for what comes next.
- **Markdown rendering.** Answers render with headings, lists, quotes, code
  blocks, **tables** and links — via a hand-written, dependency-free renderer
  built from React elements (so it is XSS-safe by construction).
- **Web search and local files (optional).** Two toggles let the model call
  `web_search` / `web_fetch` for current information, and `search_files` /
  `read_file` to look things up in your local docs.

## Install

```sh
dsh plugin --profile web add github:HEArtattaCK2332/dsh-text-explain
```

Then restart the Web profile so the new bundle layer is loaded.

<details>
<summary>From a local checkout instead</summary>

```sh
dsh plugin --profile web add file:<path-to-dsh-text-explain>
```

</details>

## Usage

1. **Select text** in any conversation message. The popup automatically carries
   that message along as context.
2. Click **AI 解释** to explain it, or **追问** to ask a question about it.
3. Read the streamed answer. Type a follow-up and press Enter to keep the same
   thread; close the window with ✕.
4. Switch depth with **讲给谁听** at the bottom of the popup. Changing it
   re-explains the current question immediately.
5. Toggle **🌐 联网** / **📄 读文件** before asking, if you want the model to
   search the web or read local files.
6. Click **✦ 新建为对话** when the thread is worth pursuing: the whole exchange
   lands in a new session as a **handoff**, which opens automatically and waits
   for you to speak.
7. Open **设置 → 划词解释** for defaults: which workspace a new session lands
   in, the default depth, and (under 高级设置) whether the two toggles start on.

## Settings

Settings live on the host, in `<DSH_HOME>/text-explain/settings.json`
(`DSH_HOME` defaults to `~/.dsh`). The settings page keeps a **draft**: every
click only edits that draft, **保存** writes the whole file, **刷新** throws the
draft away and re-reads what is stored. **Nothing you did not save is ever
written to disk** — not to the config file, not to browser storage (this plugin
stores nothing in the browser at all).

## Tests

Three stub-based self-check suites ship in the box. They need nothing but Node's
built-in modules — no test framework, no `npm install`:

```sh
node test/run-all.mjs         # all three; or run any single file
```

- `test/host.test.mjs` — drives the real HTTP endpoints against a fake
  `llm` / `webServer`: the four depths must produce four **different** system
  prompts; an unknown `level` must fall back to `plain` (never an error);
  context must still be injected; an empty selection must be rejected. It also
  checks the settings endpoint creates no file until you save, sanitizes dirty
  input, and leaves stored settings untouched on a bad payload. Everything is
  written to a temp `DSH_HOME`, never your real one.
- `test/settings.test.mjs` — loads `lib/client.js` against React / fetch stubs:
  module shape, slot registration, settings normalization, cache behaviour,
  failure fallbacks, and the rule that matters — **only Save issues a POST**.
  The `window` stub deliberately has no `localStorage`, proving browser storage
  is really gone.
- `test/render.test.mjs` — renders both components on a React stub: the settings
  page (loading / ready / error, collapsed and expanded) and the popup with a
  full Markdown answer, exercising the hand-written renderer.

## Design notes

- The selected text goes to `deepseek-official` / `deepseek-v4-flash` by
  default; no separate API key is stored by this plugin.
- Intentionally dependency-free and hand-written: **no build step**.
- **Host half** (`lib/index.js`) registers `POST /api/text-explain` and
  `GET/POST /api/text-explain/settings` as *exact* routes. The four depth
  prompts share one skeleton (「语境」/「格式」are common; only 「读者 + 怎么讲」
  differ), so a single code path serves all four.
- **Context** comes from the DOM: the client walks up from the selection anchor
  to the outermost ancestor that still fits the same message (capped at 4000
  characters). If that walk fails, the explanation still works — just without
  context.
- **Web search** uses Bing's RSS endpoint (`format=rss`) — no API key, and
  reachable on networks where DuckDuckGo is not. `web_fetch` strips HTML to
  plain text; it works for static pages, not JavaScript-rendered ones.
- **`search_files`** returns only document files (README / SKILL.md /
  package.json / …) and skips runtime directories such as `undo`, `snapshots`
  and `logs`. **`read_file`** refuses files over 512 KB, truncates long text,
  and never writes.
- **Cross-origin calls** (the door for a future browser extension): the endpoint
  inspects `Origin` first. No origin, or same-origin as the host, behaves
  exactly as before; only origins listed in the `allowedOrigins` allowlist get
  CORS headers, everything else gets a flat **403** — so a random web page
  cannot burn your quota. The allowlist defaults to an empty array, so **the
  default behaviour is unchanged**.

## License

MIT — see [LICENSE](LICENSE).
