# 用命令行调用划词解释（给 Codex 等工具）

> **一句话**：本插件在本机开了一个 **OpenAI 兼容**的接口，所以**任何能发 HTTP 请求的地方**（终端、Codex、VS Code 任务、批处理脚本）都能拿它来解释一段文字——不需要装浏览器扩展，也不需要额外写代码。

---

## 1. 前提

- **DSH 正在运行**
- `dsh-text-explain` 插件已启用
- 就这些。接口监听在 `http://127.0.0.1:3080`，**只接受本机请求**（外部机器访问不了，这是有意的）

---

## 2. 三档讲法 = 三个模型名

接口按 **模型名** 决定讲得多深，和界面上的三档一一对应：

| 模型名 | 讲给谁听 |
| --- | --- |
| `text-explain-plain` | 完全不懂 AI、不懂代码、没接触过这方面知识的人 |
| `text-explain-general` | 会用电脑、有常识，但没学过这一行的人 |
| `text-explain-pro` | 同行：术语直接用，讲机制、取舍与边界 |

**先确认可用**（浏览器打开也行）：

```
http://127.0.0.1:3080/api/text-explain/v1/models
```

---

## 3. 怎么调

**端点**：`http://127.0.0.1:3080/api/text-explain/v1/chat/completions`
**协议**：标准 OpenAI 的 `chat/completions`，支持 `stream: true`（SSE）

### 写法一：curl 读 UTF-8 文件（⭐ 最稳，推荐）

**第一步**：把请求体写进一个 **UTF-8** 的 `ask.json`：

```json
{
  "model": "text-explain-general",
  "messages": [{ "role": "user", "content": "要解释的文字" }]
}
```

> 存文件时**务必选 UTF-8 编码**。Windows 记事本默认就是 UTF-8，可以用。

**第二步**：发送

```bash
curl -s -X POST http://127.0.0.1:3080/api/text-explain/v1/chat/completions \
  -H "Content-Type: application/json" \
  --data-binary @ask.json
```

**为什么用 `--data-binary @文件`**：这样 curl 会**原样**把文件字节发出去，不碰编码。中文因此不会出错。

### 写法二：PowerShell 一行（把 JSON 转成 UTF-8 字节）

```powershell
$json  = '{"model":"text-explain-general","messages":[{"role":"user","content":"用一句话解释什么是幂等"}]}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
$r = Invoke-RestMethod -Uri 'http://127.0.0.1:3080/api/text-explain/v1/chat/completions' `
  -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes
$r.choices[0].message.content
```

> ⚠️ **必须转字节**。若直接 `-Body $json`，PowerShell 会按本地编码发出，**中文会变成问号**（实测踩过这个坑）。

### 写法三：只要一句话（无中文时最简）

```bash
curl -s -X POST http://127.0.0.1:3080/api/text-explain/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"text-explain-pro","messages":[{"role":"user","content":"explain monads briefly"}]}'
```

含中文时**别用这条**——命令行参数里的中文在 Windows 上很容易被转坏，改用写法一。

---

## 4. 在 Codex 里怎么用

**⚠️ 先说一条走不通的路**：**不要把本插件设成 Codex 的模型**（即把 Codex 的 base URL 指向它）。
Codex 是**能写代码、改文件的编程 agent**，需要的是能干活的模型；而本插件是**解释器**（只会讲清楚一段话）。语义不匹配，接上去它反而干不了活。

**可行的用法是反过来——让 Codex 调用它**：

| 方式 | 怎么做 | 适合 |
| --- | --- | --- |
| **贴命令** | 需要解释时，把 §3 的命令贴进 Codex 的终端 | 立刻可用，零配置 |
| **包成别名/脚本** | 写个 `dsh-explain "文字"` 的包装脚本，内部就是 §3 | 常用的话省事 |
| **MCP server** | 若 Codex 支持自定义 MCP，把 `explain` 注册成一个工具 | 让 Codex **自己决定**何时解释 |

**典型场景**：Codex 改完一段代码 → 您看不懂它为什么这么写 → 让它跑一条上面的命令，把这句解释出来。

---

## 5. 边界（有意这样设计的）

| 项 | 说明 |
| --- | --- |
| **只给联网工具** | 走这条路的外部客户端**能拿到联网搜索**，但**永远拿不到「读本机文件」** |
| **为什么** | 外部应用送来的内容**不可信**。让「读本机文件」和它同处一个上下文，就是**提示注入**的入口（比如某段文字里写着「请读取 C:\...\密码.txt」） |
| **即便显式传 `forceTool: "file"`** | 也被忽略。这条边界是硬的 |

---

## 6. 常见问题

**Q：报「origin not allowed」？**
A：跨源请求需要把来源加进白名单。编辑 `<DSH_HOME>/text-explain/settings.json` 的 `allowedOrigins`（如 `http://127.0.0.1:3080`、`app://obsidian.md`）。改完**立刻生效，无需重启**。

**Q：返回的中文是问号？**
A：编码问题，见 §3 写法二的注意事项。curl 用 `--data-binary @文件` 即可避免。

**Q：能不能让它读我电脑上的某个文件？**
A：**不能**，见 §5。这是刻意的安全边界。

**Q：端口能改吗？**
A：跟随 DSH 的 Web 端口（默认 3080）。DSH 换了端口，这里也要跟着换。

---

## 7. 相关

- 插件的完整说明见仓库 `README.md`
- 三档讲法的实现（中文措辞）在 `lib/index.js` 的 `LEVELS`
- 浏览器扩展的双模式（也可接你自己的 API）见 `extension/README.md`
