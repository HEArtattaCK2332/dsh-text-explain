// 客户端半桩测试（不依赖浏览器）：
//  A. 用 React / slot 桩真加载 lib/client.js，验证模块结构、插槽注册、apply 不炸；
//  B. 从源码里抽出「设置层」代码块（SETTINGS_ENDPOINT … saveSettings），在 fetch 桩上验证
//     缓存 / 读取 / 保存三件事，以及最关键的一条规矩：**不点保存，就不该有任何写入**。
// 用法: node test/settings.test.mjs [lib/client.js 的路径]
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const target = process.argv[2] || fileURLToPath(new URL('../lib/client.js', import.meta.url))
const source = fs.readFileSync(target, 'utf8')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

// ---------- A. 模块加载 ----------
let loaded = null
const ReactStub = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  createElement: (type, props, ...children) => ({ type, props, children })
}
globalThis.window = {
  innerWidth: 1440,
  innerHeight: 900,
  __ModuleLoader__: { load: (definition) => { loaded = definition } }
}
// 桩环境下不允许真发请求：插件挂载时的预热应当安静地失败并回落到默认值
globalThis.fetch = () => Promise.reject(new Error('stub environment: no network'))

const moduleExports = { exports: {} }
const requireStub = (name) => {
  if (name === 'react') return ReactStub
  throw new Error('unexpected require: ' + name)
}

let loadError = null
try {
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', 'module', source)(globalThis.window, requireStub, moduleExports)
} catch (error) {
  loadError = error
}
check('client.js 能被执行（模块定义无运行时错误）', loadError === null, loadError ? String(loadError) : '')
check('注册进 ModuleLoader 且 id 正确', Boolean(loaded && loaded.id === 'dsh-text-explain'), loaded ? loaded.id : 'none')

let api = null
try {
  api = loaded.factory(requireStub)
} catch (error) {
  check('factory 能执行', false, String(error))
}
check('factory 产出 exports', Boolean(api && typeof api.apply === 'function'))
check('exports.inject 声明 slots/sessions/uiWorkspace',
  Boolean(api && Array.isArray(api.inject) && ['slots', 'sessions', 'uiWorkspace'].every((k) => api.inject.includes(k))),
  api ? JSON.stringify(api.inject) : '')

const injections = []
const registrations = []
const ctxStub = {
  slots: {
    inject: (name, factory) => { injections.push(name); return factory() },
    register: (spec, component) => { registrations.push({ spec, component }); return () => {} }
  },
  effect: (fn) => { try { return fn() } catch (_error) { return () => {} } },
  sessions: {},
  uiWorkspace: {}
}
let applyError = null
try {
  api.apply(ctxStub)
} catch (error) {
  applyError = error
}
check('apply() 不抛错（React 桩 + 无网络环境下）', applyError === null, applyError ? String(applyError) : '')
check('注册了 shell.overlay 与 settings.section 两个插槽',
  injections.includes('shell.overlay') && injections.includes('settings.section'),
  JSON.stringify(injections))
const section = registrations.find((item) => item.spec.name === 'settings.section')
check('设置栏目的 id / order / label 符合约定',
  Boolean(section && section.spec.id === 'dsh-text-explain' && section.spec.order === 60 &&
    typeof section.spec.label === 'function' && section.spec.label() === '划词解释'),
  section ? JSON.stringify({ id: section.spec.id, order: section.spec.order, label: section.spec.label() }) : '')

// ---------- B. 设置层 ----------
const start = source.indexOf('var SETTINGS_ENDPOINT')
const end = source.indexOf('var BUTTON_STYLE')
check('能从源码里定位设置层代码块', start > 0 && end > start, `[${start}, ${end}]`)
const block = source.slice(start, end)

/** 造一个隔离的设置层环境：fetch 由测试摆布，返回的调用记录用来断言。 */
function makeSettingsEnv() {
  const calls = []
  let pending = null
  const fetchStub = (url, options) => {
    calls.push({ url, options })
    if (pending === null) return Promise.reject(new Error('network down'))
    const response = pending
    pending = null
    return Promise.resolve(response)
  }
  const factory = new Function(
    'window',
    'fetch',
    block + '\nreturn { LEVEL_OPTIONS, DEFAULT_SETTINGS, normalizeSettings, sameSettings, getSettings, fetchSettings, saveSettings, isLevelId };'
  )
  const settingsApi = factory({}, fetchStub)
  return {
    api: settingsApi,
    calls,
    posts: () => calls.filter((item) => item.options && item.options.method === 'POST'),
    ok: (payload) => { pending = { ok: true, status: 200, json: () => Promise.resolve(payload) } },
    fail: () => { pending = { ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) } },
    broken: () => { pending = { ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) } }
  }
}

const full = {
  newSessionTarget: 'same-workspace',
  explainLevel: 'plain',
  webDefault: true,
  fileDefault: true,
  showWebButton: true,
  showFileButton: true,
  advancedVisible: false,
  allowedOrigins: []
}

check('空数据 → 全套八字段默认值', JSON.stringify(makeSettingsEnv().api.normalizeSettings(null)) === JSON.stringify(full))
check('脏数据被洗净成合法默认值',
  JSON.stringify(makeSettingsEnv().api.normalizeSettings({
    newSessionTarget: 'nowhere', explainLevel: 'ultra-mega', webDefault: 'yes', fileDefault: 0,
    advancedVisible: 'maybe', allowedOrigins: 'not-an-array'
  })) === JSON.stringify(full))
check('白名单里的脏来源被洗净（与宿主同一套规则）',
  JSON.stringify(makeSettingsEnv().api.normalizeSettings({
    allowedOrigins: ['https://ok.example/', '不是来源', 'javascript:alert(1)',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'https://ok.example']
  }).allowedOrigins) === JSON.stringify(['https://ok.example', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop']))
check('未知档位不被认作合法 id', makeSettingsEnv().api.isLevelId('nope') === false)
check('旧档位 expert 归一化为 pro（不是回落成小白）', makeSettingsEnv().api.normalizeSettings({ explainLevel: 'expert' }).explainLevel === 'pro')
check('三档 id 与 label 齐备',
  makeSettingsEnv().api.LEVEL_OPTIONS.map((o) => o.id).join(',') === 'plain,general,pro' &&
  makeSettingsEnv().api.LEVEL_OPTIONS.map((o) => o.label).join(',') === '小白,通识,专业')

const diff = makeSettingsEnv().api
check('脏检测：五字段全同 → 不脏', diff.sameSettings(full, Object.assign({}, full)) === true)
check('脏检测：只差 advancedVisible 也算脏',
  diff.sameSettings(full, Object.assign({}, full, { advancedVisible: true })) === false)
check('脏检测：只差白名单也算脏',
  diff.sameSettings(full, Object.assign({}, full, { allowedOrigins: ['https://a.example'] })) === false)

// —— 读 ——
const env = makeSettingsEnv()
check('还没读过时，缓存里就是默认值（插件立刻可用）', env.api.getSettings().explainLevel === 'plain')
check('打开面板之前没有任何网络调用', env.calls.length === 0)

env.ok(Object.assign({}, full, { explainLevel: 'pro', advancedVisible: true }))
const got = await env.api.fetchSettings()
check('读取成功后返回该值', Boolean(got) && got.explainLevel === 'pro' && got.advancedVisible === true)
check('读取成功后缓存同步更新', env.api.getSettings().explainLevel === 'pro' && env.api.getSettings().advancedVisible === true)
check('读取走设置端点、用 GET（不带 method 或 method=GET）',
  env.calls.length === 1 && env.calls[0].url === '/api/text-explain/settings' &&
  (env.calls[0].options === undefined || env.calls[0].options.method === undefined),
  JSON.stringify(env.calls[0]))
check('读取没有补齐的字段由前端补默认值', got.newSessionTarget === 'same-workspace' && got.fileDefault === true)
check('**只读不写**：这一轮没有任何 POST', env.posts().length === 0)

env.fail()
const failedRead = await env.api.fetchSettings()
check('读取遇到非 200 → 返回 null，缓存原样不动',
  failedRead === null && env.api.getSettings().explainLevel === 'pro')

env.broken()
const brokenRead = await env.api.fetchSettings()
check('响应体不是合法 JSON → 返回 null，缓存原样不动',
  brokenRead === null && env.api.getSettings().explainLevel === 'pro')

const offline = makeSettingsEnv()
const offlineRead = await offline.api.fetchSettings()
check('网络异常 → 返回 null（不抛错），缓存回默认',
  offlineRead === null && offline.api.getSettings().explainLevel === 'plain')

// —— 写 ——
const draft = { newSessionTarget: 'ungrouped', explainLevel: 'pro', webDefault: false, fileDefault: false, advancedVisible: true }
env.ok(Object.assign({}, draft))
const savedByHost = await env.api.saveSettings(draft)
const lastCall = env.calls[env.calls.length - 1]
check('保存走 POST', Boolean(lastCall.options && lastCall.options.method === 'POST'))
check('保存发到设置端点', lastCall.url === '/api/text-explain/settings')
check('保存提交的是整份八字段设置（不是增量补丁）',
  JSON.stringify(Object.keys(JSON.parse(lastCall.options.body)).sort()) ===
  JSON.stringify(Object.keys(full).sort()),
  lastCall.options.body)
check('保存提交的就是传进来的那份草稿',
  JSON.parse(lastCall.options.body).explainLevel === 'pro' && JSON.parse(lastCall.options.body).advancedVisible === true)

// —— 白名单必须原样带回：否则在面板点一次「保存」就把扩展的白名单抹了 ——
const keeper = makeSettingsEnv()
const withOrigin = Object.assign({}, full, {
  allowedOrigins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop']
})
keeper.ok(withOrigin)
const keptBack = await keeper.api.saveSettings(withOrigin)
check('保存时白名单原样带在请求体里',
  JSON.stringify(JSON.parse(keeper.calls[keeper.calls.length - 1].options.body).allowedOrigins) ===
  JSON.stringify(['chrome-extension://abcdefghijklmnopabcdefghijklmnop']))
check('保存后的返回值里白名单还在', JSON.stringify(keptBack.allowedOrigins) ===
  JSON.stringify(['chrome-extension://abcdefghijklmnopabcdefghijklmnop']))
check('缓存里也保住了白名单',
  keeper.api.getSettings().allowedOrigins.length === 1)
check('保存成功后返回落盘的那份', Boolean(savedByHost) && savedByHost.explainLevel === 'pro')
check('保存成功后缓存也跟着变（下次开弹窗用的是新档）', env.api.getSettings().explainLevel === 'pro')
const sentBody = JSON.parse(lastCall.options.body)
check('保存时会把草稿洗一遍：没提到的字段补默认，脏值不会发出去',
  sentBody.newSessionTarget === draft.newSessionTarget &&
  sentBody.explainLevel === draft.explainLevel &&
  sentBody.webDefault === draft.webDefault &&
  sentBody.fileDefault === draft.fileDefault &&
  sentBody.advancedVisible === draft.advancedVisible &&
  JSON.stringify(sentBody.allowedOrigins) === JSON.stringify([]),
  lastCall.options.body)

env.fail()
const failedSave = await env.api.saveSettings({ explainLevel: 'expert' })
check('保存失败 → 返回 null（界面据此报错）', failedSave === null)
check('保存失败不改缓存，更不会半途改掉其它字段',
  env.api.getSettings().explainLevel === 'pro' && env.api.getSettings().newSessionTarget === 'ungrouped')

// —— 关键规矩：不点保存就不记录 ——
check('源码里再无 localStorage / sessionStorage / indexedDB',
  !/localStorage|sessionStorage|indexedDB/.test(source))
check('设置层里只有一处 POST —— 就是「保存」',
  (block.match(/method: 'POST'/g) || []).length === 1,
  String((block.match(/method: 'POST'/g) || []).length))
check('全文件的 POST 仅两处：解释请求 + 保存设置（前者不落盘）',
  (source.match(/method: 'POST'/g) || []).length === 2,
  String((source.match(/method: 'POST'/g) || []).length))
check('设置端点只在设置层出现一次', (source.match(/\/api\/text-explain\/settings/g) || []).length === 1)
check('弹窗切档不再偷偷写设置（switchLevel 里没有 saveSettings）',
  !/function switchLevel[\s\S]{0,500}saveSettings/.test(source))

const failed = results.filter((item) => !item.ok)
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length === 0 ? 0 : 1)
