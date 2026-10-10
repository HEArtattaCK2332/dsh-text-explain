// 宿主半桩测试：用假的 llm / webServer 真跑一次 /api/text-explain，
// 检查「难度旋钮」三档是否产出不同的系统提示词，以及非法档位是否回落默认档。
// 用法: node test/host.test.mjs [lib/index.js 的路径]
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const target = process.argv[2] || fileURLToPath(new URL('../lib/index.js', import.meta.url))

// 把设置写进临时目录，绝不碰真实的 <DSH_HOME>
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-text-explain-test-'))
process.env.DSH_HOME = tempHome
const settingsFile = path.join(tempHome, 'text-explain', 'settings.json')

const mod = await import(new URL(`file:///${target.replace(/\\/g, '/')}`).href)

const captured = []
const llm = {
  listProviders: () => [{ id: 'deepseek-official' }],
  listModels: async () => [{ id: 'deepseek-v4-flash' }],
  stream: (options) => {
    captured.push(options)
    return (async function* () {
      yield { type: 'text-delta', text: '（桩回答）' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

// 按路径分发：插件现在注册了多条路由（解释、设置、对外 API、交接）
const routes = new Map()
const webServer = {
  register: (route) => {
    routes.set(route.path, route.handler)
    return () => {}
  }
}

// 交接端点的桩：记录「建了哪个会话」「往里面注入了什么」，供断言使用。
// 同时挂一个 followup，用来证明插件走的是**静默** inject、没唤醒模型。
const sessionsCreated = []
const injected = []
const followedUp = []
const sessionController = {
  create: async (options) => {
    const sessionId = 'session-' + (sessionsCreated.length + 1)
    sessionsCreated.push({ sessionId, options })
    return { sessionId }
  }
}
const agents = {
  get: (sessionId) => ({
    inject: async (message) => {
      injected.push({ sessionId, message })
    },
    followup: async (message) => {
      followedUp.push({ sessionId, message })
    }
  })
}

const ctx = {
  llm,
  webServer,
  effect: (fn) => fn(),
  agents,
  // 运行时注入：桩里直接回调，把假的 sessionController 交出去
  inject: (names, callback) => {
    callback(sessionController)
  }
}

mod.apply(ctx)
if (routes.size < 2) {
  console.error(`FAIL: apply() 只注册了 ${routes.size} 条路由，期望 2 条`)
  process.exit(1)
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '').split('?')[0]
  const route = routes.get(pathname)
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'no such route in test stub' }))
    return
  }
  route(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

async function call(payload) {
  const res = await fetch(`http://127.0.0.1:${port}/api/text-explain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return { status: res.status, body: await res.text() }
}

async function callSettings(method, payload) {
  const options = { method }
  if (payload !== undefined) {
    options.headers = { 'Content-Type': 'application/json' }
    options.body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  }
  const res = await fetch(`http://127.0.0.1:${port}/api/text-explain/settings`, options)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch (_error) {
    json = null
  }
  return { status: res.status, body: text, json }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

// 1) 三档各来一次，看系统提示词与 maxTokens
const cases = [
  { level: 'plain', must: '完全不懂 AI', tokens: 1024 },
  { level: 'general', must: '会用电脑、有常识', tokens: 1024 },
  { level: 'pro', must: '同行', tokens: 1400 }
]

for (const item of cases) {
  const before = captured.length
  const response = await call({ text: '讲讲这段话', level: item.level, enableWeb: false, enableFile: false })
  const options = captured[before]
  check(`档位 ${item.level} 正常返回`, response.status === 200 && response.body.includes('桩回答'), `HTTP ${response.status}`)
  check(`档位 ${item.level} 提示词含「${item.must}」`, Boolean(options && options.system.includes(item.must)))
  check(`档位 ${item.level} maxTokens=${item.tokens}`, Boolean(options && options.maxTokens === item.tokens), String(options && options.maxTokens))
  check(`档位 ${item.level} 的系统提示词共用语境段`, Boolean(options && options.system.includes('【语境】') && options.system.includes('【格式】')))
}

// 2) 不传 level / 传非法值 → 一律回落默认档（plain）
const beforeDefault = captured.length
await call({ text: '不传档位', enableWeb: false, enableFile: false })
const noLevel = captured[beforeDefault]
check('不传 level 回落默认档', Boolean(noLevel && noLevel.system.includes('完全不懂 AI')))

const beforeBogus = captured.length
await call({ text: '非法档位', level: 'ultra-mega', enableWeb: false, enableFile: false })
const bogus = captured[beforeBogus]
check('非法 level 回落默认档', Boolean(bogus && bogus.system.includes('完全不懂 AI')))

// 3) 工具开关仍生效（工具提示词只在开启时附上）
const beforeTools = captured.length
await call({ text: '开工具', level: 'pro', enableWeb: true, enableFile: true })
const withTools = captured[beforeTools]
check('开启工具后附上工具说明', Boolean(withTools && withTools.system.includes('web_search')))
check('三档各自的系统提示词互不相同', new Set(captured.slice(0, 3).map((o) => o.system)).size === 3)

// 4) 语境注入仍然工作
const beforeCtx = captured.length
await call({ text: '选中的话', context: '这是它所在的那条完整消息', enableWeb: false, enableFile: false })
const withCtx = captured[beforeCtx]
const firstUser = withCtx && withCtx.messages.find((m) => m.role === 'user')
const flat = firstUser ? JSON.stringify(firstUser.content) : ''
check('语境仍被注入首条用户消息', flat.includes('这段话所在的完整消息') && flat.includes('我选中的部分'))

// 5) 空文本应当被拒
const rejected = await call({ text: '   ', enableWeb: false, enableFile: false })
check('空文本被拒（400）', rejected.status === 400, `HTTP ${rejected.status}`)

// 6) 设置端点：读、写、以及「不保存就不落盘」这条规矩
check('读设置之前，磁盘上不该有设置文件', !fs.existsSync(settingsFile))

const initial = await callSettings('GET')
check('GET 设置返回 200', initial.status === 200, `HTTP ${initial.status}`)
check('空文件时返回全套默认值',
  Boolean(initial.json) && initial.json.newSessionTarget === 'same-workspace' &&
  initial.json.explainLevel === 'plain' && initial.json.webDefault === true &&
  initial.json.fileDefault === true && initial.json.advancedVisible === false,
  JSON.stringify(initial.json))
check('只读一次不产生任何文件（不点保存就不落盘）', !fs.existsSync(settingsFile))

const saved = await callSettings('POST', {
  newSessionTarget: 'ungrouped',
  explainLevel: 'expert',
  webDefault: false,
  fileDefault: true,
  advancedVisible: true
})
check('POST 设置返回 200', saved.status === 200, `HTTP ${saved.status}`)
check('保存后返回的就是落盘的那份（四档时代的 expert 已迁移为 pro）',
  Boolean(saved.json) && saved.json.explainLevel === 'pro' && saved.json.newSessionTarget === 'ungrouped' &&
  saved.json.webDefault === false && saved.json.advancedVisible === true,
  JSON.stringify(saved.json))
check('保存后磁盘上出现了设置文件', fs.existsSync(settingsFile))

const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
check('磁盘内容与返回值一致', JSON.stringify(onDisk) === JSON.stringify(saved.json), JSON.stringify(onDisk))
check('磁盘文件是「键顺序稳定 + 结尾换行」的可读 JSON',
  fs.readFileSync(settingsFile, 'utf8').endsWith('\n'))

const reread = await callSettings('GET')
check('再读一次拿到刚保存的值（同为迁移后的 pro）',
  Boolean(reread.json) && reread.json.explainLevel === 'pro' && reread.json.advancedVisible === true,
  JSON.stringify(reread.json))

const dirty = await callSettings('POST', {
  explainLevel: 'ultra-mega',
  newSessionTarget: 'nowhere',
  webDefault: 'yes',
  fileDefault: 0,
  advancedVisible: 'maybe'
})
check('脏数据被洗净后落盘（不合法的一律回默认）',
  Boolean(dirty.json) && dirty.json.explainLevel === 'plain' && dirty.json.newSessionTarget === 'same-workspace' &&
  dirty.json.webDefault === true && dirty.json.fileDefault === true && dirty.json.advancedVisible === false,
  JSON.stringify(dirty.json))

const partial = await callSettings('POST', { explainLevel: 'pro' })
check('只提交一个字段时，其余字段回默认（不会把未提交的键写坏）',
  Boolean(partial.json) && partial.json.explainLevel === 'pro' && partial.json.newSessionTarget === 'same-workspace',
  JSON.stringify(partial.json))

const badJson = await callSettings('POST', '{ 这不是 JSON')
check('非法 JSON 返回 400，且不改动磁盘上的设置',
  badJson.status === 400 && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).explainLevel === 'pro',
  `HTTP ${badJson.status}`)

const badMethod = await callSettings('DELETE')
check('不支持的 HTTP 方法返回 405', badMethod.status === 405, `HTTP ${badMethod.status}`)

const missingRoute = await fetch(`http://127.0.0.1:${port}/api/text-explain/nope`)
check('未注册的路径返回 404（说明桩按路径分发正常）', missingRoute.status === 404, `HTTP ${missingRoute.status}`)

// 7) 来源白名单（给将来的浏览器扩展用）：默认关闭，登记了才放行
const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

async function callExplain(payload, headers) {
  const res = await fetch(`http://127.0.0.1:${port}/api/text-explain`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(payload)
  })
  return { status: res.status, body: await res.text(), headers: res.headers }
}

const blockedOrigin = await callExplain({ text: '跨源', enableWeb: false, enableFile: false }, { Origin: extensionOrigin })
check('白名单默认空时，扩展来源被拒（403）', blockedOrigin.status === 403, `HTTP ${blockedOrigin.status}`)

const noOrigin = await callExplain({ text: '无来源', enableWeb: false, enableFile: false })
check('没有 Origin 的请求照旧可用（默认零行为变化）',
  noOrigin.status === 200 && noOrigin.body.includes('桩回答'), `HTTP ${noOrigin.status}`)
check('无 Origin 的响应不带任何 CORS 头',
  noOrigin.headers.get('access-control-allow-origin') === null,
  String(noOrigin.headers.get('access-control-allow-origin')))

const sameOrigin = await callExplain({ text: '同源', enableWeb: false, enableFile: false }, { Origin: `http://127.0.0.1:${port}` })
check('与本机同源的请求放行', sameOrigin.status === 200, `HTTP ${sameOrigin.status}`)

const preflightBlocked = await fetch(`http://127.0.0.1:${port}/api/text-explain`, {
  method: 'OPTIONS',
  headers: { Origin: extensionOrigin, 'Access-Control-Request-Method': 'POST' }
})
check('未登记的预检回 204 但不给放行头（浏览器自会拦下真正的请求）',
  preflightBlocked.status === 204 && preflightBlocked.headers.get('access-control-allow-origin') === null,
  `HTTP ${preflightBlocked.status}`)

const beforeAllowlist = await callSettings('GET')
const withAllowlist = await callSettings('POST', Object.assign({}, beforeAllowlist.json, { allowedOrigins: [extensionOrigin] }))
check('白名单可以写进设置文件',
  Boolean(withAllowlist.json) && JSON.stringify(withAllowlist.json.allowedOrigins) === JSON.stringify([extensionOrigin]),
  JSON.stringify(withAllowlist.json && withAllowlist.json.allowedOrigins))

const allowedOrigin = await callExplain({ text: '白名单', enableWeb: false, enableFile: false }, { Origin: extensionOrigin })
check('登记后的扩展来源可以调用', allowedOrigin.status === 200, `HTTP ${allowedOrigin.status}`)
check('登记后的响应带上 CORS 头与 Vary，扩展才读得到流式回答',
  allowedOrigin.headers.get('access-control-allow-origin') === extensionOrigin &&
  (allowedOrigin.headers.get('vary') || '').includes('Origin'),
  String(allowedOrigin.headers.get('access-control-allow-origin')))

const preflightAllowed = await fetch(`http://127.0.0.1:${port}/api/text-explain`, {
  method: 'OPTIONS',
  headers: {
    Origin: extensionOrigin,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type'
  }
})
check('登记后的预检给出 Allow-Methods / Allow-Headers',
  preflightAllowed.status === 204 &&
  (preflightAllowed.headers.get('access-control-allow-methods') || '').includes('POST') &&
  preflightAllowed.headers.get('access-control-allow-headers') === '*',
  `${preflightAllowed.status} / ${preflightAllowed.headers.get('access-control-allow-methods')}`)

const strangerOrigin = await callExplain({ text: '别的源', enableWeb: false, enableFile: false }, { Origin: 'https://evil.example' })
check('白名单之外的一律 403（不给别的网页烧额度）', strangerOrigin.status === 403, `HTTP ${strangerOrigin.status}`)

const dirtyOrigins = await callSettings('POST', Object.assign({}, withAllowlist.json, {
  allowedOrigins: ['https://ok.example/', '不是来源', 'javascript:alert(1)', 'https://ok.example', extensionOrigin, 'chrome-extension://tooshort']
}))
check('白名单里的脏值被洗净（只留像样的来源，顺带去重）',
  JSON.stringify(dirtyOrigins.json.allowedOrigins) === JSON.stringify(['https://ok.example', extensionOrigin]),
  JSON.stringify(dirtyOrigins.json.allowedOrigins))

const emptyOrigins = await callSettings('POST', Object.assign({}, withAllowlist.json, { allowedOrigins: [] }))
check('白名单可以清空回默认（跨源再次一律拒绝）',
  JSON.stringify(emptyOrigins.json.allowedOrigins) === JSON.stringify([]))
const afterClear = await callExplain({ text: '清空后', enableWeb: false, enableFile: false }, { Origin: extensionOrigin })
check('清空白名单后，扩展来源重新被拒', afterClear.status === 403, `HTTP ${afterClear.status}`)

// 8) 对外 API：OpenAI 兼容层（给 Obsidian / 浏览器扩展 / 任何第三方客户端）
async function callOpenAi(path, payload, headers) {
  const init = { method: payload === undefined ? 'GET' : 'POST', headers: Object.assign({}, headers || {}) }
  if (payload !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(payload)
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init)
  return { status: res.status, body: await res.text(), headers: res.headers }
}

const modelList = await callOpenAi('/api/text-explain/v1/models')
check('对外 API：GET /v1/models 返回 200', modelList.status === 200, `HTTP ${modelList.status}`)
const parsedModels = JSON.parse(modelList.body)
check('对外 API：列出三档 model（text-explain-*）',
  Array.isArray(parsedModels.data) &&
  parsedModels.data.map((item) => item.id).join(',') ===
    'text-explain-plain,text-explain-general,text-explain-pro',
  JSON.stringify(parsedModels.data && parsedModels.data.map((item) => item.id)))

const completion = await callOpenAi('/api/text-explain/v1/chat/completions', {
  model: 'text-explain-plain',
  messages: [{ role: 'user', content: '这段话是什么意思' }]
})
check('对外 API：非流式补全返回 200', completion.status === 200, `HTTP ${completion.status}`)
const completionJson = JSON.parse(completion.body)
check('对外 API：响应是标准 chat.completion 形状',
  completionJson.object === 'chat.completion' &&
  typeof completionJson.id === 'string' &&
  completionJson.choices[0].message.role === 'assistant' &&
  completionJson.choices[0].message.content.includes('桩回答') &&
  completionJson.choices[0].finish_reason === 'stop',
  JSON.stringify(completionJson.choices && completionJson.choices[0] && completionJson.choices[0].message))
check('对外 API：带 usage 字段（额度统计）',
  Boolean(completionJson.usage) && typeof completionJson.usage.total_tokens === 'number',
  JSON.stringify(completionJson.usage))

const beforePro = captured.length
await callOpenAi('/api/text-explain/v1/chat/completions', {
  model: 'text-explain-pro',
  messages: [{ role: 'user', content: '讲讲' }]
})
check('对外 API：model 名映射到档位（pro → 同行口吻）',
  Boolean(captured[beforePro] && captured[beforePro].system.includes('同行')))

const beforeAlias = captured.length
await callOpenAi('/api/text-explain/v1/chat/completions', {
  model: 'text-explain-expert',
  messages: [{ role: 'user', content: '讲讲' }]
})
check('对外 API：四档时代的 expert 平滑落到 pro（不报错、也不降级成小白）',
  Boolean(captured[beforeAlias] && captured[beforeAlias].system.includes('同行')))

const beforeUnknownModel = captured.length
await callOpenAi('/api/text-explain/v1/chat/completions', {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: '讲讲' }]
})
check('对外 API：认不出的 model 回落默认档（不报错）',
  Boolean(captured[beforeUnknownModel] && captured[beforeUnknownModel].system.includes('完全不懂 AI')))

const beforeSystem = captured.length
await callOpenAi('/api/text-explain/v1/chat/completions', {
  model: 'text-explain-plain',
  messages: [
    { role: 'system', content: '你是一个只会写十四行诗的助手' },
    { role: 'user', content: '讲讲这段话' }
  ]
})
check('对外 API：忽略调用方的 system（讲解风格以本插件为准）',
  Boolean(captured[beforeSystem] && !captured[beforeSystem].system.includes('十四行诗')))
check('对外 API：被忽略的 system 不会混进用户消息',
  Boolean(captured[beforeSystem] && !JSON.stringify(captured[beforeSystem].messages).includes('十四行诗')))

const streamed = await callOpenAi('/api/text-explain/v1/chat/completions', {
  model: 'text-explain-plain',
  messages: [{ role: 'user', content: '流式讲讲' }],
  stream: true
})
check('对外 API：stream:true 返回 text/event-stream',
  streamed.status === 200 && (streamed.headers.get('content-type') || '').includes('text/event-stream'),
  String(streamed.headers.get('content-type')))
check('对外 API：流式以 data: [DONE] 收尾', streamed.body.trim().endsWith('data: [DONE]'))
const firstChunk = streamed.body.split('\n\n')[0]
check('对外 API：流式分片是标准 chat.completion.chunk',
  (() => {
    try {
      const parsed = JSON.parse(firstChunk.replace(/^data: /, ''))
      return parsed.object === 'chat.completion.chunk' && typeof parsed.choices[0].delta.content === 'string'
    } catch (_error) {
      return false
    }
  })(), firstChunk.slice(0, 120))

const badOpenAi = await callOpenAi('/api/text-explain/v1/chat/completions', { model: 'x' })
check('对外 API：缺 messages 返回 400，错误体是 OpenAI 形状',
  badOpenAi.status === 400 && JSON.parse(badOpenAi.body).error.message !== undefined,
  `HTTP ${badOpenAi.status}`)

// app:// 来源（Electron 应用，Obsidian 桌面版即 app://obsidian.md）
const appOriginSettings = await callSettings('GET')
const withAppOrigin = await callSettings('POST', Object.assign({}, appOriginSettings.json, { allowedOrigins: ['app://obsidian.md'] }))
check('白名单接受 app:// 来源（Obsidian 桌面版）',
  JSON.stringify(withAppOrigin.json.allowedOrigins) === JSON.stringify(['app://obsidian.md']),
  JSON.stringify(withAppOrigin.json.allowedOrigins))
const appOriginCall = await callOpenAi('/api/text-explain/v1/models', undefined, { Origin: 'app://obsidian.md' })
check('**登记后的 app:// 来源可以调用（Obsidian 桌面版能连上）**',
  appOriginCall.status === 200 &&
  appOriginCall.headers.get('access-control-allow-origin') === 'app://obsidian.md',
  `HTTP ${appOriginCall.status} / ${appOriginCall.headers.get('access-control-allow-origin')}`)
// 收尾：把白名单清回默认，免得影响后续断言
await callSettings('POST', Object.assign({}, appOriginSettings.json, { allowedOrigins: [] }))

const openAiNoOrigin = await callOpenAi('/api/text-explain/v1/models')
check('对外 API：**无 Origin 的客户端（Obsidian 桌面版 / curl）可直接用**',
  openAiNoOrigin.status === 200, `HTTP ${openAiNoOrigin.status}`)

const strangerOpenAi = await callOpenAi('/api/text-explain/v1/models', undefined, { Origin: 'https://evil.example' })
check('对外 API：陌生来源一律 403（不替它们烧额度）',
  strangerOpenAi.status === 403, `HTTP ${strangerOpenAi.status}`)

const openAiPreflight = await fetch(`http://127.0.0.1:${port}/api/text-explain/v1/chat/completions`, {
  method: 'OPTIONS',
  headers: { Origin: extensionOrigin, 'Access-Control-Request-Method': 'POST' }
})
check('对外 API：非白名单预检回 204，但不给放行头',
  openAiPreflight.status === 204 && openAiPreflight.headers.get('access-control-allow-origin') === null,
  `${openAiPreflight.status} / ${openAiPreflight.headers.get('access-control-allow-origin')}`)

// 9) 交接端点：在 DSH 里开一个新会话，把背景静默放进去
const handoffUrl = `http://127.0.0.1:${port}/api/text-explain/new-session`
const handoff = await fetch(handoffUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: '【背景】测试用的一段资料' })
})
const handoffJson = await handoff.json()
check('交接：POST 返回 200 与 sessionId',
  handoff.status === 200 && typeof handoffJson.sessionId === 'string', JSON.stringify(handoffJson))
check('交接：确实创建了一个会话', sessionsCreated.length === 1, JSON.stringify(sessionsCreated))
check('交接：背景被注入，且注给刚建的那个会话',
  injected.length === 1 &&
  injected[0].sessionId === handoffJson.sessionId &&
  injected[0].message.content[0].text === '【背景】测试用的一段资料',
  JSON.stringify(injected[0] && injected[0].message))
check('交接：注入的消息是 user 角色、来源标记为 user',
  injected[0].message.role === 'user' && injected[0].message.source.kind === 'user')
check('交接：**走的是静默 inject，没有 followup**（不唤醒模型、不烧 token）',
  followedUp.length === 0, `followup 调用次数 ${followedUp.length}`)

const handoffEmpty = await fetch(handoffUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: '   ' })
})
check('交接：空 text 返回 400', handoffEmpty.status === 400, `HTTP ${handoffEmpty.status}`)

const handoffWrongMethod = await fetch(handoffUrl, { method: 'GET' })
check('交接：GET 返回 405', handoffWrongMethod.status === 405, `HTTP ${handoffWrongMethod.status}`)

const handoffPreflight = await fetch(handoffUrl, { method: 'OPTIONS' })
check('交接：预检返回 204', handoffPreflight.status === 204, `HTTP ${handoffPreflight.status}`)

const handoffStranger = await fetch(handoffUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
  body: JSON.stringify({ text: 'x' })
})
check('交接：陌生来源一律 403（不让别人的网页指挥 DSH 开会话）',
  handoffStranger.status === 403, `HTTP ${handoffStranger.status}`)

// 10) 工具：默认听设置（模型自主判断），以及用户的「强制触发」
async function postExplain(body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/text-explain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return res.text()
}

const beforeToolDefault = captured.length
await postExplain({ text: '不带工具参数' })
check('工具：请求没说时按设置里的默认（默认开）→ 工具已交给模型自主判断',
  Array.isArray(captured[beforeToolDefault].tools) && captured[beforeToolDefault].tools.length > 0,
  `工具数 ${captured[beforeToolDefault].tools ? captured[beforeToolDefault].tools.length : 0}`)

const beforeToolOff = captured.length
await postExplain({ text: '明确关掉', enableWeb: false, enableFile: false })
check('工具：请求明确关掉时，一个工具都不给',
  !captured[beforeToolOff].tools || captured[beforeToolOff].tools.length === 0,
  JSON.stringify(captured[beforeToolOff].tools))

const beforeForceWeb = captured.length
await postExplain({ text: '强制联网', enableWeb: false, enableFile: false, forceTool: 'web' })
const forcedSystem = captured[beforeForceWeb].system
check('强制触发：即便原本关着，也把该工具交给模型',
  Array.isArray(captured[beforeForceWeb].tools) && captured[beforeForceWeb].tools.length > 0)
check('强制触发：系统提示里加了「用户主动要求补充检索」这一段（独有标记）',
  forcedSystem.includes('【本轮是用户主动要求的补充检索】'))
check('强制触发（联网）：这一段点名「联网搜索」并要求先动手查',
  forcedSystem.includes('他点了「联网搜索」') && forcedSystem.includes('动手查一次'))
check('强制触发：**明确要求不复述已讲过的内容**',
  forcedSystem.includes('不要复述'))
check('强制触发：要求只补充新查到的东西',
  forcedSystem.includes('新查到'))
const beforeForceUnknown = captured.length
await postExplain({ text: '乱传', forceTool: 'telepathy' })
check('强制触发：不认识的取值不影响正常流程（既不报错，也不误当强制）',
  !captured[beforeForceUnknown].system.includes('【本轮是用户主动要求的补充检索】'))

const beforeForceFile = captured.length
await postExplain({ text: '强制查本地', forceTool: 'file' })
check('强制触发（本地）：这一段点名「本地搜索」',
  captured[beforeForceFile].system.includes('他点了「本地搜索」'))

server.close()
fs.rmSync(tempHome, { recursive: true, force: true })

const failed = results.filter((item) => !item.ok)
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length === 0 ? 0 : 1)
