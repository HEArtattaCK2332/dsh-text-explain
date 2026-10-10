# Text Explain — 浏览器扩展

划中网页上任何一段看不懂的话，本地 DSH 用大白话讲给你听。与 DSH 插件「划词解释」共用同一套后端和同一套三档讲法。

## 安装（未打包，开发者模式）

1. 打开 `chrome://extensions/`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本目录（`dsh-text-explain/extension`）

> Edge 同理：`edge://extensions/`。

装好后它的 ID 应当是 **`flllhbaameongigaidcdonkdinpajaid`**（由 `manifest.json` 里的 `key` 固定，换机器也不变）。

## 用法

1. 在任意网页上**选中**一段文字
2. 选区下方会出现小按钮 **✦ 解释**，点它
3. 浮窗里流式显示解释；顶部可随时切 **小白 / 通识 / 专业**，切了就当场重讲
4. `Esc` 或点页面别处关闭

## 设置

点扩展图标（或扩展详情页的「扩展程序选项」）打开设置页：

| 项 | 说明 |
| --- | --- |
| **本机后端地址** | 默认 `http://127.0.0.1:3080/api/text-explain/v1` |
| **默认讲法** | 三档之一；浮窗里仍可临时切换 |
| **测试连接** | 当场打一次 `/models`，一眼看出后端通不通 |

## 它是怎么工作的

```
网页 ──划词──► content.js（Shadow DOM 浮窗）
                  │  chrome.runtime.sendMessage
                  ▼
              background.js（service worker，发 fetch）
                  │  POST /chat/completions  (stream: true)
                  ▼
              本机 DSH 的 dsh-text-explain 插件
                  │  SSE 分片
                  ▼
              浮窗逐片渲染（markdown.js）
```

### 两个关键设计

**① 请求在 background 里发，不在页面里发。**
内容脚本跑在网页自己的来源下，它发的 `fetch` 会带上那个网站的 `Origin`，被浏览器的跨源策略拦下（我们不可能、也不该把全网加进后端白名单）。service worker 的 `fetch` 带的是扩展自己的来源，配合 `host_permissions` 即可直连本机后端。

**② 界面放在 Shadow DOM 里。**
既不让页面的 CSS 污染浮窗，也不把我们的样式洒进别人的页面。

## 后端白名单

由于走的是 service worker + `host_permissions`，通常**不需要**登记来源。若 DSH 端返回 `origin not allowed`，把扩展 ID 按下面格式加进 `<DSH_HOME>/text-explain/settings.json`：

```json
"allowedOrigins": ["chrome-extension://flllhbaameongigaidcdonkdinpajaid"]
```

该文件**改完即刻生效**，不必重启 DSH。

## 安全

- `markdown.js` 渲染前**先转义 HTML**：浮窗里的文字来自模型，而模型看到的又是网页内容——不转义就等于把任意网页内容当 HTML 执行。
- 扩展只申请了 `storage` 权限与 `127.0.0.1:3080` 的访问权，不读取、不外传任何网页数据。
