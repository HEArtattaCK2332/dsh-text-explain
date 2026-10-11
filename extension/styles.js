/**
 * 浮窗样式（以字符串形式定义）。
 *
 * 为什么不写成 content.css：界面挂在 **Shadow DOM** 里，页面级样式表管不到它，
 * 反过来页面的 `* { … }` 也骚扰不到我们——这正是我们要的隔离。代价是样式
 * 得自己塞进 shadow root，所以就放在这个文件里。
 *
 * 配色跟随系统深浅色，用 CSS 变量一套两值。
 */
var TextExplainStyles = `
  :host {
    all: initial;
  }
  .dsh-te-ui {
    --te-bg: #ffffff;
    --te-fg: #1f2328;
    --te-muted: #6b7280;
    --te-border: #e5e7eb;
    --te-accent: #2563eb;
    --te-code-bg: #f6f8fa;
    --te-ask-bg: #f3f4f6;
    --te-shadow: 0 10px 30px rgba(15, 23, 42, 0.18);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    line-height: 1.65;
    color: var(--te-fg);
  }
  @media (prefers-color-scheme: dark) {
    .dsh-te-ui {
      --te-bg: #1f2225;
      --te-fg: #e6e6e6;
      --te-muted: #9aa0a6;
      --te-border: #3a3f44;
      --te-accent: #6ea8fe;
      --te-code-bg: #2a2e33;
      --te-ask-bg: #2a2e33;
      --te-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    }
  }

  .dsh-te-trigger {
    position: absolute;
    z-index: 2147483646;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 9px;
    border: 1px solid var(--te-border);
    border-radius: 999px;
    background: var(--te-bg);
    color: var(--te-fg);
    box-shadow: var(--te-shadow);
    cursor: pointer;
    user-select: none;
    font-size: 12px;
    white-space: nowrap;
  }
  .dsh-te-trigger:hover {
    border-color: var(--te-accent);
    color: var(--te-accent);
  }

  .dsh-te-panel {
    position: absolute;
    z-index: 2147483647;
    width: 440px;
    max-width: calc(100vw - 32px);
    height: 560px;
    max-height: 70vh;
    // resize 只在 overflow 非 visible 时生效；hidden 即可
    resize: both;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--te-border);
    border-radius: 12px;
    background: var(--te-bg);
    box-shadow: var(--te-shadow);
    overflow: hidden;
  }
  .dsh-te-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    cursor: move;
    user-select: none;
    border-bottom: 1px solid var(--te-border);
    background: var(--te-bg);
    flex: 0 0 auto;
  }
  .dsh-te-levels {
    display: flex;
    gap: 4px;
    flex: 1 1 auto;
  }
  .dsh-te-level {
    padding: 2px 8px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: var(--te-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .dsh-te-level[data-on="1"] {
    background: var(--te-accent);
    color: #fff;
  }
  .dsh-te-icon {
    border: 1px solid transparent;
    background: transparent;
    color: var(--te-muted);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
    padding: 3px 6px;
    border-radius: 6px;
  }
  .dsh-te-icon:hover {
    color: var(--te-fg);
    border-color: var(--te-border);
  }
  .dsh-te-icon[data-on="1"] {
    color: var(--te-accent);
    border-color: var(--te-accent);
  }

  .dsh-te-body {
    padding: 10px 12px;
    overflow: auto;
    flex: 1 1 auto;
  }
  .dsh-te-body p { margin: 0 0 8px; }
  .dsh-te-body p:last-child { margin-bottom: 0; }
  .dsh-te-body h1, .dsh-te-body h2, .dsh-te-body h3 {
    margin: 10px 0 6px;
    font-size: 15px;
    font-weight: 600;
  }
  .dsh-te-body ul, .dsh-te-body ol { margin: 0 0 8px; padding-left: 20px; }
  .dsh-te-body li { margin: 2px 0; }
  .dsh-te-body code {
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--te-code-bg);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12.5px;
  }
  .dsh-te-body pre {
    margin: 0 0 8px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--te-code-bg);
    overflow: auto;
  }
  .dsh-te-body pre code { background: transparent; padding: 0; }
  .dsh-te-body blockquote {
    margin: 0 0 8px;
    padding: 2px 10px;
    border-left: 3px solid var(--te-border);
    color: var(--te-muted);
  }
  .dsh-te-body a { color: var(--te-accent); }

  /* 追问：每一轮提问单独成行，与回答区分开 */
  .dsh-te-ask {
    margin: 12px 0 6px;
    padding: 5px 9px;
    border-radius: 8px;
    background: var(--te-ask-bg);
    color: var(--te-muted);
    font-size: 12.5px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .dsh-te-ask:first-child { margin-top: 0; }
  .dsh-te-ctx {
    margin: 0 0 10px;
    padding: 4px 8px;
    border: 1px solid var(--te-border);
    border-radius: 8px;
    color: var(--te-muted);
    font-size: 12px;
  }
  .dsh-te-ctx summary {
    cursor: pointer;
    list-style: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dsh-te-ctx summary::-webkit-details-marker { display: none; }
  .dsh-te-ctx-line {
    margin-top: 6px;
    padding-left: 6px;
    border-left: 2px solid var(--te-border);
    max-height: 9em;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .dsh-te-input {
    display: flex;
    gap: 6px;
    padding: 8px 10px;
    border-top: 1px solid var(--te-border);
    background: var(--te-bg);
    flex: 0 0 auto;
  }
  .dsh-te-input input {
    flex: 1 1 auto;
    padding: 6px 9px;
    border: 1px solid var(--te-border);
    border-radius: 8px;
    background: transparent;
    color: var(--te-fg);
    font: inherit;
    font-size: 13px;
  }
  .dsh-te-input input:focus {
    outline: none;
    border-color: var(--te-accent);
  }
  .dsh-te-send {
    padding: 6px 12px;
    border: 1px solid var(--te-accent);
    border-radius: 8px;
    background: var(--te-accent);
    color: #fff;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .dsh-te-send[disabled] {
    opacity: 0.5;
    cursor: default;
  }

  /* 交接那一行：单独占一行，不跟输入框挤在一起 */
  .dsh-te-actions {
    display: flex;
    gap: 6px;
    padding: 0 10px 10px;
    background: var(--te-bg);
    flex: 0 0 auto;
  }
  .dsh-te-handoff {
    flex: 1 1 auto;
    padding: 6px 10px;
    border: 1px solid var(--te-border);
    border-radius: 8px;
    background: transparent;
    color: var(--te-fg);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }
  .dsh-te-handoff:hover {
    border-color: var(--te-accent);
    color: var(--te-accent);
  }
  .dsh-te-handoff[disabled] {
    opacity: 0.6;
    cursor: default;
  }

  .dsh-te-status {
    padding: 0 12px 8px;
    color: var(--te-muted);
    font-size: 12px;
    flex: 0 0 auto;
  }
  .dsh-te-error {
    margin: 0 12px 10px;
    padding: 8px 10px;
    border-radius: 8px;
    background: #fee2e2;
    color: #991b1b;
    font-size: 12.5px;
  }
  @media (prefers-color-scheme: dark) {
    .dsh-te-error { background: #4a1d1d; color: #fecaca; }
  }
`
