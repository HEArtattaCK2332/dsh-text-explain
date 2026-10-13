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
    strict_min_version: '115.0',
    // ⚠️ AMO 自 2025-11-03 起强制要求声明「数据收集与传输」，缺了它上传会被直接拒绝：
    //    The "data_collection_permissions" property is missing.
    //
    // 为什么声明 websiteContent 而不是 none：
    //   本扩展**不向开发者或任何第三方收集数据**（我们没有服务器）；
    //   但用户点「解释」时，**选中的网页文字**会发到**他自己配置的后端**
    //   （本机 DeepSeek Harness，或他填的 OpenAI 兼容接口）。
    //   按 Mozilla 的定义，这属于「传输到扩展之外交由外部处理」，故如实声明。
    //   宁可多声明，不可漏声明——漏声明是违规，多声明只是啰嗦。
    data_collection_permissions: {
      required: ['websiteContent']
    }
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
