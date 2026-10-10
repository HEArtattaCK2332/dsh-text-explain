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

const failed = results.filter((item) => !item.ok)
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length === 0 ? 0 : 1)
