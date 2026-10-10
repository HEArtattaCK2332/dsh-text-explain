# Text Explain — 浏览器扩展

划中网页上任何一段看不懂的话，本地 DSH 用大白话讲给你听。与 DSH 插件「划词解释」共用同一套后端和同一套三档讲法。

## 安装（未打包，开发者模式）

1. 打开 `chrome://extensions/`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本目录（`dsh-text-explain/extension`）

> Edge 同理：`edge://extensions/`。
> 注意选**本目录这一层**（里面有 `manifest.json`），不要选它的上一级。

装好后它的 ID 应当是 **`flllhbaameongigaidcdonkdinpajaid`**（由 `manifest.json` 里的 `key` 固定，换机器也不变）。

## 用法

**默认走右键菜单**（日常浏览最不打扰）：

> 选中一段文字 → **右键** → **「用大白话解释『…』」** → 浮窗里流式出解释

若您更想要「划词就冒按钮」，到设置里把**触发方式**改成「划词后浮出小按钮」或「两者都要」。

浮窗里可以：顶部切 **小白 / 通识 / 专业**（切了**当场重讲**）；`Esc` 或点页面别处关闭。

## 设置

点扩展图标（或扩展详情页的「扩展程序选项」）打开设置页：

| 项 | 说明 |
| --- | --- |
| **什么时候出来** | `只在右键菜单里`（默认）／`划词后浮出小按钮`／`两者都要` |
| **本机后端地址** | 默认 `http://127.0.0.1:3080/api/text-explain/v1` |
| **默认讲法** | 三档之一；浮窗里仍可临时切换 |
| **测试连接** | 当场打一次 `/models`，一眼看出后端通不通 |

> 改了触发方式**立即生效**，不用刷新页面（扩展会重建右键菜单、并即时切换划词按钮的开关）。

## 它是怎么工作的

```
网页 ──划词/右键──► content.js（Shadow DOM 浮窗）
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

### 三个关键设计

**① 请求在 background 里发，不在页面里发。**
内容脚本跑在网页自己的来源下，它发的 `fetch` 会带上那个网站的 `Origin`，被浏览器的跨源策略拦下（我们不可能、也不该把全网加进后端白名单）。service worker 的 `fetch` 带的是扩展自己的来源，配合 `host_permissions` 即可直连本机后端。

**② 界面放在 Shadow DOM 里。**
既不让页面的 CSS 污染浮窗，也不把我们的样式洒进别人的页面。

**③ 渲染前先转义 HTML。**
浮窗里的文字来自模型，而模型看到的是网页内容——不转义就等于把任意网页内容当 HTML 执行。

## 后端白名单

由于走的是 service worker + `host_permissions`，通常**不需要**登记来源。若 DSH 端返回 `origin not allowed`，把扩展 ID 按下面格式加进 `<DSH_HOME>/text-explain/settings.json`：

```json
"allowedOrigins": ["chrome-extension://flllhbaameongigaidcdonkdinpajaid"]
```

该文件**改完即刻生效**，不必重启 DSH。

## 安全

- 扩展只申请 `storage` 与 `contextMenus` 权限，以及 `127.0.0.1:3080` 的访问权；不读取、不外传任何网页数据。
- 落盘内容只有三项偏好（触发方式、后端地址、默认讲法）。
