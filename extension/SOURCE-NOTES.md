# 源码说明（给 Mozilla 审核员）

**简短回答**：扩展里的 **JavaScript / HTML / CSS 全部是手写的，未压缩、未打包、未用模板引擎**。
唯一「生成」出来的是 **`manifest.json`**（Firefox 版那一份），由一个几十行的 Node 脚本从 Chrome 版转换而来——
原因见下。除此之外没有任何构建步骤。

---

## 1. 为什么会有「生成的文件」

Chrome 与 Firefox 的 MV3 **只差一个字段**：

| | Chrome / Edge | Firefox |
| --- | --- | --- |
| 后台脚本写法 | `background.service_worker` | `background.scripts`（Firefox 不支持前者） |

为了不让两份 manifest **各自漂移**（曾经发生过：一次提交后两边版本号分别停在 0.3.0 与 0.4.0），
我们用一个小脚本**从 Chrome 版生成 Firefox 版**，而不是维护两份手写文件。

**生成脚本**：`extension/build-firefox-manifest.cjs`

它是纯 Node 脚本，逻辑就是：读 `extension/manifest.json` → 改掉 `background` 字段 →
补上 Firefox 需要的 `browser_specific_settings.gecko`（含扩展 ID 与
`data_collection_permissions` 声明）→ 写出 `extension/manifest.firefox.json`。

**复现方式**（在仓库根目录）：

```bash
node extension/build-firefox-manifest.cjs extension
```

生成的 `manifest.firefox.json` 内容**完全可读**（普通 JSON），审核员可直接查看，
不需要运行任何东西来理解它。

## 2. 图标也是脚本生成的

`extension/icons/icon{16,32,48,128}.png` 由 `make-icons.cjs` 生成——**不依赖任何绘图库**，
直接写 PNG 字节（zlib 压缩＋CRC 校验），4 倍超采样做抗锯齿。

**为什么这样做**：避免为了四个图标引入 ImageMagick / sharp 之类的依赖。
图标是**二进制图片**，不含可执行代码。

## 3. 扩展包里的文件，逐个说明来源

| 文件 | 来源 |
| --- | --- |
| `manifest.json` | Firefox 版：由上面的脚本生成；Chrome 版：手写 |
| `background.js` | **手写** |
| `content.js` | **手写** |
| `styles.js` | **手写**（一个把 CSS 字符串注入 Shadow DOM 的函数，非模板引擎） |
| `markdown.js` | **手写**（极简 Markdown 渲染，先转义 HTML 再套标记） |
| `options.html` | **手写** |
| `options.js` | **手写** |
| `icons/*.png` | 由脚本生成的二进制图片 |

**没有**：webpack / rollup / esbuild / Babel / TypeScript / Sass / 任何压缩或混淆。
**没有**：远程加载的代码、`eval`、动态生成的函数。

## 4. 数据与网络行为（便于审核）

- **不向开发者或任何第三方发送数据**；我们没有服务器。
- 用户点击「解释」时，**选中的网页文字**会发送到**用户自己配置的后端**，三选一：
  1. 本机运行的 DeepSeek Harness（`http://127.0.0.1:3080`）；
  2. 用户自己申请的免费服务商（如智谱、通义千问、Gemini、Groq、OpenRouter）；
  3. 用户自己填写的任意 OpenAI 兼容接口。
- **设置（含 API Key）**只存在浏览器本地存储。
- `data_collection_permissions` 如实声明为 `websiteContent`，正是基于上述第 2 点。

## 5. 仓库

完整源码、提交历史与构建脚本：

<https://github.com/HEArtattaCK2332/dsh-text-explain>

扩展部分在 `extension/` 目录，无需构建即可加载（这正是我们刻意保持的：
**审核员与用户看到的就是我们写的**）。
