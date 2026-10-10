// 生成 Firefox 版的 manifest（manifest.firefox.json）。
//
// 为什么不能与 Chrome 共用一份：Chrome 的 MV3 只认 `background.service_worker`，
// Firefox 的 MV3 只认 `background.scripts`（它至今以事件页面为主）。
// 其余字段两边一致——所以**源码完全共用**，只在打包时换一份 manifest。
//
// 用法（在仓库根目录）：
//   node extension/build-firefox-manifest.cjs extension
// 然后打包：
//   zip 两份各自的目录内容，Firefox 那份用 manifest.firefox.json 改名成 manifest.json
const fs = require('node:fs')
const path = require('node:path')

const dir = process.argv[2] || path.join(__dirname)
const chromePath = path.join(dir, 'manifest.json')
if (!fs.existsSync(chromePath)) {
  console.error('找不到 manifest.json（先跑 gen 脚本生成 Chrome 版）')
  process.exit(1)
}

const chrome = JSON.parse(fs.readFileSync(chromePath, 'utf8'))
const firefox = Object.assign({}, chrome)

// 关键差异：后台用事件页面脚本，而不是 service worker
firefox.background = { scripts: ['background.js'] }

// Firefox 要求扩展有个稳定的 id（用于记住权限与更新）
firefox.browser_specific_settings = {
  gecko: {
    id: 'text-explain@heartattack2332.github.io',
    strict_min_version: '115.0'
  }
}

// Firefox 里让设置页贴合原生外观
if (firefox.options_ui) {
  firefox.options_ui = Object.assign({}, firefox.options_ui, { browser_style: true })
}

fs.writeFileSync(
  path.join(dir, 'manifest.firefox.json'),
  JSON.stringify(firefox, null, 2) + '\n',
  'utf8'
)
console.log('manifest.firefox.json 已生成；后台写法：background.scripts（Firefox 不支持 service_worker）')
