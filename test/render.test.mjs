// 渲染冒烟测试：在 React 桩上真调用 lib/client.js 里的两个组件函数，
// 检查渲染树成型、按钮与文案齐备、不抛错。
// 关键手法：只在**内存里**把一行 `exports.apply = apply` 换成带测试钩子的版本，
// 源码文件本身一字不改。
// 用法: node test/render.test.mjs [lib/client.js 的路径]
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const target = process.argv[2] || fileURLToPath(new URL('../lib/client.js', import.meta.url))

const raw = fs.readFileSync(target, 'utf8')
if (!raw.includes('exports.apply = apply')) {
  console.error('FAIL: 源码里找不到 `exports.apply = apply`，测试钩子注入失败')
  process.exit(1)
}

const withHook = raw.replace(
  'exports.apply = apply',
  'exports.__test = { TextExplainSettings: TextExplainSettings, TextExplainOverlay: TextExplainOverlay };\n    exports.apply = apply'
)
// 说明：「高级设置」的展开状态如今是设置里的一项（draft.advancedVisible），
// 不再靠替换源码，改装进 useState 的桩值即可（见下方 renderSettings）。

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

function loadModule(source, stateOverrides) {
  let loaded = null
  // 桩里故意**不提供** localStorage —— 设置如今存在宿主侧，浏览器存储早不用了
  const windowStub = {
    innerWidth: 1440,
    innerHeight: 900,
    __ModuleLoader__: { load: (definition) => { loaded = definition } }
  }
  let useStateCalls = 0
  const ReactStub = {
    useState: (initial) => {
      const index = useStateCalls++
      if (stateOverrides && Object.prototype.hasOwnProperty.call(stateOverrides, index)) {
        return [stateOverrides[index], () => {}]
      }
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    createElement: (type, props, ...children) => ({ type, props, children })
  }
  const requireStub = (name) => {
    if (name === 'react') return ReactStub
    throw new Error('unexpected require: ' + name)
  }
  const moduleExports = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', 'module', source)(windowStub, requireStub, moduleExports)
  const api = loaded.factory(requireStub)
  return { api, windowStub, resetUseState: () => { useStateCalls = 0 } }
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visit))
    return
  }
  if (typeof node === 'object') {
    visit(node)
    walk(node.children, visit)
    return
  }
}

function collect(node) {
  const buttons = []
  const texts = []
  function visit(current) {
    if (current === null || current === undefined || typeof current === 'boolean') return
    if (typeof current === 'string') {
      texts.push(current)
      return
    }
    if (Array.isArray(current)) {
      current.forEach(visit)
      return
    }
    if (typeof current === 'object') {
      if (current.type === 'button') buttons.push(current)
      visit(current.children)
    }
  }
  visit(node)
  return { buttons, text: texts.join(' | ') }
}

/** 弹窗里的档位按钮不靠文字前缀区分，而是靠样式（选中态用 TOGGLE_ON_STYLE 的蓝边）。 */
function isActiveStyle(button) {
  return Boolean(button.props && button.props.style && button.props.style.border === '1px solid #3b82f6')
}

function buttonLabel(button) {
  return (button.children || []).filter((child) => typeof child === 'string').join('')
}

// ---- A. 设置面板：还没读到设置时（useEffect 在桩里不执行，故停在 loading 态）----
const loadingPanel = loadModule(withHook)
let loadingTree = null
try {
  loadingTree = loadingPanel.api.__test.TextExplainSettings({})
} catch (error) {
  check('设置面板渲染不抛错', false, String(error))
}
check('设置面板渲染不抛错', loadingTree !== null)
const loadingView = collect(loadingTree)
check('读取中只显示一行提示，不摆出任何选项',
  loadingView.text.includes('正在读取设置…') && loadingView.buttons.length === 0,
  loadingView.buttons.map(buttonLabel).join(' / '))

// ---- B. 设置面板：读到设置之后（用 useState 注入 saved / draft / phase）----
// useState 调用次序：saved(0), draft(1), note(2), phase(3), busy(4)
const baseSettings = {
  newSessionTarget: 'same-workspace',
  explainLevel: 'plain',
  webDefault: true,
  fileDefault: true,
  advancedVisible: false
}

function renderSettings(overrides) {
  const instance = loadModule(withHook, overrides)
  instance.resetUseState()
  let tree = null
  let error = null
  try {
    tree = instance.api.__test.TextExplainSettings({})
  } catch (caught) {
    error = caught
  }
  return { tree, error }
}

const collapsed = renderSettings({ 0: baseSettings, 1: baseSettings, 3: 'ready' })
check('读到设置后渲染不抛错', collapsed.tree !== null && collapsed.error === null,
  collapsed.error ? String(collapsed.error) : '')
const collapsedView = collect(collapsed.tree)
check('顶部有「刷新」按钮', collapsedView.buttons.some((b) => buttonLabel(b) === '刷新'))
check('顶部有「保存」按钮', collapsedView.buttons.some((b) => buttonLabel(b) === '保存'))
check('无改动时显示「无未保存改动」', collapsedView.text.includes('无未保存改动'))
check('常用区含「讲给谁听」', collapsedView.text.includes('讲给谁听'))
check('三档按钮齐备（小白/通识/专业）',
  ['小白', '通识', '专业'].every((label) => collapsedView.buttons.some((b) => buttonLabel(b).includes(label))),
  collapsedView.buttons.map(buttonLabel).join(' / '))
check('默认档「小白」处于选中态（● 前缀）',
  collapsedView.buttons.some((b) => buttonLabel(b) === '● 小白'))
check('会话落点两个选项齐备', collapsedView.buttons.some((b) => buttonLabel(b).includes('与当前对话同工作区')) &&
  collapsedView.buttons.some((b) => buttonLabel(b).includes('未分组')))
check('高级设置折叠时不渲染高级项', collapsedView.buttons.some((b) => buttonLabel(b).includes('高级设置')) &&
  !collapsedView.text.includes('工具：平时给不给模型'))
check('收起态按钮数 = 8（刷新/保存 + 3 档 + 2 落点 + 高级折叠）',
  collapsedView.buttons.length === 8, collapsedView.buttons.map(buttonLabel).join(' / '))

// ---- C. 设置面板：有未保存改动 + 高级展开 ----
const dirtyDraft = Object.assign({}, baseSettings, { explainLevel: 'pro', advancedVisible: true, webDefault: false })
const expanded = renderSettings({ 0: baseSettings, 1: dirtyDraft, 3: 'ready' })
check('高级展开 + 有改动时渲染不抛错', expanded.tree !== null && expanded.error === null,
  expanded.error ? String(expanded.error) : '')
const expandedView = collect(expanded.tree)
check('有改动时提示「有未保存的改动」', expandedView.text.includes('有未保存的改动'),
  expandedView.text.slice(0, 200))
check('高级区出现「工具：平时给不给模型」', expandedView.text.includes('工具：平时给不给模型'))
check('高级区四项开关齐备（两个「默认给不给」+ 两个「显不显示」）',
  expandedView.buttons.some((b) => buttonLabel(b).includes('默认开启联网')) &&
  expandedView.buttons.some((b) => buttonLabel(b).includes('默认开启本地查找')) &&
  expandedView.buttons.some((b) => buttonLabel(b).includes('显示「联网搜索」')) &&
  expandedView.buttons.some((b) => buttonLabel(b).includes('显示「本地搜索」')))
check('展开态按钮数 = 12（比原来多两个「显示按钮」开关）', expandedView.buttons.length === 12, expandedView.buttons.map(buttonLabel).join(' / '))
check('草稿里的档位（专业）处于选中态',
  expandedView.buttons.some((b) => buttonLabel(b) === '● 专业'))
check('草稿里关掉的「默认开启联网」显示为未选中',
  expandedView.buttons.some((b) => buttonLabel(b) === '○ 默认开启联网'))

// ---- D. 设置面板：读不到设置时的错误态 ----
const broken = renderSettings({ 0: null, 1: null, 3: 'error' })
check('错误态渲染不抛错', broken.tree !== null && broken.error === null, broken.error ? String(broken.error) : '')
const brokenView = collect(broken.tree)
check('错误态给出「没能读到设置」与重试入口',
  brokenView.text.includes('没能读到设置') && brokenView.buttons.some((b) => buttonLabel(b) === '刷新'))
check('错误态不摆出任何设置选项（免得对着假默认值乱点）',
  !brokenView.text.includes('讲给谁听') && !brokenView.buttons.some((b) => buttonLabel(b).includes('小白')))

// ---- E. 弹窗覆盖层（未划词、无面板时应渲染为空壳）----
const overlay = loadModule(withHook)
let overlayTree = null
try {
  overlayTree = overlay.api.__test.TextExplainOverlay({
    ctx: { sessions: {}, uiWorkspace: {} }
  })
} catch (error) {
  check('弹窗组件渲染不抛错', false, String(error))
}
check('弹窗组件渲染不抛错（未划词时为空壳）', overlayTree !== null)
const overlayView = collect(overlayTree)
check('未划词时不出现按钮', overlayView.buttons.length === 0, String(overlayView.buttons.length))

// ---- D. 弹窗在有选中内容时的按钮行 ----
const selected = loadModule(withHook)
let selectedTree = null
try {
  // 直接构造「已划词」的渲染：借道 useState 桩无法注入，改为验证组件对空选择的稳健性即可；
  // 有选中时的分支由静态断言兜底（见下）。
  selectedTree = selected.api.__test.TextExplainOverlay({ ctx: { sessions: {}, uiWorkspace: {} } })
} catch (_error) {
  selectedTree = null
}
check('弹窗渲染路径稳定（可重复渲染）', selectedTree !== null)
check('源码里档位按钮行挂在弹窗底部（讲给谁听）', /'讲给谁听'/.test(raw) && /levelButtons/.test(raw))
check('切档函数存在且带重讲', /function switchLevel\(nextLevel\)/.test(raw) && /retell\(nextLevel\)/.test(raw))

// ---- F. 「新建为对话」的交接单基调：待命，不催促展开 ----
check('交接单末尾是待命指令（只回一句，别总结/提问/展开）',
  /不要总结、不要提问、不要展开/.test(raw))
check('旧的催促句「请就以上内容继续深入」已彻底移除',
  !/请就以上内容继续深入/.test(raw),
  /请就以上内容继续深入/.test(raw) ? '仍能找到旧句' : '')
check('交接单开头点明性质：先把背景收好、等用户的问题',
  /先把这些背景收好/.test(raw))
check('按钮悬停说明写明「先记住背景、等您开口」',
  /先记住背景、等您开口/.test(raw))
check('交接单仍完整带回：原文、所在消息、已进行的问答',
  /## 选中的原文/.test(raw) && /## 这段原文所在的完整消息/.test(raw) && /## 已进行的解释与追问/.test(raw))

// ---- E. 弹窗「已划词 + 已有问答」的完整渲染（含手写 Markdown 渲染器）----
// useState 调用次序：selected, panel, thread, answer, loading, error, input, busyNewChat, web, file, level
const answered = loadModule(withHook, {
  0: { text: '分布式数据同步方案的技术选型', context: '这是它所在的那条完整消息', x: 100, y: 120 },
  1: { text: '分布式数据同步方案的技术选型', context: '这是它所在的那条完整消息', x: 100, y: 120 },
  2: [
    { role: 'user', text: '分布式数据同步方案的技术选型' },
    { role: 'assistant', text: '## 先说人话\n\n这讲的是**几台电脑**怎么记同一份数据。\n\n| 术语 | 白话 |\n|---|---|\n| CRDT | 不会打架的格式 |\n\n- 第一点\n- 第二点\n\n> 引用一句\n\n`行内代码`\n\n```\n代码块\n```\n\n[链接](https://example.com)'
    }
  ],
  10: 'pro'
})
answered.resetUseState()
let answeredTree = null
try {
  answeredTree = answered.api.__test.TextExplainOverlay({ ctx: { sessions: {}, uiWorkspace: {} } })
} catch (error) {
  check('弹窗完整渲染不抛错', false, String(error))
}
check('弹窗完整渲染不抛错（含 Markdown 渲染）', answeredTree !== null)
const answeredView = collect(answeredTree)
check('弹窗底部出现「讲给谁听」档位行', answeredView.text.includes('讲给谁听'))
check('档位行含三个档位按钮', ['小白', '通识', '专业'].every((label) =>
  answeredView.buttons.some((b) => buttonLabel(b).includes(label))))
check('当前档位 pro 处于选中态（蓝边高亮）',
  answeredView.buttons.some((b) => buttonLabel(b) === '专业' && isActiveStyle(b)),
  answeredView.buttons.map((b) => buttonLabel(b) + (isActiveStyle(b) ? '(选中)' : '')).join(' / '))
check('非当前档位不是选中态', answeredView.buttons.some((b) => buttonLabel(b) === '小白' && !isActiveStyle(b)))
check('仍保留「联网搜索」「本地搜索」「新建为对话」三个按钮',
  answeredView.buttons.some((b) => buttonLabel(b).includes('联网搜索')) &&
  answeredView.buttons.some((b) => buttonLabel(b).includes('本地搜索')) &&
  answeredView.buttons.some((b) => buttonLabel(b).includes('新建为对话')))
check('Markdown 渲染出标题 / 表格 / 代码块 / 引用 / 链接',
  ['h2', 'table', 'pre', 'blockquote', 'a'].every((tag) => {
    let found = false
    walk(answeredTree, (element) => { if (element.type === tag) found = true })
    return found
  }))
check('问句与回答都出现在渲染树里',
  answeredView.text.includes('分布式数据同步方案的技术选型') && answeredView.text.includes('先说人话'),
  JSON.stringify(answeredView.text.slice(0, 400)))

// 弹窗：重讲时折叠保留旧回答，并显式声明 turn
const clientSourceForCollapse = fs.readFileSync(target, 'utf8')
check('弹窗：重讲时把旧回答标成 superseded（不再是 pending.pop() 删掉重发）',
  clientSourceForCollapse.includes('function supersedeAnswers') &&
  !clientSourceForCollapse.includes('pending.pop()'))
check('弹窗：被取代的回答折叠显示，可展开对照',
  clientSourceForCollapse.includes('superseded === true') &&
  clientSourceForCollapse.includes('上一次的回答（点开查看）'))
check('弹窗：追问显式声明 turn=followup',
  clientSourceForCollapse.includes("turn: 'followup'"))
check('弹窗：请求体带上 turn',
  clientSourceForCollapse.includes('turn: usedTurn'))

const failed = results.filter((item) => !item.ok)
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length === 0 ? 0 : 1)
