# Text Explain — 浏览器扩展

划中网页上任何一段看不懂的话，本地 DSH 用大白话讲给你听；可以接着追问，也能把它交给 DSH 里继续。与 DSH 插件「划词解释」共用同一套后端和同一套三档讲法。

## 安装（未打包，开发者模式）

1. 打开 `chrome://extensions/`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本目录（`dsh-text-explain/extension`）

> Edge 同理：`edge://extensions/`。
> 注意选**本目录这一层**（里面有 `manifest.json`），不要选它的上一级。

装好后它的 ID 应当是 **`flllhbaameongigaidcdonkdinpajaid`**（由 `manifest.json` 里的 `key` 固定，换机器也不变）。

## 在 Firefox 上用

**源码完全共用**——因为 Firefox 也支持 `chrome.*` 这套命名。唯一的硬差异在 manifest 的后台写法：

| | Chrome / Edge（MV3） | Firefox（MV3） |
| --- | --- | --- |
| 后台 | `"service_worker": "background.js"` | `"scripts": ["background.js"]` |

所以本目录里有两份 manifest：`manifest.json`（Chrome/Edge 用）与 `manifest.firefox.json`（Firefox 用，由 `node extension/build-firefox-manifest.cjs extension` 生成）。

**试用（立刻能跑）**：

1. 打开 `about:debugging#/runtime/this-firefox`
2. 点 **临时载入附加组件**
3. 选中本目录里的 **`manifest.firefox.json`**

> ⚠️ 临时载入的扩展**关闭浏览器就没了**——只适合试用与调试。

**正式发布**：上架 [AMO（addons.mozilla.org）](https://addons.mozilla.org/developers/)——**免费**，审核通常几小时到几天。打包时把 `manifest.firefox.json` **改名成 `manifest.json`** 再压成 zip 上传（其余文件照旧）。

## 打包成 zip

```powershell
# 1) 生成 Firefox 版 manifest
node extension/build-firefox-manifest.cjs extension

# 2) 各打一份：Firefox 那份记得把 manifest.firefox.json 改名成 manifest.json
Compress-Archive -Path extension\* -DestinationPath dist\text-explain-firefox.zip -Force
```

## 用法

**默认走右键菜单**（日常浏览最不打扰）：

> 选中一段文字 → **右键** → **「用大白话解释『…』」** → 浮窗里流式出解释

浮窗里可以：

| 操作 | 说明 |
| --- | --- |
| **追问** | 底部输入框回车即可多轮追问；模型记得前面聊过什么 |
| **切档位** | 顶部 小白 / 通识 / 专业 —— 切了会**用新讲法重讲第一个问题** |
| **📌 钉住** | 点一下，浮窗**不再随点击页面而关闭**（只认 `Esc` 或 `×`）——防止误触 |
| **关闭** | `Esc` 或右上角 `×` |

若您更想要「划词就冒按钮」，到设置里把**触发方式**改成「划词后浮出小按钮」或「两者都要」。

## 网页上下文（它凭什么看懂「它」）

单独看一句「它指的是这个」，谁也不知道「它」是什么。所以打开浮窗时，扩展会顺手取三样东西，拼在**第一条消息**里一起发给模型：

| 取什么 | 作用 |
| --- | --- |
| **所在段落的原文**（上限 1200 字） | 让模型看出「它 / 这个」指什么 |
| **最近的上级标题**（h1–h6） | 一句话说明这一节在讲什么 |
| **页面标题 ＋ 网址** | 定位出处 |

**只取选区附近那一小段，不传整个网页。**

## 设置

点扩展图标（或扩展详情页的「扩展程序选项」）打开设置页：

| 项 | 说明 |
| --- | --- |
| **什么时候出来** | `只在右键菜单里`（默认）／`划词后浮出小按钮`／`两者都要` |
| **本机后端地址** | 默认 `http://127.0.0.1:3080/api/text-explain/v1` |
| **默认讲法** | 三档之一；浮窗里仍可临时切换 |
| **测试连接** | 当场打一次 `/models`，一眼看出后端通不通 |

改设置**立即生效**，不用刷新页面。

## 它是怎么工作的

```
网页 ──划词/右键──► content.js（Shadow DOM 浮窗）
                       ├─ 收集网页上下文（段落/标题/页面）
                       ├─ 维护对话历史（追问）
                       │  chrome.runtime.sendMessage
                       ▼
                   background.js（service worker）
                       ├─ chrome.contextMenus 右键菜单
                       └─ 发 fetch：POST /chat/completions (stream)
                       ▼
                   本机 DSH 的 dsh-text-explain 插件
                       │  SSE 分片
                       ▼
                   浮窗逐片渲染（markdown.js）
```

### 四个关键设计

**① 请求在 background 里发，不在页面里发。**
内容脚本跑在网页自己的来源下，它发的 `fetch` 会带上那个网站的 `Origin`，被浏览器的跨源策略拦下（我们不可能、也不该把全网加进后端白名单）。service worker 的 `fetch` 带的是扩展自己的来源，配合 `host_permissions` 即可直连本机后端。

**② 界面放在 Shadow DOM 里。**
既不让页面的 CSS 污染浮窗，也不把我们的样式洒进别人的页面。

**③ 渲染前先转义 HTML。**
浮窗里的文字来自模型，而模型看到的是网页内容——不转义就等于把任意网页内容当 HTML 执行。

**④ 上下文只取局部。**
目标是让模型看懂那一句话，不是把用户在看什么整个交出去。

## 后端白名单

由于走的是 service worker + `host_permissions`，通常**不需要**登记来源。若 DSH 端返回 `origin not allowed`，把扩展 ID 按下面格式加进 `<DSH_HOME>/text-explain/settings.json`：

```json
"allowedOrigins": ["chrome-extension://flllhbaameongigaidcdonkdinpajaid"]
```

该文件**改完即刻生效**，不必重启 DSH。

## 安全

- 扩展只申请 `storage` 与 `contextMenus` 权限，以及 `127.0.0.1:3080` 的访问权；不读取、不外传任何网页数据。
- **永远不提供「读本地文件」能力**：网页内容是不可信输入，一旦与本地文件读取同处一个上下文，就是提示注入的入口。
- 落盘内容只有三项偏好（触发方式、后端地址、默认讲法）。
