# 三家商店上架材料

> 这份是**提交时照着抄**的东西。三家要求的字段大同小异，主要材料在 §1、§2、§3，直接粘贴即可。
>
> **先做 §0**（把安装包挂到 Release），再按 §4 挑要上的商店。

---

## 0. 把两个 zip 挂到 Release（GitHub 网页操作，约 1 分钟）

扩展的安装包已经在本地打好，但**我用的接口只能传 JSON、传不了二进制文件**，所以这一步要您动手（也是唯一必须动手的一步）：

1. 打开 <https://github.com/HEArtattaCK2332/dsh-text-explain/releases/tag/v0.4.0> → 点右上 **Edit release**
2. 找到页面下方 **Attach binaries by dropping them here** 的区域
3. 把下面两个文件**拖进去**（资源管理器地址栏粘贴路径即可打开所在目录）：

   ```
   E:\DSH-cj\dsh-text-explain\dist\text-explain-chrome.zip
   E:\DSH-cj\dsh-text-explain\dist\text-explain-firefox.zip
   ```

4. 点 **Update release**

> 拖拽期间它会自动上传，等两个文件名都出现在列表里就好了。上传完，别人（没有 VPN 的人）也能从 Release 页直接下载。

---

## 1. 通用材料（三家一样，直接粘）

**名称**（Chrome 上限 45 字符）

```
Text Explain — 划词解释
```

**一句话简介**（Chrome 上限 132 字符）

```
选中一段话，右键就得到讲解；讲多浅多深由你挑，还能追问、联网查证、把整段问答交给 AI 继续。
```

**详细描述**

```
读文章遇到看不懂的段落，以前要复制、切到 AI、粘贴、再补一句「讲浅一点」——来回好几步。
这个扩展把这条路缩成一步：选中 → 右键 → 出结果。

它自带三档讲法，因为「不懂」也分深浅：
· 小白 —— 完全不懂 AI、不懂代码的人
· 通识 —— 会用电脑、有常识，但没学过这一行
· 专业 —— 同行：术语直接用，讲机制、取舍与边界
浮窗里能随手切档，切了当场重讲同一句。

还有这些：
· 追问 —— 带着上下文接着问，不必重述背景
· 网页语境 —— 自动附上所在小节的标题与段落，折叠显示不占地方
· 联网 / 本地查证 —— 让它当场查一趟，查完只补充新东西；查不到会明说「我查了但没找到」
· 一次答不满意？换档或联网后，上一次的回答会折叠保留，可对照不丢
· 交接 —— 把整段问答整理成 Markdown，开一个新会话悄悄放好

三种连法，按你的情况挑：

· 免费模型（最省事）—— 用服务商提供的免费额度。地址与模型名都替你配好了，
  你只要去官网申请一个免费 Key 粘进来。推荐智谱 GLM-4.7-Flash（长期 0 元、国内直连）；
  也可选通义千问、Gemini、Groq、OpenRouter，或本机的 Ollama / LM Studio。
  注意：免费服务通常会用你的数据改进模型，介意就用下面两种。
· 本机 DeepSeek Harness —— 连着电脑上的 DSH 插件，能用它的联网与本地查找。
· 我自己的 API —— 接任意 OpenAI 兼容接口。这个模式完全不需要安装别的东西。

（三档讲法在三种模式下都一样：小白 / 通识 / 专业。）

默认只在右键菜单里出现，不打扰您读文章；也可以改成「划词浮出小按钮」。

Select some text and get an explanation pitched at the right depth. Three levels,
switchable mid-conversation; follow-up questions that keep context; automatic page
context; optional web or local lookup that says so when it finds nothing; the previous
answer kept (collapsed) rather than discarded; and whole-thread handoff to a new
session. Works against local DeepSeek Harness, or against your own OpenAI-compatible API.
```

**分类**：`生产力` / `Productivity`（Firefox 选「其他」或「生产力」）

**语言**：中文（简体）；若可多选，加 English

---

## 2. 权限说明（Chrome / Edge 审核会逐条看，照抄即可）

| 权限 | 为什么需要 |
| --- | --- |
| `storage` | 保存您自己的设置（默认讲法、后端地址、API Key 等），**只存在本机浏览器里** |
| `contextMenus` | 提供「用大白话解释『选中的文字』」这个右键菜单项。这是本扩展的主要入口 |
| `http://127.0.0.1:3080/*`、`http://localhost:3080/*` | 与**本机**运行的 DeepSeek Harness 通信（它监听在本机 3080 端口）。仅回环地址，不涉及外部网络 |
| `https://*/*`、`http://*/*`（**可选**） | 仅当您选择「免费模型」或「我自己的 API」、并实际连到某个服务商域名时，浏览器才**当场**询问是否授权**那一个域名**。扩展不会预先获得全网权限 |

> **说明**：`optional_host_permissions` 是刻意这样设计的——避免「一装上就要求访问所有网站」。不填自定义地址的用户，**永远不会看到这个授权请求**。

---

## 3. 隐私（Chrome 的「隐私实践」问卷，照这个填）

| 问题 | 答案 |
| --- | --- |
| 是否收集或使用用户数据？ | **否**（不收集、不传输到任何服务器） |
| 是否使用远程代码？ | **否**（所有代码都在安装包内） |
| 是否出售数据给第三方？ | **否** |
| 是否用于确定信用度或放贷？ | **否** |

**隐私政策说明**（若商店要求填一个说明，可用这段）

```
本扩展不收集、不存储、不传输任何用户数据到开发者或第三方服务器。

您选中的文字只会在您主动点击「解释」时，发送到以下两者之一：
1) 您本机运行的 DeepSeek Harness（127.0.0.1:3080），或
2) 您在设置中自己填写的 API 地址（例如您自己的 DeepSeek / OpenAI 账号）。

设置（含 API Key，若填写）通过浏览器扩展存储保存在本机，不会上传。
本扩展不使用任何远程加载的代码。
```

---

## 4. 三家各自怎么提

### Chrome Web Store（先上这家）

- **费用**：一次性 **$5**（约 ¥36），之后无年费
- **地址**：<https://chrome.google.com/webstore/devconsole>
- **步骤**：用 Google 账号登录 → 付 $5 → 「新增项目」→ 上传 `text-explain-chrome.zip` → 填 §1 文案 → 填 §2 权限说明与 §3 隐私问卷 → 上传截图 → 提交审核
- **审核时间**：通常 **1–3 个工作日**（新账号首次可能更久）

### Microsoft Edge Add-ons（建议第二家，免费）

- **费用**：**免费**
- **地址**：<https://partner.microsoft.com/dashboard/microsoftedge>
- **步骤**：用 Microsoft 账号登录 → 注册开发者 → 「新建扩展」→ **上传同一个 `text-explain-chrome.zip`**（Chrome 的包 Edge 直接能用）→ 填同样文案 → 提交
- **审核时间**：通常 1–7 个工作日

### Firefox Add-ons（AMO，免费）

- **费用**：**免费**
- **地址**：<https://addons.mozilla.org/developers/>
- **步骤**：登录 → 「提交新附加组件」→ **上传 `text-explain-firefox.zip`**（注意用 Firefox 那份，manifest 里是 `background.scripts`）→ 选「自己托管/在 AMO 上架」→ 填文案 → 提交
- **审核**：首次通常几小时到几天。若是「On this site」上架，会自动签名

> ⚠️ **别弄混**：Chrome / Edge 用 `chrome.zip`，**Firefox 用 `firefox.zip`**。两份的 `manifest.json` 不同（Firefox 不支持 `service_worker`）。

---

## 5. 截图与宣传图

**截图**（三家都要至少 1 张）

| 商店 | 尺寸要求 |
| --- | --- |
| Chrome | **1280×800** 或 640×400（PNG/JPEG） |
| Edge | 1280×800 或 640×400 |
| Firefox | 宽度 320–1920，比例大致 16:10 |

**怎么截**（最省事的办法）：

1. 在 Chrome 里装好扩展，随便打开一篇有文字的文章
2. 划一段话 → 右键 → **解释** → 等浮窗出结果
3. 按 <kbd>Win</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> 框选**包含浮窗与原文**的区域
4. 存成 PNG，尺寸不符时用「画图」缩放/裁剪成 1280×800

**拍哪几张**（建议 3 张）：① 浮窗解释效果（含三档按钮）② 追问中的样子 ③ 设置页（展示三种后端与免费模型的预设清单）

**宣传图（可选）**：Chrome 的小宣传图 440×280；Edge 无硬性要求；Firefox 无硬性要求。

---

## 6. 提交前自检

- [ ] 两个 zip 已挂到 Release（§0）
- [ ] `manifest.json` 版本号与 Release 标签一致（现为 **0.4.0**）
- [ ] 图标齐全（16/32/48/128，已在包内 `icons/`）
- [ ] 名称、简介、描述已复制（§1）
- [ ] 权限逐条说明已填（§2）
- [ ] 隐私问卷已填（§3）
- [ ] 至少 1 张截图，尺寸达标（§5）
- [ ] 包内**没有**开发文件（`build-firefox-manifest.cjs`、`manifest.firefox.json`、`extension-key.txt` 都不在包里 ✓ 已核）

---

## 附：为什么两份包不一样

| | Chrome / Edge | Firefox |
| --- | --- | --- |
| 后台脚本写法 | `background.service_worker` | `background.scripts`（Firefox 不支持前者） |
| 生成方式 | 手写 `manifest.json` | `node extension/build-firefox-manifest.cjs` 从前者生成（版本号同步，避免漂移） |
| 其余源码 | 完全相同（Firefox 也实现了 `chrome.*` 命名空间） |
