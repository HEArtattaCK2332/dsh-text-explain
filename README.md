# dsh-text-explain

A DeepSeek Harness plugin that adds "AI 解释" and "追问" to the
conversation view. Select a passage, click a small floating button, and a popup
streams a concise AI explanation. The same popup supports multi-turn follow-up
questions about the explanation.

## What it does

- **语境理解**：划词时自动读取「这段话所在的那条完整消息」当背景，一并交给模型。
  同样一句「最后由它打款」，带语境就知道「它」指财务部门。
- **难度旋钮（讲给谁听）**：同一段话，四档切换——**小白 / 通识 / 专业 / 深研**，默认「小白」。
  在弹窗里点一下换个档位，它会**立刻用新档位重讲一遍**：同一句话，前一眼满是生活比方，
  后一眼全是工程术语。档位换过就记为默认，也能在设置里改。
- **新建为对话**：弹窗底部的 **✦ 新建为对话** 按钮，把这次问答（原文＋所在消息＋
  已进行的解释与追问）整理成一份自包含文档，注入一个新会话并自动跳过去，方便继续深入。
- **Markdown 渲染**：解释与回答按 Markdown 展示——标题、列表、引用、代码块、
  **表格**、链接等都能正确渲染（手写零依赖渲染器，React 元素构建，天然防 XSS）。
- **联网搜索**：开启「联网」后，模型可调用 `web_search`（走 Bing RSS 搜索）和
  `web_fetch`（抓取网页正文）来查最新信息。
- **读取本地文件**：开启「读文件」后，模型可调用 `search_files` 查找本地文档、
  `read_file` 读取本地文本文件。

## How it works

- **Host half** (`lib/index.js`) registers `POST /api/text-explain` on the
  web server. It reads the selected text and its optional `context` (the full
  message the selection came from), prepends the context to the first user
  message, runs it through the configured DeepSeek model
  (`deepseek-official` / `deepseek-v4-flash` by default), and streams token
  deltas back as `text/plain`.
  The request may carry a `level` (`plain` / `general` / `pro` / `expert`):
  the host keeps four 「读者 + 怎么讲」 prompt blocks and swaps them per request
  (the 「语境」/「格式」 sections are shared), so one code path serves all four
  depths. An unknown or missing `level` falls back to `plain` — never an error.
  It also registers `GET/POST /api/text-explain/settings`, backed by
  `<DSH_HOME>/text-explain/settings.json`: the GET never creates the file, and
  every field is sanitized on the way in, so a bad payload cannot poison the
  stored settings.
  When the client enables tools, the handler runs a **tool-call loop**: it
  passes `tools` to `llm.stream`, executes any requested tool
  (`web_search` / `web_fetch` / `search_files` / `read_file`), feeds the result
  back as a `tool` message, and repeats until the model finishes.
- **Client half** (`lib/client.js`) registers into `shell.overlay`, listens
  for text selections (capturing both the selection and the surrounding
  message), and renders the floating `AI 解释` / `追问` buttons plus a
  multi-turn explanation popup: a 「讲给谁听」 depth row, two toggles
  (「🌐 联网」「📄 读文件」) and the 「✦ 新建为对话」 action. The action uses the
  client `sessions` and `uiWorkspace` services: `uiWorkspace.startSession()` →
  `session.prompt()`. A settings page is registered into `settings.section`
  (「设置 → 划词解释」) with 常用/高级 groups and an explicit 保存 / 刷新 pair.

## Install

From a checkout of this package:

```sh
dsh plugin --profile web add file:<path-to-dsh-text-explain>
```

Then restart the Web profile so the new bundle layer is loaded.

## Usage

1. Select text in a conversation message. The popup automatically carries the
   message it came from as context.
2. Click **AI 解释** to explain it, or **追问** to ask a question about it.
3. Read the streamed answer. Type a follow-up question in the input box and
   press Enter to continue the same thread. Close the window with ✕.
4. Switch the depth — **讲给谁听**: 小白 / 通识 / 专业 / 深研 — at the bottom of
   the popup. Changing it re-explains the current question right away, and the
   new depth becomes your default.
5. To let the model search the web or read local files, toggle **🌐 联网** or
   **📄 读文件** at the bottom of the popup before asking.
6. When the thread is worth pursuing, click **✦ 新建为对话** — the whole
   exchange (original selection + source message + explanation + follow-ups)
   lands in a new session, which opens automatically.
7. Open **设置 → 划词解释** for the defaults: which workspace a new session lands
   in, the default depth, and (folded under 「高级设置」) whether 联网 / 读文件
   start on. Settings live in the host's own config file; edits wait in a draft
   until you press **保存**, and **刷新** throws the draft away and reloads what is
   actually stored. Nothing you did not save is ever written anywhere.

## Tests

三份「桩测试」随插件一起在仓库里，只依赖 Node 内置模块——不用装测试框架、不用 `npm install`：

```sh
node test/run-all.mjs        # 三份一起跑；也可单跑某一份
```

- `test/host.test.mjs` —— 拿假的 `llm` / `webServer` 真跑 HTTP 端点：
  四档必须产出四份**互不相同**的系统提示词；传了不认识的 `level` 必须回落 `plain`
  （而不是报错）；语境仍要注入首条消息；空选段要被拒。设置端点则验：
  没保存过时磁盘上不该有文件、脏数据会被洗净、非法 JSON 返回 400 且不动已存的那份。
  测试全程把设置写进临时目录，绝不碰真实的 `<DSH_HOME>`。
- `test/settings.test.mjs` —— 在 React / fetch 桩上真加载 `lib/client.js`：
  模块结构、两个插槽的注册、设置归一化、缓存读写、失败兜底，以及那条要紧的规矩——
  **只有「保存」会发 POST，读设置永远不落盘**。桩里的 `window` 故意不提供
  `localStorage`，用来保证浏览器存储真的退场了。
- `test/render.test.mjs` —— 在 React 桩上真渲染两个组件：设置页（收起态与展开态）
  与弹窗（含一段完整 Markdown 回答，顺便走一遍手写渲染器）。

## Design notes

- The selected text is sent to `deepseek-official` using
  `deepseek-v4-flash` by default (no separate API key is stored by this plugin).
- The plugin is intentionally dependency-free and hand-written: no build step
  is required.
- **语境** comes from the DOM: the client walks up from the selection anchor to
  the outermost ancestor that still fits the same message (capped at 4000
  characters). If that walk fails, the explanation still works — it just runs
  without context.
- **联网搜索** uses Bing's RSS endpoint (`format=rss`) — no API key needed, and
  it is reachable in networks where DuckDuckGo is not. `web_fetch` strips HTML
  to plain text; it works for static pages, but not JavaScript-rendered ones.
- **本地查找** 的 `search_files` 只返回文档文件（README / SKILL.md /
  package.json 等），并跳过 `undo`、`snapshots`、`logs` 这类运行数据目录。
- **读文件** is capped (refuses files over 512 KB, truncates returned text) and
  only reads; it never writes. Both toggles default to on; turn them off to
  save time and quota.
- **设置存在宿主侧**：`<DSH_HOME>/text-explain/settings.json`（由宿主半提供
  `GET/POST /api/text-explain/settings` 读写；DSH_HOME 缺省为 `~/.dsh`）。
  浏览器不再存任何设置。设置页保留一份**草稿**——**不点「保存」，磁盘上不会多一个字**；
  按 **保存** 才整份写进那个文件，按 **刷新** 则丢掉草稿、重新读一次。
  每项设置都对**下一次**解释或**下一次**新建生效，故保存动作不会打断你正在读的那段回答。
  弹窗里的档位切换只影响那一次，不进设置文件——想设为默认，到设置页选好再保存。
- **跨来源调用（留给浏览器扩展的那道门）**：端点在动手之前先看 `Origin`——没有 Origin、
  或与本机同源的，一切照旧；只有命中设置文件里 `allowedOrigins` 白名单的来源
  （形如 `chrome-extension://<扩展ID>`）才拿得到 CORS 头，别的来源**一律 403**，
  不给陌生网页烧你的额度。白名单默认为空数组，所以**默认行为与从前一模一样**。
  这是为 ② 浏览器扩展形态预留的通道，日常使用无需关心；要启用，在
  `settings.json` 里写 `"allowedOrigins": ["chrome-extension://你的扩展ID"]` 即可。
