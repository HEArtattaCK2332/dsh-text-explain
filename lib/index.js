import fs from 'node:fs/promises'
import path from 'node:path'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8'
}

/**
 * 讲解深度三档（难度旋钮）。
 *
 * `plain` 就是 ①-2 实测通过的「把人当完全不懂」的语气，也是默认档；
 * 其余两档只换【读者】【怎么讲】两段，【语境】【格式】三档共用（见 SHARED_PROMPT）。
 * 档位 id 与客户端设置里的 LEVEL_OPTIONS 一一对应，改一边就得改另一边。
 *
 * 2026-10-09 由四档并为三档：原「深研（expert）」与「专业（pro）」的听众几乎重合，
 * 摆四个档反而逼用户做无意义的区分；故把 expert 的要点（前提、边界、反例、分歧）
 * 并入 pro。旧设置文件里的 `expert` 由下方的 LEVEL_ALIASES 平滑落到 `pro`，不报错。
 */
const LEVELS = [
  {
    id: 'plain',
    label: '小白',
    maxTokens: 1024,
    reader: [
      '把读者当成完全不懂 AI、不懂代码、也没接触过这方面知识的人。他们看 AI 的输出一头雾水，',
      '来找你就是要一句「这到底在说什么」。宁可啰嗦，也不要漏掉他们不懂的地方。'
    ],
    rules: [
      '第一句先用大白话讲清「这段话在说什么事」——这一句里不要出现任何术语。',
      '碰到术语就当场用大白话解释「它是干嘛的」，绝不许术语套术语；能用生活里的例子打比方就一定打。',
      '先讲「是什么」，再补「有什么用 / 为什么重要」。',
      '不必求全；读者看不懂时，说得少反而比说得多好。'
    ]
  },
  {
    id: 'general',
    label: '通识',
    maxTokens: 1024,
    reader: [
      '把读者当成会用电脑、有常识、但没学过这一行的人——比如刚用上 AI 工具、想弄明白眼前这段话的新手。'
    ],
    rules: [
      '第一句先讲清「这段话在说什么事」，能不用术语就不用。',
      '术语第一次出现时顺手解释一句（紧随其后或放进括号），点到即止，不必展开成科普。',
      '先给结论，再交代为什么；顺序清楚比面面俱到要紧。',
      '关键处给一个例子帮读者建立直觉，例子要短。'
    ]
  },
  {
    id: 'pro',
    label: '专业',
    maxTokens: 1400,
    reader: [
      '把读者当成同行：熟悉技术，只是没看过这一段的具体语境，要快速搞清「这里到底在做什么、为什么这么做」，',
      '并拿到可据以判断的细节。'
    ],
    rules: [
      '术语直接用，基础概念不必解释。',
      '讲机制与取舍：它怎么做、代价是什么、什么情况下不适用。',
      '涉及代码或接口时，点明关键字段、函数与数据流向。',
      '写清结论成立的前提，以及已知的反例或例外；有争议处标明分歧在哪。',
      '不打比方、不铺垫，直给结论与要点；必要时给出可验证的检查点（看哪个文件、测哪个行为）。'
    ]
  }
]

/** 已合并/改名的档位：旧值一律平滑迁移，绝不因历史数据报错。 */
const LEVEL_ALIASES = { expert: 'pro' }

const DEFAULT_LEVEL = 'plain'

const SHARED_PROMPT = [
  '',
  '【语境】用户会先发来一段从对话中选中的文字，这段话可能附有它所在的那条完整消息作为语境；',
  '请结合语境理解选中的部分。随后用户可能继续追问；追问时结合原文、语境与已给出的解释，只答问的那部分。',
  '',
  '【格式】语言与选中文字保持一致（中文就用中文）；可用 Markdown 让内容更清楚；不要寒暄，直接输出内容。'
].join('\n')

function findLevel(id) {
  const key = typeof id === 'string' && Object.prototype.hasOwnProperty.call(LEVEL_ALIASES, id)
    ? LEVEL_ALIASES[id]
    : id
  for (const item of LEVELS) {
    if (item.id === key) return item
  }
  return null
}

/** 按档位拼系统提示词；档位不认识（或缺省）时按默认档来，绝不因参数写错而 500。 */
function buildSystemPrompt(levelId) {
  const level = findLevel(levelId) || findLevel(DEFAULT_LEVEL)
  return [
    '你是 DeepSeek Harness 的划词解释助手。',
    '',
    '【读者】' + level.reader.join('\n'),
    '',
    '【怎么讲】',
    level.rules.map((rule, index) => (index + 1) + '. ' + rule).join('\n'),
    SHARED_PROMPT
  ].join('\n')
}

const TOOLS_SYSTEM_PROMPT = [
  '',
  '你可以调用以下工具，并在需要时**自动**使用它们：',
  '- web_search：联网搜索最新或需要核实的信息。',
  '- web_fetch：抓取某个网页的正文全文。',
  '- search_files：在本地 skill、插件、项目目录里查找相关文档（README、SKILL.md、package.json 等）。',
  '- read_file：读取某个本地文本文件的内容。',
  '',
  '调用时机（重要，请自动判断、按需调用）：',
  '- 当仅凭你的知识无法可靠回答时——例如某个具体的开源项目、最新动态、冷门概念、不确定的细节——请主动联网搜索，不要凭空编造。',
  '- 当选中文字或追问提到某个本地 skill、插件、项目或文件名时，请先用 search_files 在本地查找相关文档，再用 read_file 读取内容来回答。',
  '- 如果 search_files 返回「未找到」、或本地文档不足以回答，请**转而用 web_search 联网搜索**，不要只回复「找不到」。',
  '- 能直接准确回答的普通问题，不要调用工具。',
  '',
  '技巧：search_files 优先用英文标识符（如 whale-persona、godot-bridge）作为关键词；它只返回文档文件路径，不会返回运行数据目录。',
  '拿到工具结果后请结合结果作答；若工具失败，如实说明并尝试换一种方式。'
].join('\n')

/**
 * 用户**主动**点了「联网搜索」或「本地搜索」时追加的一段。
 *
 * 时机是关键：这个按钮是「已经解释过一遍之后」才点的——用户想借工具挖得更透，
 * 不是想听同样的东西再讲一遍。所以这里明确要求：先动手查，然后**只补充新东西**。
 */
function forceToolPrompt(kind) {
  const isWeb = kind === 'web'
  const tool = isWeb ? 'web_search / web_fetch' : 'search_files / read_file'
  const where = isWeb ? '网络' : '本机文件'
  return [
    '',
    '【本轮是用户主动要求的补充检索】',
    '用户已经读过上一条解释了。他点了「' + (isWeb ? '联网搜索' : '本地搜索') + '」，希望你去' + where + '查证、补充。',
    '因此本轮你**必须**先用 ' + tool + ' 动手查一次，不要跳过这一步。',
    '查完之后：**不要复述上一条已经讲过的内容**，也不要重新把整段话解释一遍。',
    '只讲你**新查到的**东西：与上面说法一致的地方一句带过即可，重点放在更正、补充与新发现的细节上。',
    '如果查证后发现上一条说得不对，直接指出来，并说明依据来自哪里。'
  ].join('\n')
}


const EXPLAIN_PROVIDER = 'deepseek-official'
const EXPLAIN_MODEL = 'deepseek-v4-flash'

const MAX_TOOL_ROUNDS = 6
const MAX_FILE_BYTES = 512 * 1024
const MAX_FILE_TEXT = 24000
const MAX_FETCH_BYTES = 2 * 1024 * 1024
const MAX_FETCH_TEXT = 15000
const MAX_SEARCH_TEXT = 12000
const MAX_SEARCH_ITEMS = 5

const WEB_SEARCH_SCHEMA = {
  name: 'web_search',
  description: '联网搜索，获取最新或需要核实的信息（新闻、价格、事实、定义、人物、事件等）。返回相关条目的标题、链接和摘要。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词，尽量具体，例如「DeepSeek V4 发布日期」' }
    },
    required: ['query'],
    additionalProperties: false
  }
}

const WEB_FETCH_SCHEMA = {
  name: 'web_fetch',
  description: '抓取一个网页 URL 的正文内容。当 web_search 的摘要不够、需要读取某个具体页面的全文时使用。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整网页地址，以 http:// 或 https:// 开头' }
    },
    required: ['url'],
    additionalProperties: false
  }
}

const READ_FILE_SCHEMA = {
  name: 'read_file',
  description: '读取用户本地磁盘上的一个文本文件的内容。当用户要求查看、读取、总结某个本地文件时使用。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件的绝对路径（推荐）或相对路径，例如 D:\\notes\\a.md 或 ./README.md' }
    },
    required: ['path'],
    additionalProperties: false
  }
}

const SEARCH_FILES_SCHEMA = {
  name: 'search_files',
  description: '在本地 skill、插件、项目目录里查找与关键词相关的说明文档（README、SKILL.md、package.json、*.md 等）。当用户提到某个本地 skill、插件、项目或文件名时使用；若返回「未找到」则应改用 web_search 联网搜索。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '关键词，尽量用英文标识符（如 whale-persona、godot-bridge）' }
    },
    required: ['query'],
    additionalProperties: false
  }
}

function sendJson(res, status, payload, extraHeaders) {
  if (res.headersSent) return
  res.writeHead(status, extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS)
  res.end(JSON.stringify(payload))
}

/**
 * 判断这次请求的来源放不放行，以及要不要回 CORS 头。
 *
 * - 没有 Origin（curl、本机程序、扩展的 service worker 也可能不带）：放行，不回 CORS 头——与从前完全一致。
 * - Origin 与请求的 Host 同源：放行，不回 CORS 头（同源本就不需要）。
 * - Origin 命中设置里的 `allowedOrigins` 白名单（例如浏览器扩展的 `chrome-extension://…`）：
 *   放行，并回 CORS 头——扩展这才读得到流式回答。
 * - 其余一律拒绝：那是别的网页、别的来源，不该替它们烧本插件的额度。
 */
function requestOrigin(req, allowedOrigins) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
  if (origin.length === 0) return { allowed: true, corsOrigin: null }
  let originHost = ''
  try {
    originHost = new URL(origin).host
  } catch (_error) {
    return { allowed: false, corsOrigin: null }
  }
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  if (host.length > 0 && originHost === host) return { allowed: true, corsOrigin: null }
  if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) {
    return { allowed: true, corsOrigin: origin }
  }
  return { allowed: false, corsOrigin: null }
}

// ---- 对外 API：OpenAI 兼容层 ----
//
// 为什么要有它：DSH 里划词、浏览器扩展划词、Obsidian 插件划词——要的是**同一件事**
// （选中文字 → 大白话解释）。与其为每个壳写一套后端，不如把能力包成 OpenAI 兼容格式，
// 任何支持「自定义接口地址」的现成客户端都能直接接上。
//
// 路径刻意带 `/api/text-explain` 前缀（而不是裸的 `/v1`）：
// 一来不与别的插件抢 `/v1`，二来用户填 base URL 时一眼看得出是谁在提供。

const OPENAI_MODEL_PREFIX = 'text-explain-'

/** 把 model 名映射到讲解档位；认不出来就回默认档（宽容，不报错）。 */
function levelForModel(name) {
  const raw = typeof name === 'string' ? name : ''
  const tail = raw.startsWith(OPENAI_MODEL_PREFIX) ? raw.slice(OPENAI_MODEL_PREFIX.length) : ''
  return findLevel(tail) || findLevel(DEFAULT_LEVEL)
}

/** OpenAI 的 content 可以是字符串，也可以是分段数组——一律压成一段纯文本。 */
function flattenContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const piece of content) {
    if (piece === null || typeof piece !== 'object') continue
    if (piece.type === 'text' && typeof piece.text === 'string') parts.push(piece.text)
  }
  return parts.join('\n')
}

/** OpenAI 风格的错误体（很多客户端只认这个形状）。 */
function sendOpenAiError(res, status, message, extraHeaders) {
  sendJson(res, status, {
    error: { message, type: 'invalid_request_error', param: null, code: null }
  }, extraHeaders)
}

function corsHeadersFor(origin) {
  return origin.corsOrigin === null
    ? null
    : { 'Access-Control-Allow-Origin': origin.corsOrigin, Vary: 'Origin' }
}

/** 读一个 JSON 请求体；出错时返回 { error, status }，调用方照原样回给客户端。 */
async function readJsonBody(req, limit = 20000) {
  let raw = ''
  try {
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > limit) return { error: 'payload too large', status: 413 }
    }
  } catch (_error) {
    return { error: 'failed to read request body', status: 400 }
  }
  try {
    return { value: raw.length === 0 ? {} : JSON.parse(raw) }
  } catch (_error) {
    return { error: 'invalid JSON body', status: 400 }
  }
}

// ---- 插件设置：落在宿主侧的配置文件里 ----
//
// 位置：<DSH_HOME>/text-explain/settings.json（DSH_HOME 缺省为 ~/.dsh）。
// 规矩：**只有客户端点了「保存」才会走到这里的写入**——界面上的每一次点选都只活在
// 浏览器内存里；不点保存，磁盘上不会多一个字。读不到、读坏了，一律回到默认值，
// 插件照常能用。

const SETTINGS_DIR_NAME = 'text-explain'
const SETTINGS_FILE_NAME = 'settings.json'

const DEFAULT_SETTINGS = {
  newSessionTarget: 'same-workspace',
  explainLevel: 'plain',
  webDefault: true,
  fileDefault: true,
  advancedVisible: false,
  // 允许跨源调用本插件的来源白名单（给浏览器扩展用）。
  // 默认空 = 任何跨来源请求一律拒绝，行为与从前完全一致。
  allowedOrigins: []
}

/**
 * 什么样的来源算「像样」：
 * - `http(s)://host`：网页、本机开发页、别的服务
 * - `chrome-extension://<32位ID>`：浏览器扩展
 * - `app://host`：**Electron 应用**——Obsidian 桌面版正是 `app://obsidian.md`
 *   （实测踩出来的：旧规则不收 `app://`，于是「想加白名单也加不进去」，
 *    Obsidian 的请求一律被 403 挡在门外）
 */
function isAcceptableOrigin(value) {
  return /^https?:\/\/[^\s/]+$/i.test(value) ||
    /^chrome-extension:\/\/[a-p]{32}$/i.test(value) ||
    /^app:\/\/[^\s/]+$/i.test(value)
}

/** 只留上面三种来源，去重、限长。 */
function sanitizeOrigins(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const result = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim().replace(/\/+$/, '')
    if (!isAcceptableOrigin(value)) continue
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
    if (result.length >= 20) break
  }
  return result
}

/** 把任意来源的数据洗成一份字段齐全、取值合法的设置。 */
function sanitizeSettings(raw) {
  const result = { ...DEFAULT_SETTINGS }
  if (raw === null || typeof raw !== 'object') return result
  if (raw.newSessionTarget === 'ungrouped' || raw.newSessionTarget === 'same-workspace') {
    result.newSessionTarget = raw.newSessionTarget
  }
  if (typeof raw.explainLevel === 'string') {
    // 注意：落盘要写 findLevel 返回的**规范 id**，不能照抄原值——
    // 否则四档时代的 `expert` 只是「通过校验」，却仍以旧名存回去，永远迁移不掉。
    const resolvedLevel = findLevel(raw.explainLevel)
    if (resolvedLevel !== null) result.explainLevel = resolvedLevel.id
  }
  if (typeof raw.webDefault === 'boolean') result.webDefault = raw.webDefault
  if (typeof raw.fileDefault === 'boolean') result.fileDefault = raw.fileDefault
  if (typeof raw.advancedVisible === 'boolean') result.advancedVisible = raw.advancedVisible
  if (raw.allowedOrigins !== undefined) result.allowedOrigins = sanitizeOrigins(raw.allowedOrigins)
  return result
}

function settingsFilePath() {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
  return path.join(home, SETTINGS_DIR_NAME, SETTINGS_FILE_NAME)
}

async function readSettingsFile() {
  try {
    const content = await fs.readFile(settingsFilePath(), 'utf8')
    return sanitizeSettings(JSON.parse(content))
  } catch (_error) {
    // 文件还没有、内容坏了、读不动——都回到默认值
    return sanitizeSettings(null)
  }
}

// 写入串行化：两个请求同时保存时，后一份不会与前一份交错写同一个文件
let settingsWriteChain = Promise.resolve()

function writeSettingsFile(next) {
  const run = async () => {
    const file = settingsFilePath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const text = JSON.stringify(next, null, 2) + '\n'
    const temp = file + '.tmp'
    try {
      // 先写临时文件再改名：中途掉电也不会留下半份设置
      await fs.writeFile(temp, text, 'utf8')
      await fs.rename(temp, file)
    } catch (_error) {
      await fs.writeFile(file, text, 'utf8')
    }
    return next
  }
  const queued = settingsWriteChain.then(run, run)
  settingsWriteChain = queued.then(() => {}, () => {})
  return queued
}

function chatMessage(role, text) {
  return {
    role,
    content: [{ type: 'text', text }],
    source: role === 'user'
      ? { kind: 'user' }
      : { kind: 'model', provider: EXPLAIN_PROVIDER, model: EXPLAIN_MODEL }
  }
}

async function resolveModel(llm) {
  try {
    const providers = llm.listProviders()
    if (providers.some((entry) => entry.id === EXPLAIN_PROVIDER)) {
      return { provider: EXPLAIN_PROVIDER, model: EXPLAIN_MODEL }
    }
    const provider = providers[0] && providers[0].id
    if (provider === undefined) return null
    const models = await llm.listModels(provider)
    const model = models[0] && models[0].id
    if (model === undefined) return null
    return { provider, model }
  } catch (_error) {
    return null
  }
}

function toolSchemas(enabled) {
  const list = []
  if (enabled.web) list.push(WEB_SEARCH_SCHEMA, WEB_FETCH_SCHEMA)
  if (enabled.file) list.push(SEARCH_FILES_SCHEMA, READ_FILE_SCHEMA)
  return list
}

// ---- 工具实现 ----

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

function errorText(context, err) {
  const message = err && err.message ? err.message : String(err)
  return `${context}：${message}`
}

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function matchTag(block, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i')
  const m = block.match(re)
  return m ? m[1].trim() : ''
}

function parseBingRss(xml) {
  const items = []
  const re = /<item>([\s\S]*?)<\/item>/gi
  let m
  while ((m = re.exec(xml)) !== null) {
    const block = m[1]
    const title = decodeEntities(matchTag(block, 'title'))
    const link = decodeEntities(matchTag(block, 'link'))
    const desc = stripHtml(decodeEntities(matchTag(block, 'description')))
    const date = decodeEntities(matchTag(block, 'pubDate'))
    if (title && link) items.push({ title, link, desc, date })
  }
  return items
}

async function execWebSearch(args) {
  const query = String(args && args.query ? args.query : '').trim().slice(0, 300)
  if (!query) return { text: '搜索关键词为空', error: true }
  try {
    const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) +
      '&format=rss&count=10&setlang=zh-CN'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    })
    clearTimeout(timer)
    if (!resp.ok) return { text: `搜索请求失败（HTTP ${resp.status}）`, error: true }
    const xml = await resp.text()
    const items = parseBingRss(xml).slice(0, MAX_SEARCH_ITEMS)
    if (items.length === 0) {
      return {
        text: `Bing 未返回「${query}」的相关结果。可以换一个更具体的关键词，或用 web_fetch 抓取具体网页。`,
        error: false
      }
    }
    const parts = items.map(function (item, index) {
      const desc = item.desc ? '\n   ' + item.desc : ''
      return (index + 1) + '. ' + item.title + desc + '\n   ' + item.link
    })
    return { text: parts.join('\n').slice(0, MAX_SEARCH_TEXT), error: false }
  } catch (err) {
    return { text: errorText('联网搜索失败', err), error: true }
  }
}

async function execWebFetch(args) {
  const url = String(args && args.url ? args.url : '').trim()
  if (!/^https?:\/\//i.test(url)) return { text: '无效的网址，请以 http:// 或 https:// 开头', error: true }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; dsh-text-explain/0.2)' }
    })
    clearTimeout(timer)
    if (!resp.ok) return { text: `抓取失败（HTTP ${resp.status}）`, error: true }
    const declared = Number(resp.headers.get('content-length') || 0)
    if (declared > MAX_FETCH_BYTES) return { text: '网页过大，已拒绝抓取', error: true }
    const buf = await resp.arrayBuffer()
    if (buf.byteLength > MAX_FETCH_BYTES) return { text: '网页过大，已拒绝抓取', error: true }
    const text = stripHtml(Buffer.from(buf).toString('utf8'))
    if (!text) return { text: '未抓取到正文内容（可能是图片或脚本页面）', error: true }
    return { text: text.slice(0, MAX_FETCH_TEXT), error: false }
  } catch (err) {
    return { text: errorText('抓取网页失败', err), error: true }
  }
}

async function execReadFile(args) {
  const raw = String(args && args.path ? args.path : '').trim()
  if (!raw) return { text: '文件路径为空', error: true }
  try {
    const abs = path.resolve(raw)
    const stat = await fs.stat(abs)
    if (!stat.isFile()) return { text: `「${abs}」不是文件`, error: true }
    if (stat.size > MAX_FILE_BYTES) {
      return { text: `文件过大（${stat.size} 字节，上限 ${MAX_FILE_BYTES} 字节），已拒绝读取`, error: true }
    }
    const content = await fs.readFile(abs, 'utf8')
    const trimmed = content.slice(0, MAX_FILE_TEXT)
    const suffix = content.length > MAX_FILE_TEXT ? '\n\n[内容过长，已截断]' : ''
    return { text: trimmed + suffix, error: false }
  } catch (err) {
    return { text: errorText('读取文件失败', err), error: true }
  }
}

const MAX_SEARCH_RESULTS = 20
const MAX_SEARCH_DEPTH = 4
const EXTRA_SEARCH_ROOTS = ['E:\\DSH-cj', 'E:\\DSH']

async function searchRoots() {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
  const roots = [path.join(home, 'skills'), path.join(home, 'plugins')]
  for (const root of EXTRA_SEARCH_ROOTS) {
    try {
      const st = await fs.stat(root)
      if (st.isDirectory()) roots.push(root)
    } catch (_error) {
      // 目录不存在则跳过
    }
  }
  return roots
}

const DOC_FILE_RE = /\.(md|markdown|txt|json|ya?ml|toml|js|ts|py|sh|css|html)$/i
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'cache', 'logs', 'temp', 'tmp', 'snapshots', 'blobs', 'sessions', 'undo', 'undo-snapshots', 'storages', 'attachments'])

function isDocFileName(name) {
  const lower = name.toLowerCase()
  return lower === 'readme.md' || lower === 'readme' || lower === 'skill.md' || lower === 'skill' || lower === 'package.json' || DOC_FILE_RE.test(name)
}

async function collectDocFiles(dir, results, depth) {
  if (results.length >= MAX_SEARCH_RESULTS || depth > 3) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (_error) {
    return
  }
  for (const entry of entries) {
    if (results.length >= MAX_SEARCH_RESULTS) return
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
      await collectDocFiles(path.join(dir, entry.name), results, depth + 1)
    } else if (isDocFileName(entry.name)) {
      results.push(path.join(dir, entry.name))
    }
  }
}

async function findDocs(dir, query, results, depth) {
  if (results.length >= MAX_SEARCH_RESULTS || depth > MAX_SEARCH_DEPTH) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (_error) {
    return
  }
  for (const entry of entries) {
    if (results.length >= MAX_SEARCH_RESULTS) return
    const name = entry.name
    if (entry.isDirectory()) {
      const lower = name.toLowerCase()
      if (SKIP_DIRS.has(lower)) continue
      if (lower.includes(query)) {
        await collectDocFiles(path.join(dir, name), results, 0)
      }
      await findDocs(path.join(dir, name), query, results, depth + 1)
    } else if (isDocFileName(name) && name.toLowerCase().includes(query)) {
      results.push(path.join(dir, name))
    }
  }
}

async function execSearchFiles(args) {
  const query = String(args && args.query ? args.query : '').trim().toLowerCase()
  if (!query) return { text: '搜索关键词为空', error: true }
  try {
    const roots = await searchRoots()
    const results = []
    for (const root of roots) {
      await findDocs(root, query, results, 0)
      if (results.length >= MAX_SEARCH_RESULTS) break
    }
    if (results.length === 0) {
      return { text: '本地没有找到「' + query + '」相关的 skill / 插件文档。请改用 web_search 联网搜索。', error: false }
    }
    return { text: '找到以下相关文档：\n' + results.join('\n'), error: false }
  } catch (err) {
    return { text: errorText('搜索本地文件失败', err), error: true }
  }
}

const TOOL_EXECUTORS = {
  web_search: execWebSearch,
  web_fetch: execWebFetch,
  search_files: execSearchFiles,
  read_file: execReadFile
}

function toolLabel(name, argumentsJson) {
  try {
    const o = JSON.parse(argumentsJson)
    if (name === 'web_search') return '正在联网搜索：' + (o.query || '')
    if (name === 'web_fetch') return '正在抓取网页：' + (o.url || '')
    if (name === 'search_files') return '正在查找本地文件：' + (o.query || '')
    if (name === 'read_file') return '正在读取文件：' + (o.path || '')
  } catch (_error) {
    // 参数不是合法 JSON 时退化为通用标签
  }
  return '正在调用工具：' + name
}

async function executeTool(name, argumentsJson) {
  const exec = TOOL_EXECUTORS[name]
  if (!exec) return { text: '未知工具：' + name, error: true }
  let args
  try {
    args = JSON.parse(argumentsJson)
  } catch (_error) {
    return { text: '工具参数不是有效 JSON', error: true }
  }
  return exec(args)
}

export const name = 'text-explain'
export const inject = ['webServer', 'llm']

export function apply(ctx) {
  const llm = ctx.llm
  const webServer = ctx.webServer

  /**
   * 设置端点：GET 读当前设置，POST 保存一份。
   * 这是**唯一**会碰设置文件的入口——「不点保存就不记录」这条规矩由它守。
   */
  const settingsHandler = async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, await readSettingsFile())
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    const body = await readJsonBody(req)
    if (body.error !== undefined) {
      sendJson(res, body.status, { error: body.error })
      return
    }
    try {
      const next = sanitizeSettings(body.value)
      await writeSettingsFile(next)
      sendJson(res, 200, next)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 500, { error: 'failed to save settings: ' + message })
    }
  }

  /**
   * OpenAI 兼容层：`GET /v1/models` ＋ `POST /v1/chat/completions`（支持 SSE 流式）。
   *
   * 给谁用：Obsidian 插件、浏览器扩展，以及任何支持「自定义 OpenAI 接口地址」的客户端。
   * 档位用 model 名区分（`text-explain-plain` / `-general` / `-pro` / `-expert`）。
   * 讲解风格以本插件为准，**调用方传入的 system 会被忽略**——否则第三方的人设会把
   * 「说人话」这个前提冲掉。工具调用暂不支持（本层只做纯文本解释）。
   */
  const openaiHandler = async (req, res) => {
    const prefs = await readSettingsFile()
    const origin = requestOrigin(req, prefs.allowedOrigins)
    const corsHeaders = corsHeadersFor(origin)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders === null
        ? { 'Cache-Control': 'no-store' }
        : {
            'Access-Control-Allow-Origin': origin.corsOrigin,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Max-Age': '600',
            Vary: 'Origin',
            'Cache-Control': 'no-store'
          })
      res.end()
      return
    }

    if (origin.allowed !== true) {
      sendOpenAiError(res, 403, 'origin not allowed')
      return
    }

    const pathname = (req.url || '').split('?')[0]
    const created = Math.floor(Date.now() / 1000)

    if (pathname.endsWith('/models')) {
      if (req.method !== 'GET') {
        sendOpenAiError(res, 405, 'method not allowed', corsHeaders)
        return
      }
      sendJson(res, 200, {
        object: 'list',
        data: LEVELS.map((item) => ({
          id: OPENAI_MODEL_PREFIX + item.id,
          object: 'model',
          created,
          owned_by: 'dsh-text-explain'
        }))
      }, corsHeaders)
      return
    }

    if (req.method !== 'POST') {
      sendOpenAiError(res, 405, 'method not allowed', corsHeaders)
      return
    }

    const body = await readJsonBody(req, 200000)
    if (body.error !== undefined) {
      sendOpenAiError(res, body.status, body.error, corsHeaders)
      return
    }
    const payload = body.value
    if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.messages)) {
      sendOpenAiError(res, 400, 'messages array is required', corsHeaders)
      return
    }

    const level = levelForModel(payload.model)
    const currentMessages = []
    let totalChars = 0
    for (const item of payload.messages) {
      if (item === null || typeof item !== 'object') continue
      if (item.role === 'system' || item.role === 'developer') continue // 见上：讲解风格以本插件为准
      const role = item.role === 'assistant' ? 'assistant' : 'user'
      const text = flattenContent(item.content).trim()
      if (text.length === 0) continue
      totalChars += text.length
      if (totalChars > 50000) {
        sendOpenAiError(res, 413, 'conversation is too large', corsHeaders)
        return
      }
      currentMessages.push(chatMessage(role, text))
    }
    if (currentMessages.length === 0) {
      sendOpenAiError(res, 400, 'messages must contain at least one non-empty text part', corsHeaders)
      return
    }

    const selection = await resolveModel(llm)
    if (selection === null) {
      sendOpenAiError(res, 503, 'no model is available', corsHeaders)
      return
    }
    const { provider, model } = selection
    const system = buildSystemPrompt(level.id)
    const temperature = typeof payload.temperature === 'number' && payload.temperature >= 0 && payload.temperature <= 2
      ? payload.temperature
      : 0.3
    const maxTokens = typeof payload.max_tokens === 'number' && payload.max_tokens > 0
      ? Math.min(Math.floor(payload.max_tokens), 4096)
      : level.maxTokens
    const options = {
      provider,
      model,
      messages: currentMessages,
      system,
      temperature,
      maxTokens,
      ...(provider === EXPLAIN_PROVIDER ? { reasoningEffort: 'off' } : {})
    }
    const id = 'chatcmpl-' + Math.random().toString(36).slice(2, 12)
    const responseModel = typeof payload.model === 'string' && payload.model.length > 0
      ? payload.model
      : OPENAI_MODEL_PREFIX + level.id

    // ---- 流式 ----
    if (payload.stream === true) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(corsHeaders === null ? {} : corsHeaders)
      })
      const sendChunk = (delta, finishReason) => {
        res.write('data: ' + JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: responseModel,
          choices: [{ index: 0, delta, finish_reason: finishReason }]
        }) + '\n\n')
      }
      try {
        for await (const chunk of llm.stream(options)) {
          if (chunk.type !== 'text-delta' || typeof chunk.text !== 'string' || chunk.text.length === 0) continue
          sendChunk({ content: chunk.text }, null)
        }
        sendChunk({}, 'stop')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        res.write('data: ' + JSON.stringify({ error: { message, type: 'server_error' } }) + '\n\n')
      } finally {
        res.write('data: [DONE]\n\n')
        res.end()
      }
      return
    }

    // ---- 非流式 ----
    let text = ''
    try {
      for await (const chunk of llm.stream(options)) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendOpenAiError(res, 502, 'upstream failed: ' + message, corsHeaders)
      return
    }
    // 没有精确的分词统计，给个粗估——很多客户端只要求这个字段存在
    const promptTokens = Math.ceil((system.length + totalChars) / 4)
    const completionTokens = Math.ceil(text.length / 4)
    sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model: responseModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      }
    }, corsHeaders)
  }

  const handler = async (req, res) => {
    // 来源检查：白名单来自设置文件（默认空数组），故默认行为与从前一模一样。
    const prefs = await readSettingsFile()
    const origin = requestOrigin(req, prefs.allowedOrigins)
    const corsHeaders = origin.corsOrigin === null
      ? null
      : { 'Access-Control-Allow-Origin': origin.corsOrigin, Vary: 'Origin' }
    const respond = (status, payload) => sendJson(res, status, payload, corsHeaders)

    // 预检：只有白名单来源才拿得到放行头，其余空手而回（浏览器自会把它拦下）
    if (req.method === 'OPTIONS') {
      const headers = corsHeaders === null
        ? { 'Cache-Control': 'no-store' }
        : {
            'Access-Control-Allow-Origin': origin.corsOrigin,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Max-Age': '600',
            Vary: 'Origin',
            'Cache-Control': 'no-store'
          }
      res.writeHead(204, headers)
      res.end()
      return
    }

    if (origin.allowed !== true) {
      sendJson(res, 403, { error: 'origin not allowed' })
      return
    }

    if (req.method !== 'POST') {
      respond(405, { error: 'method not allowed' })
      return
    }

    let raw = ''
    try {
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > 120000) {
          respond(413, { error: 'payload too large' })
          return
        }
      }
    } catch (_error) {
      respond(400, { error: 'failed to read request body' })
      return
    }

    let payload
    try {
      payload = raw.length === 0 ? {} : JSON.parse(raw)
    } catch (_error) {
      respond(400, { error: 'invalid JSON body' })
      return
    }

    let rawMessages
    if (payload !== null && typeof payload === 'object' && Array.isArray(payload.messages)) {
      rawMessages = payload.messages
    } else if (payload !== null && typeof payload === 'object' && typeof payload.text === 'string') {
      rawMessages = [{ role: 'user', text: payload.text }]
    } else {
      respond(400, { error: 'messages array or text is required' })
      return
    }

    const payloadObject = payload !== null && typeof payload === 'object' ? payload : null
    // 工具给不给：请求里明确说了就听请求的；没说就按设置里的默认值（默认都开）。
    // 于是「模型自主判断要不要用工具」成为常态——它拿到工具，但用不用由它自己决定。
    const enableWeb = payloadObject !== null && typeof payloadObject.enableWeb === 'boolean'
      ? payloadObject.enableWeb
      : prefs.webDefault !== false
    const enableFile = payloadObject !== null && typeof payloadObject.enableFile === 'boolean'
      ? payloadObject.enableFile
      : prefs.fileDefault !== false
    // 强制触发：用户点了「联网搜索」或「本地搜索」——即便模型本不想用，也必须用一次
    const forceTool = payloadObject !== null &&
      (payloadObject.forceTool === 'web' || payloadObject.forceTool === 'file')
      ? payloadObject.forceTool
      : null
    // 讲解深度档位（难度旋钮）；没传或传了认不出的值，一律按默认档。
    const level = findLevel(payload !== null && typeof payload === 'object' ? payload.level : undefined) ||
      findLevel(DEFAULT_LEVEL)
    const tools = toolSchemas({
      web: enableWeb || forceTool === 'web',
      file: enableFile || forceTool === 'file'
    })
    // 划词所在的那条完整消息，作为理解选段的语境（前端最多给 4000 字）
    const context = payload !== null && typeof payload === 'object' && typeof payload.context === 'string'
      ? payload.context.trim().slice(0, 6000)
      : ''

    if (rawMessages.length === 0 || rawMessages.length > 50) {
      respond(400, { error: 'messages must contain between 1 and 50 entries' })
      return
    }

    const messages = []
    let totalChars = 0
    let contextApplied = false
    for (const item of rawMessages) {
      if (item === null || typeof item !== 'object') {
        respond(400, { error: 'each message must be an object' })
        return
      }
      if (item.role !== 'user' && item.role !== 'assistant') {
        respond(400, { error: 'message role must be user or assistant' })
        return
      }
      if (typeof item.text !== 'string' || item.text.trim().length === 0) {
        respond(400, { error: 'message text must be a non-empty string' })
        return
      }
      let text = item.text.trim().slice(0, 20000)
      // 首条用户消息带上语境，让模型看到这段文字原本的出处
      if (!contextApplied && context.length > 0 && item.role === 'user') {
        text = '【这段话所在的完整消息，供理解语境】\n' + context +
          '\n\n【我选中的部分】\n' + text
        contextApplied = true
      }
      totalChars += text.length
      messages.push(chatMessage(item.role, text))
    }

    if (totalChars > 50000) {
      respond(413, { error: 'conversation is too large' })
      return
    }

    const selection = await resolveModel(llm)
    if (selection === null) {
      respond(503, { error: 'no model is available' })
      return
    }

    const provider = selection.provider
    const model = selection.model
    const system = buildSystemPrompt(level.id) +
      (tools.length > 0 ? TOOLS_SYSTEM_PROMPT : '') +
      (forceTool !== null ? forceToolPrompt(forceTool) : '')

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      ...(corsHeaders === null ? {} : corsHeaders)
    })
    res.flushHeaders()

    let wrote = false
    let currentMessages = messages
    let settled = false
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const options = {
          provider,
          model,
          messages: currentMessages,
          system,
          temperature: 0.3,
          maxTokens: level.maxTokens,
          ...(provider === EXPLAIN_PROVIDER ? { reasoningEffort: 'off' } : {}),
          ...(tools.length > 0 ? { tools } : {})
        }

        let text = ''
        const toolCalls = []
        let finish = null
        for await (const chunk of llm.stream(options)) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
            text += chunk.text
            wrote = true
            res.write(chunk.text)
          } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'tool-call') {
            toolCalls.push(chunk.block)
          } else if (chunk.type === 'finish') {
            finish = chunk.reason
          }
        }

        const wantsTools = finish !== null && finish.kind === 'tool-calls' && toolCalls.length > 0 && tools.length > 0
        if (!wantsTools) {
          settled = true
          if (finish !== null && (finish.kind === 'error' || finish.kind === 'aborted')) {
            const message = finish.failure !== undefined && finish.failure.message !== undefined
              ? finish.failure.message
              : finish.kind
            wrote = true
            res.write('\n\n[解释失败] ' + message)
          }
          break
        }

        // 回填 assistant 消息（本轮文本 + 工具调用），随后逐个回填工具结果
        const assistantContent = []
        if (text.length > 0) assistantContent.push({ type: 'text', text })
        for (const call of toolCalls) {
          assistantContent.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
        }
        currentMessages = currentMessages.concat([{
          role: 'assistant',
          content: assistantContent,
          source: { kind: 'model', provider, model }
        }])

        for (const call of toolCalls) {
          res.write('\n\n> 🔧 ' + toolLabel(call.name, call.arguments) + '\n\n')
          wrote = true
          const result = await executeTool(call.name, call.arguments)
          currentMessages = currentMessages.concat([{
            role: 'tool',
            toolCallId: call.id,
            content: [{ type: 'text', text: result.text }],
            isError: result.error === true,
            source: { kind: 'tool', callId: call.id }
          }])
        }
      }
      if (!settled) {
        wrote = true
        res.write('\n\n[提示] 已连续查找多轮仍未得出答案，为避免陷入循环已停止。请把问题描述得更具体，或换个问法再试。')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      wrote = true
      res.write('\n\n[解释失败] ' + message)
    } finally {
      if (!wrote) res.write('[解释失败] 模型没有返回内容')
      res.end()
    }
  }

  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/text-explain', handler }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/text-explain/settings', handler: settingsHandler }))
  // 对外 API（OpenAI 兼容）：给 Obsidian 插件、浏览器扩展与任何第三方客户端用
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/text-explain/v1/chat/completions', handler: openaiHandler }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/text-explain/v1/models', handler: openaiHandler }))

  // ---- 交接：在 DSH 里开一个新会话，把背景悄悄放进去 ----
  //
  // 给谁用：浏览器扩展这类**在 DSH 外面**的前端。它们够不着客户端的会话 API，
  // 只能请宿主半代劳。
  //
  // 语义选「静默预置」而不是「立刻唤醒」：用户点过解释之后，新会话再把话讲一遍
  // 毫无意义（这条由用户拍板）。所以背景只是排进上下文，模型等用户开口——
  // 既合「待命」的用法，也一个 token 都不烧。
  //
  // 安全：exact 路由绕开认证，所以这里只认本机来源（loopback）＋ 来源白名单。
  ctx.inject(['sessionController', 'agents'], (sessionController) => {
    const newSessionHandler = async (req, res) => {
      const prefs = await readSettingsFile()
      const origin = requestOrigin(req, prefs.allowedOrigins)
      const corsHeaders = corsHeadersFor(origin)

      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders === null
          ? { 'Cache-Control': 'no-store' }
          : {
              'Access-Control-Allow-Origin': origin.corsOrigin,
              'Access-Control-Allow-Methods': 'POST, OPTIONS',
              'Access-Control-Allow-Headers': '*',
              'Access-Control-Max-Age': '600',
              Vary: 'Origin',
              'Cache-Control': 'no-store'
            })
        res.end()
        return
      }

      if (origin.allowed !== true) {
        sendJson(res, 403, { error: 'origin not allowed' }, corsHeaders)
        return
      }
      const remote = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : ''
      const isLocalRequest =
        remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      if (!isLocalRequest) {
        sendJson(res, 403, { error: 'loopback only' }, corsHeaders)
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' }, corsHeaders)
        return
      }

      const body = await readJsonBody(req, 200000)
      if (body.error !== undefined) {
        sendJson(res, body.status, { error: body.error }, corsHeaders)
        return
      }
      const text = body.value && typeof body.value.text === 'string' ? body.value.text.trim() : ''
      if (text.length === 0) {
        sendJson(res, 400, { error: 'text is required' }, corsHeaders)
        return
      }
      if (text.length > 100000) {
        sendJson(res, 413, { error: 'too much text' }, corsHeaders)
        return
      }

      try {
        const created = await sessionController.create({})
        const sessionId = created && typeof created.sessionId === 'string' ? created.sessionId : null
        if (sessionId === null) {
          sendJson(res, 502, { error: 'session was not created' }, corsHeaders)
          return
        }
        const agent = ctx.agents.get(sessionId)
        if (!agent || typeof agent.inject !== 'function') {
          sendJson(res, 502, { error: 'session is not live' }, corsHeaders)
          return
        }
        // inject 不唤醒模型：背景进上下文，会话停在「等用户开口」
        await agent.inject({
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user' }
        })
        sendJson(res, 200, { sessionId }, corsHeaders)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sendJson(res, 502, { error: 'handoff failed: ' + message }, corsHeaders)
      }
    }

    ctx.effect(() => webServer.register({ kind: 'exact', path: '/api/text-explain/new-session', handler: newSessionHandler }))
  })
}
