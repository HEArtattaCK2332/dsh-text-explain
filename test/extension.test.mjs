// 浏览器扩展的自检：markdown 渲染（含 XSS 转义）、manifest 形状、关键文件与静态约定。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const extDir = path.join(here, '..', 'extension')

const results = []
function check(name, ok, evidence) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence === undefined ? '' : '  ' + evidence}`)
}

// 1) markdown 渲染
const mdSource = fs.readFileSync(path.join(extDir, 'markdown.js'), 'utf8')
const render = new Function(mdSource + '\nreturn TextExplainMarkdown')()

check('markdown：粗体', render('这是**重点**。').includes('<strong>重点</strong>'))
check('markdown：行内代码', render('用 `npm i` 装。').includes('<code>npm i</code>'))
check('markdown：代码块', render('```\nconst a = 1\n```').includes('<pre><code>const a = 1</code></pre>'))
check('markdown：三级标题', render('### 小标题').includes('<h3>小标题</h3>'))
check('markdown：无序列表',
  render('- 甲\n- 乙').includes('<ul><li>甲</li><li>乙</li></ul>'))
check('markdown：有序列表',
  render('1. 甲\n2. 乙').includes('<ol><li>甲</li><li>乙</li></ol>'))
check('markdown：引用', render('> 一句话').includes('<blockquote>一句话</blockquote>'))
check('markdown：链接在新窗口打开且带 noopener',
  render('[文档](https://example.com)').includes('rel="noreferrer noopener"'))
check('markdown：相邻行合为一段', render('第一行\n第二行').includes('<p>第一行 第二行</p>'))
check('markdown：空输入返回空串', render('') === '' && render(null) === '')

// —— 这一组最重要：渲染的内容来自模型，而模型看到的是网页文字
check('XSS：尖括号被转义', (() => {
  const out = render('<script>alert(1)</script>')
  return !out.includes('<script>') && out.includes('&lt;script&gt;')
})())
check('XSS：双引号被转义', render('a "b" c').includes('&quot;'))
check('XSS：& 被转义', render('A & B').includes('&amp;'))
check('XSS：行内代码里的标签同样转义', render('`<img onerror=x>`').includes('&lt;img'))
check('XSS：代码块里的标签同样转义', render('```\n<script>\n```').includes('&lt;script&gt;'))
check('XSS：javascript: 协议不会被当链接',
  !render('[x](javascript:alert(1))').includes('href="javascript:'))

// 2) manifest 形状
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'))
check('manifest：MV3', manifest.manifest_version === 3)
check('manifest：带固定 key（扩展 ID 才稳定）',
  typeof manifest.key === 'string' && manifest.key.length > 300, `key 长度 ${manifest.key.length}`)
check('manifest：只申请 storage + contextMenus 权限',
  JSON.stringify(manifest.permissions) === JSON.stringify(['storage', 'contextMenus']),
  JSON.stringify(manifest.permissions))
check('manifest：host_permissions 覆盖本机后端',
  manifest.host_permissions.some((item) => item.indexOf('127.0.0.1:3080') >= 0),
  JSON.stringify(manifest.host_permissions))
check('manifest：后台是 service worker',
  manifest.background && manifest.background.service_worker === 'background.js')
const scripts = manifest.content_scripts[0].js
check('manifest：内容脚本顺序正确（共享作用域，markdown/styles 要先于 content）',
  scripts.indexOf('markdown.js') < scripts.indexOf('content.js') &&
  scripts.indexOf('styles.js') < scripts.indexOf('content.js'),
  JSON.stringify(scripts))

// 3) 文件与静态约定
for (const file of ['background.js', 'content.js', 'markdown.js', 'styles.js', 'options.html', 'options.js', 'README.md']) {
  check(`文件存在：${file}`, fs.existsSync(path.join(extDir, file)))
}
check('扩展 ID 文件在位', fs.existsSync(path.join(extDir, 'extension-key.txt')))

const contentSource = fs.readFileSync(path.join(extDir, 'content.js'), 'utf8')
check('content.js：界面用 Shadow DOM 隔离', contentSource.includes('attachShadow'))
check('content.js：小按钮按下时阻止默认（否则选区会消失）',
  contentSource.includes("triggerEl.addEventListener('mousedown'") && contentSource.includes('preventDefault'))
check('content.js：三档 id 齐全',
  contentSource.includes("['plain', 'general', 'pro']"))
check('content.js：认四档时代的旧值 expert', contentSource.includes('LEVEL_ALIASES'))
check('content.js：用 chunk/done/error 三种消息',
  contentSource.includes('text-explain/chunk') &&
  contentSource.includes('text-explain/done') &&
  contentSource.includes('text-explain/error'))

const bgSource = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8')
check('background.js：用 getReader 读流', bgSource.includes('getReader'))
check('background.js：请求带 stream: true', bgSource.includes('stream: true'))
check('background.js：只在后台发请求（service worker）', bgSource.includes('chrome.runtime.onMessage'))
check('background.js：点图标打开设置页', bgSource.includes('openOptionsPage'))
check('background.js：档位同样是三档', bgSource.includes("['plain', 'general', 'pro']"))

const htmlSource = fs.readFileSync(path.join(extDir, 'options.html'), 'utf8')
check('options.html：不内联脚本（MV3 CSP 禁止）', !/<script(?![^>]*\ssrc=)/i.test(htmlSource))
check('options.html：引用了 options.js', htmlSource.includes('src="options.js"'))
check('options.html：显示扩展 ID（便于登记白名单）', htmlSource.includes('extid'))

// 4) 触发方式：默认右键菜单，划词按钮可选
check('background.js：建右键菜单（只在选中文字时出现）',
  bgSource.includes('chrome.contextMenus.create') && bgSource.includes("contexts: ['selection']"))
check('background.js：默认触发方式是右键菜单',
  bgSource.includes("triggerMode: 'context-menu'"))
check('background.js：选了「划词按钮」模式就不建右键项',
  bgSource.includes("mode === 'selection-button'"))
check('background.js：右键后通知内容脚本开浮窗',
  bgSource.includes('text-explain/open'))
check('background.js：能列出三种触发方式',
  bgSource.includes('context-menu') && bgSource.includes('selection-button') && bgSource.includes('both'))
check('content.js：按设置决定要不要出小按钮',
  contentSource.includes('wantsSelectionButton'))
check('content.js：处理右键菜单来的 open 指令',
  contentSource.includes("message.type === 'text-explain/open'"))
check('content.js：设置变化时立即生效（不用刷新页面）',
  contentSource.includes('chrome.storage.onChanged'))
check('options.html：有触发方式选择，且默认项是右键菜单',
  htmlSource.includes('id="trigger"') &&
  htmlSource.includes('value="context-menu"') &&
  htmlSource.includes('value="selection-button"'))
check('options.js：保存触发方式',
  fs.readFileSync(path.join(extDir, 'options.js'), 'utf8').includes('triggerMode'))

// 4.5) 解锁划词：有的网站明文禁止选中，划不动就无从问起
check('content.js：注入解锁样式，掀掉 user-select: none',
  contentSource.includes('user-select:text !important') &&
  contentSource.includes('var UNLOCK_STYLE_ID'))
check('content.js：解锁样式排除了输入框（它们本来就能选）',
  contentSource.includes(':not(input):not(textarea)'))
check('content.js：在捕获阶段按住 selectstart 拦截器',
  contentSource.includes("window.addEventListener('selectstart'") &&
  contentSource.includes('stopImmediatePropagation'))
check('content.js：只挡拦截器、不挡默认行为（否则「不许选」照样生效）', (() => {
  const start = contentSource.indexOf('function blockSelectStart')
  if (start < 0) return false
  return !contentSource.slice(start, start + 200).includes('preventDefault')
})())
check('content.js：解锁默认开着（老设置里没这个键，也算开）',
  contentSource.includes('unlockSelection: true') &&
  contentSource.includes('stored.unlockSelection !== false'))
check('content.js：关掉之后能撤掉解锁样式（不是一掀了之）',
  contentSource.includes('function removeUnlock') && contentSource.includes('applyUnlock()'))
check('content.js：这个开关一改也立即生效',
  contentSource.includes('changes.unlockSelection'))
check('options.html：设置页有「解锁划词」开关',
  htmlSource.includes('id="unlockSelection"'))
check('options.js：读它、并且两个保存分支都带上它（否则一保存就被抹掉）', (() => {
  const src = fs.readFileSync(path.join(extDir, 'options.js'), 'utf8')
  return src.includes('unlockSelection: true') &&
    (src.match(/unlockSelection: \$\(/g) || []).length >= 2
})())

// 5) 追问、网页上下文、钉住、多轮透传
check('content.js：收集网页上下文（段落 / 标题 / 页面）',
  contentSource.includes('collectPageContext') &&
  contentSource.includes('findSurroundingParagraph') &&
  contentSource.includes('findNearestHeading'))
check('content.js：第一条消息把上下文与选中片段拼在一起',
  contentSource.includes('composeFirstMessage') && contentSource.includes('这一段的原文'))
check('content.js：交代了上下文的作用与边界（不传整页，只取所在段落）',
  contentSource.includes('MAX_PARAGRAPH_CHARS'))
check('content.js：追问维护完整对话历史',
  contentSource.includes('buildMessages') && contentSource.includes('conversation.push'))
check('content.js：提问单独成行渲染（与回答区分）',
  contentSource.includes('dsh-te-ask') && contentSource.includes('renderConversation'))
check('content.js：请求带的是 messages 数组（多轮）',
  contentSource.includes('messages: buildMessages()'))
check('content.js：有钉住开关（钉住后不随点击页面关闭）',
  contentSource.includes('pinned') && contentSource.includes('keepPinned'))
check('content.js：换档位等于用新讲法重讲第一个问题',
  contentSource.includes("conversation = [{ role: 'user', content: first }]"))
check('background.js：透传多轮 messages',
  bgSource.includes('job.messages') && bgSource.includes('var outgoing'))
check('background.js：仍兼容只给一段 text 的旧调用',
  bgSource.includes("job.text || ''"))
check('styles.js：有追问输入区与提问行的样式',
  fs.readFileSync(path.join(extDir, 'styles.js'), 'utf8').includes('dsh-te-input') &&
  fs.readFileSync(path.join(extDir, 'styles.js'), 'utf8').includes('dsh-te-ask'))

// 6) 交接：在 DSH 里开新会话 / 复制交接单
check('content.js：有交接按钮',
  contentSource.includes('dsh-te-handoff') && contentSource.includes('handoffMode'))
check('content.js：交接单写明来源页面与小节',
  contentSource.includes('划词解释 · 交接') && contentSource.includes('来源页面'))
check('content.js：交接单带上全部问答',
  contentSource.includes('**我问的**') && contentSource.includes('**解释**'))
check('content.js：交接单是待命式收尾（不复述、不展开）',
  contentSource.includes('不要总结、不要提问、不要展开'))
check('content.js：两种交接形态由设置决定（默认开新会话）',
  contentSource.includes("handoffMode: 'session'") && contentSource.includes("=== 'clipboard'"))
check('background.js：调用后端的 /new-session',
  bgSource.includes('/new-session'))
check('background.js：交接成功后把 DSH 页面切到前台',
  bgSource.includes('focusDsh') && bgSource.includes('chrome.tabs.query'))
check('options.html：交接方式在「高级设置」里，且默认折叠',
  htmlSource.includes('id="handoff"') && htmlSource.includes('<details'))
check('options.html：两个选项是「开新会话」与「复制交接单」',
  htmlSource.includes('value="session"') && htmlSource.includes('value="clipboard"'))
check('options.js：保存交接方式',
  fs.readFileSync(path.join(extDir, 'options.js'), 'utf8').includes('handoffMode'))
check('styles.js：有交接按钮的样式',
  fs.readFileSync(path.join(extDir, 'styles.js'), 'utf8').includes('dsh-te-handoff'))

// 7) 语境显示：显示与发送分离，且默认折叠（回归断言）
check('content.js：显示与发送分离——显示原文，发送才带上下文',
  contentSource.includes('full: composeFirstMessage') &&
  contentSource.includes('message.full || message.content'))
check('content.js：语境默认折叠（details / summary）',
  contentSource.includes('<details class="dsh-te-ctx">') && contentSource.includes('语境：'))
check('content.js：不再把整段上下文当用户提问渲染',
  !contentSource.includes("conversation[0].content = composeFirstMessage"))
check('styles.js：折叠摘要单行省略、展开区限高可滚',
  fs.readFileSync(path.join(extDir, 'styles.js'), 'utf8').includes('dsh-te-ctx summary') &&
  fs.readFileSync(path.join(extDir, 'styles.js'), 'utf8').includes('dsh-te-ctx-line'))

// 8) Firefox：源码共用，只换一份 manifest
const firefoxManifestPath = path.join(extDir, 'manifest.firefox.json')
check('Firefox：仓库里有 manifest.firefox.json', fs.existsSync(firefoxManifestPath))
if (fs.existsSync(firefoxManifestPath)) {
  const firefoxManifest = JSON.parse(fs.readFileSync(firefoxManifestPath, 'utf8'))
  check('Firefox：后台写成 background.scripts（Firefox 不支持 service_worker）',
    Array.isArray(firefoxManifest.background.scripts) &&
    firefoxManifest.background.service_worker === undefined,
    JSON.stringify(firefoxManifest.background))
  check('Firefox：带 gecko id（用于记住权限与更新）',
    Boolean(firefoxManifest.browser_specific_settings &&
      firefoxManifest.browser_specific_settings.gecko &&
      firefoxManifest.browser_specific_settings.gecko.id),
    JSON.stringify(firefoxManifest.browser_specific_settings))
  check('Firefox：其余关键字段与 Chrome 版逐字一致（所以源码能共用）',
    firefoxManifest.manifest_version === manifest.manifest_version &&
    JSON.stringify(firefoxManifest.permissions) === JSON.stringify(manifest.permissions) &&
    JSON.stringify(firefoxManifest.host_permissions) === JSON.stringify(manifest.host_permissions) &&
    JSON.stringify(firefoxManifest.content_scripts) === JSON.stringify(manifest.content_scripts))
  check('Firefox：设置页用 browser_style 贴合原生外观',
    Boolean(firefoxManifest.options_ui && firefoxManifest.options_ui.browser_style === true))
}
check('Firefox：仓库里有生成脚本（可重复执行）',
  fs.existsSync(path.join(extDir, 'build-firefox-manifest.cjs')))

// 9) 「联网搜索」按钮：强制触发一次联网
check('content.js：有「联网搜索」按钮',
  contentSource.includes('🌐 联网搜索') && contentSource.includes('forceWebSearch'))
check('content.js：强制联网时**折叠**旧回答而不是删掉（用户还能翻回去看）',
  contentSource.includes('superseded = true') &&
  contentSource.includes('上一次的回答（点开查看）') &&
  !contentSource.includes('conversation.pop()'))
check('content.js：强制联网会补一条明确指令（历史末尾仍是 user）',
  contentSource.includes('请联网查证后补充'))
check('content.js：这一轮是解释还是追问，由前端显式声明',
  contentSource.includes("var pendingTurn = 'explain'") &&
  contentSource.includes("pendingTurn = 'followup'") &&
  contentSource.includes('turn: turnForThisRequest'))
check('background.js：把 turn 透传给后端',
  bgSource.includes('turn: message.turn') && bgSource.includes('dshBody.turn = job.turn'))
check('content.js：请求带上 forceTool',
  contentSource.includes('forceTool: forceToolForThisRequest'))
check('content.js：等联网时状态文案会变（让用户知道它在查）',
  contentSource.includes('正在联网查'))
check('background.js：透传 forceTool',
  bgSource.includes('job.forceTool'))
check('background.js：没设 forceTool 时不发该字段（请求保持干净）',
  bgSource.includes('if (forceTool !== null) dshBody.forceTool = forceTool'))

// 10) 扩展页上的「未检查的错误」：sendMessage 失败时要读 lastError
check('background.js：每处 tabs.sendMessage 都配了 lastError 检查',
  (bgSource.match(/tabs\.sendMessage/g) || []).length <=
  (bgSource.match(/runtime\.lastError/g) || []).length,
  `sendMessage ${(bgSource.match(/tabs\.sendMessage/g) || []).length} 处 / lastError ${(bgSource.match(/runtime\.lastError/g) || []).length} 处`)

// 11) 双模式：本机 DSH 或自己的 OpenAI 兼容接口
const optionsSource = fs.readFileSync(path.join(extDir, 'options.js'), 'utf8')
check('manifest：声明了可选主机权限（自定义后端按域名逐次申请）',
  Array.isArray(manifest.optional_host_permissions) &&
  manifest.optional_host_permissions.length > 0,
  JSON.stringify(manifest.optional_host_permissions))
check('options.html：有「本机 DSH / 我自己的 API」二选一',
  htmlSource.includes('backend-dsh') && htmlSource.includes('backend-custom'))
check('options.html：自定义模式有地址 / 模型 / Key 三个输入',
  htmlSource.includes('id="customBaseUrl"') &&
  htmlSource.includes('id="customModel"') &&
  htmlSource.includes('id="customApiKey"'))
check('options.html：有常用服务预设下拉', htmlSource.includes('id="preset"'))
check('options.html：两个兼容性开关（并 system / 关流式）',
  htmlSource.includes('customSystemMerged') && htmlSource.includes('customNoStream'))
check('options.html：交接方式仍保留在高级设置里',
  htmlSource.includes('id="handoff"') && htmlSource.includes('value="clipboard"'))
check('options.js：保存会申请该域名的权限（不预先索取全网）',
  optionsSource.includes('ensureOriginPermission') && optionsSource.includes('permissions.request'))
check('options.js：预设含各家服务与本机模型',
  optionsSource.includes('api.deepseek.com') &&
  optionsSource.includes('api.openai.com') &&
  optionsSource.includes('localhost:11434') &&
  optionsSource.includes('localhost:1234'))
check('background.js：自定义模式走用户自己的地址、模型与 Key',
  bgSource.includes('customBaseUrl') &&
  bgSource.includes('customModel') &&
  bgSource.includes("'Bearer ' + apiKey"))
check('background.js：免费模式与「自己的 API」共用一套拼装（设置里已把地址模型落进 custom*）',
  bgSource.includes("settings.backend === 'custom' || settings.backend === 'free'"))
check('background.js：免费模式优先用 freeApiKey',
  bgSource.includes("settings.backend === 'free' && settings.freeApiKey"))
check('background.js：免费模式不发 forceTool（联网不是第三方接口的能力）',
  bgSource.includes("if (settings.backend === 'custom' || settings.backend === 'free') {") &&
  !/backend !== 'custom'/.test(bgSource))
check('background.js：自带内置三档讲法（自定义模式用）',
  bgSource.includes('LEVEL_PROMPTS') &&
  bgSource.includes('plain:') &&
  bgSource.includes('general:') &&
  bgSource.includes('pro:') &&
  bgSource.includes('把读者当成同行'))
check('设置页：后端是三选一（DSH / 免费模型 / 自己的 API）',
  htmlSource.includes('id="backend-dsh"') &&
  htmlSource.includes('id="backend-free"') &&
  htmlSource.includes('id="backend-custom"'))
check('设置页：免费模式有服务下拉、Key 输入与申请按钮',
  htmlSource.includes('id="free-pick"') &&
  htmlSource.includes('id="free-key"') &&
  htmlSource.includes('id="free-apply"'))
check('免费服务表：智谱 Flash 排第一且标明免费',
  optionsSource.includes("id: 'zhipu-flash'") &&
  optionsSource.includes('glm-4.7-flash') &&
  optionsSource.includes('免费'))
check('免费服务表：至少覆盖 5 家（含本机 Ollama）',
  (optionsSource.match(/id: '(zhipu-flash|qwen|ollama|gemini|groq|openrouter)'/g) || []).length >= 5)
check('设置页诚实说明：我们不代付、不中转，Key 要用户自己申请',
  htmlSource.includes('我们不经手中转、也不代你付费') ||
  htmlSource.includes('不经手中转'))
check('background.js：支持关流式（少数服务不支持 SSE）',
  bgSource.includes('target.stream === false'))
check('content.js：非 DSH 模式（自己的 API / 免费模型）都不建「联网搜索」按钮',
  contentSource.includes("backendMode === 'dsh' ? document.createElement('button') : null"))
check('content.js：只有 DSH 模式才显示「在 DSH 里继续」',
  contentSource.includes("backendMode === 'dsh' ? '在 DSH 里继续' : '复制交接单'"))
check('content.js：交接按钮有初始文字（曾经漏过，是空白的）',
  contentSource.includes('handoffEl.textContent = backendMode ==='))
check('content.js：读完设置后会认「免费模型」这种后端',
  contentSource.includes("stored.backend === 'custom' || stored.backend === 'free'"))

// 12) 右键菜单：必须串行创建，否则会撞 "duplicate id"
check('background.js：右键菜单串行创建（service worker 冷启动 + onInstalled 会并发）',
  bgSource.includes('var menuChain = Promise.resolve()') &&
  bgSource.includes('menuChain = menuChain.then'))
check('background.js：contextMenus.create 之后读了 lastError',
  /contextMenus\.create\([\s\S]{0,500}?lastError/.test(bgSource))

const failed = results.filter((item) => !item.ok)
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length === 0 ? 0 : 1)
