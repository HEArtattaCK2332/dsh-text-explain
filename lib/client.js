window.__ModuleLoader__.load({
  id: 'dsh-text-explain',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    /**
     * 从划选位置向上找出「所在的那条消息」，读出全文当语境。
     * 取「不超过 limit 的最外层祖先」，即这条消息本身，而不是整个会话；
     * 任何一步失败都返回空串，解释照旧可用。
     */
    function readContextText(anchorNode, selectedText) {
      var node = anchorNode
      if (!node) return ''
      var el = node.nodeType === 3 ? node.parentElement : node
      if (!el) return ''
      var limit = Math.max(4000, selectedText.length * 4)
      var best = ''
      var depth = 0
      while (el && el !== document.body && depth < 12) {
        var text = ''
        try {
          text = (el.innerText || el.textContent || '').trim()
        } catch (_error) {
          text = ''
        }
        if (text.length > 0 && text.length <= limit) best = text
        if (text.length > limit) break
        el = el.parentElement
        depth++
      }
      return best.slice(0, 4000)
    }

    // ---- 插件设置（存在宿主侧配置文件里；这里只负责「读一次、缓存、保存」）----
    //
    // 规矩：**不点保存，什么都不记录**。面板上的每次点选只改浏览器里的草稿；
    // 只有点了「保存」才会 POST 给宿主，写进 <DSH_HOME>/text-explain/settings.json。
    // 插件自己要设置时（开弹窗、定新会话落点），一律读下面这份内存缓存，避免等待网络。

    var SETTINGS_ENDPOINT = '/api/text-explain/settings'

    /** 讲解深度三档；id 与宿主半 lib/index.js 的 LEVELS 一一对应，改一边就得改另一边。 */
    var LEVEL_OPTIONS = [
      { id: 'plain', label: '小白', hint: '完全没接触过这方面知识的人（默认）' },
      { id: 'general', label: '通识', hint: '会用电脑、有常识，但没学过这一行' },
      { id: 'pro', label: '专业', hint: '同行：术语直接用，讲机制、取舍与边界' }
    ]

    /** 已合并/改名的档位：旧设置里的值平滑迁移，别让历史数据把人卡住。 */
    var LEVEL_ALIASES = { expert: 'pro' }

    var DEFAULT_SETTINGS = {
      newSessionTarget: 'same-workspace',
      explainLevel: 'plain',
      webDefault: true,
      fileDefault: true,
      showWebButton: true,
      showFileButton: true,
      advancedVisible: false,
      // 给浏览器扩展用的来源白名单；面板不展示它，但**必须原样带回去**——
      // 否则在面板上点一次「保存」，就把用户手写进设置文件的白名单抹掉了。
      allowedOrigins: []
    }

    /**
     * 与宿主半同一套清洗规则：http(s)://、chrome-extension://、以及 app://
     * （Electron 应用——Obsidian 桌面版的 Origin 就是 `app://obsidian.md`）。
     */
    function sanitizeOrigins(raw) {
      if (!Array.isArray(raw)) return []
      var seen = {}
      var result = []
      for (var i = 0; i < raw.length; i += 1) {
        if (typeof raw[i] !== 'string') continue
        var value = raw[i].trim().replace(/\/+$/, '')
        var acceptable = /^https?:\/\/[^\s/]+$/i.test(value) ||
          /^chrome-extension:\/\/[a-p]{32}$/i.test(value) ||
          /^app:\/\/[^\s/]+$/i.test(value)
        if (!acceptable) continue
        if (seen[value] === true) continue
        seen[value] = true
        result.push(value)
        if (result.length >= 20) break
      }
      return result
    }

    function isLevelId(value) {
      for (var i = 0; i < LEVEL_OPTIONS.length; i += 1) {
        if (LEVEL_OPTIONS[i].id === value) return true
      }
      return false
    }

    /** 把任意来源（宿主文件里的旧数据、面板草稿）洗成一份字段齐全、取值合法的设置。 */
    function normalizeSettings(raw) {
      var result = {
        newSessionTarget: DEFAULT_SETTINGS.newSessionTarget,
        explainLevel: DEFAULT_SETTINGS.explainLevel,
        webDefault: DEFAULT_SETTINGS.webDefault,
        fileDefault: DEFAULT_SETTINGS.fileDefault,
        showWebButton: DEFAULT_SETTINGS.showWebButton,
        showFileButton: DEFAULT_SETTINGS.showFileButton,
        advancedVisible: DEFAULT_SETTINGS.advancedVisible,
        allowedOrigins: []
      }
      if (!raw || typeof raw !== 'object') return result
      if (raw.newSessionTarget === 'ungrouped' || raw.newSessionTarget === 'same-workspace') {
        result.newSessionTarget = raw.newSessionTarget
      }
      if (typeof raw.explainLevel === 'string') {
        var requestedLevel = LEVEL_ALIASES[raw.explainLevel] || raw.explainLevel
        if (isLevelId(requestedLevel)) result.explainLevel = requestedLevel
      }
      if (typeof raw.webDefault === 'boolean') result.webDefault = raw.webDefault
      if (typeof raw.fileDefault === 'boolean') result.fileDefault = raw.fileDefault
      if (typeof raw.showWebButton === 'boolean') result.showWebButton = raw.showWebButton
      if (typeof raw.showFileButton === 'boolean') result.showFileButton = raw.showFileButton
      if (typeof raw.advancedVisible === 'boolean') result.advancedVisible = raw.advancedVisible
      if (raw.allowedOrigins !== undefined) result.allowedOrigins = sanitizeOrigins(raw.allowedOrigins)
      return result
    }

    function sameSettings(a, b) {
      var left = normalizeSettings(a)
      var right = normalizeSettings(b)
      return left.newSessionTarget === right.newSessionTarget &&
        left.explainLevel === right.explainLevel &&
        left.webDefault === right.webDefault &&
        left.fileDefault === right.fileDefault &&
        left.showWebButton === right.showWebButton &&
        left.showFileButton === right.showFileButton &&
        left.advancedVisible === right.advancedVisible &&
        JSON.stringify(left.allowedOrigins) === JSON.stringify(right.allowedOrigins)
    }

    /**
     * 内存缓存：设置是从宿主异步读来的，可划词、开弹窗都要「立刻」拿到它，
     * 所以缓存一份。预热在插件挂载时做（applySettingsBootstrap），保存成功也会顺手更新。
     */
    var settingsCache = null

    function getSettings() {
      if (!settingsCache) settingsCache = normalizeSettings(null)
      return settingsCache
    }

    /** 从宿主读一次设置：成功则更新缓存并返回；失败返回 null，缓存原样不动。 */
    function fetchSettings() {
      return fetch(SETTINGS_ENDPOINT, { headers: { Accept: 'application/json' } })
        .then(function (response) {
          if (!response.ok) return null
          return response.json()
        })
        .then(function (data) {
          if (data === null || typeof data === 'undefined') return null
          var next = normalizeSettings(data)
          settingsCache = next
          return next
        })
        .catch(function () {
          return null
        })
    }

    /** 把一份设置交给宿主保存：成功则更新缓存并返回落盘的那份；失败返回 null，缓存不动。 */
    function saveSettings(draft) {
      return fetch(SETTINGS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(normalizeSettings(draft))
      })
        .then(function (response) {
          if (!response.ok) return null
          return response.json()
        })
        .then(function (data) {
          if (data === null || typeof data === 'undefined') return null
          var next = normalizeSettings(data)
          settingsCache = next
          return next
        })
        .catch(function () {
          return null
        })
    }

    /**
     * 等「新会话」出现在会话列表里。
     * 官方新建入口 startSession() 不返回会话 id，只能靠比对列表前后差集认领它。
     */
    function waitForNewSession(clientCtx, beforeIds, timeoutMs) {
      return new Promise(function (resolve, reject) {
        var settled = false
        var unsubscribe = null
        var timer = setTimeout(function () {
          if (settled) return
          settled = true
          if (unsubscribe) unsubscribe()
          reject(new Error('等待新会话出现超时，请重试'))
        }, timeoutMs)
        function scan() {
          if (settled) return
          var ids
          try {
            ids = clientCtx.sessions.list.getSnapshot().ids
          } catch (_error) {
            return
          }
          for (var i = 0; i < ids.length; i += 1) {
            if (!beforeIds.has(ids[i])) {
              settled = true
              clearTimeout(timer)
              if (unsubscribe) unsubscribe()
              resolve(ids[i])
              return
            }
          }
        }
        try {
          unsubscribe = clientCtx.sessions.list.subscribe(scan)
        } catch (_error) {
          unsubscribe = null
        }
        scan()
      })
    }

    var BUTTON_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '7px 12px',
      borderRadius: '14px',
      border: '1px solid rgba(128, 128, 128, 0.35)',
      background: '#101014',
      color: '#f2f2f5',
      fontSize: '13px',
      lineHeight: '18px',
      cursor: 'pointer',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)'
    }

    var PANEL_STYLE = {
      position: 'fixed',
      width: '420px',
      maxWidth: 'calc(100vw - 24px)',
      height: '560px',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 99992,
      pointerEvents: 'auto',
      borderRadius: '16px',
      border: '1px solid rgba(128, 128, 128, 0.35)',
      background: '#15151a',
      color: '#f2f2f5',
      boxShadow: '0 16px 48px rgba(0, 0, 0, 0.35)',
      // resize 只在 overflow 不是 visible 时生效；hidden 即可，无需 auto
      resize: 'both',
      overflow: 'hidden'
    }

    var CLOSE_BUTTON_STYLE = {
      border: 'none',
      background: 'transparent',
      color: '#c9c9d2',
      fontSize: '15px',
      lineHeight: '20px',
      cursor: 'pointer',
      padding: '2px 6px',
      borderRadius: '8px'
    }

    var INPUT_STYLE = {
      flex: 1,
      background: '#0d0d11',
      color: '#f2f2f5',
      border: '1px solid rgba(128, 128, 128, 0.35)',
      borderRadius: '10px',
      padding: '8px 10px',
      fontSize: '13px',
      lineHeight: '18px',
      outline: 'none'
    }

    var SEND_STYLE = {
      border: 'none',
      borderRadius: '10px',
      background: '#3b82f6',
      color: '#ffffff',
      fontSize: '13px',
      lineHeight: '18px',
      padding: '8px 12px',
      cursor: 'pointer'
    }

    // ---- Markdown 渲染样式 ----

    var MD_P_STYLE = { margin: '4px 0', lineHeight: '1.65' }
    var MD_H_STYLE = {
      1: { margin: '10px 0 6px', fontSize: '20px', fontWeight: 700, lineHeight: 1.4 },
      2: { margin: '10px 0 6px', fontSize: '17px', fontWeight: 700, lineHeight: 1.4 },
      3: { margin: '8px 0 4px', fontSize: '15px', fontWeight: 700, lineHeight: 1.4 },
      4: { margin: '8px 0 4px', fontSize: '14px', fontWeight: 700, lineHeight: 1.4 },
      5: { margin: '6px 0 4px', fontSize: '13px', fontWeight: 700, lineHeight: 1.4 },
      6: { margin: '6px 0 4px', fontSize: '12px', fontWeight: 700, lineHeight: 1.4 }
    }
    var MD_CODE_INLINE_STYLE = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '12px',
      background: 'rgba(255, 255, 255, 0.08)',
      borderRadius: '4px',
      padding: '1px 5px'
    }
    var MD_CODE_BLOCK_STYLE = {
      display: 'block',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '12px',
      lineHeight: 1.55,
      whiteSpace: 'pre',
      overflowX: 'auto',
      padding: '10px 12px',
      color: '#e6e6eb'
    }
    var MD_PRE_STYLE = {
      margin: '8px 0',
      background: '#0d0d11',
      border: '1px solid rgba(128, 128, 128, 0.25)',
      borderRadius: '8px',
      overflowX: 'auto'
    }
    var MD_QUOTE_STYLE = {
      margin: '6px 0',
      padding: '4px 12px',
      borderLeft: '3px solid #3b82f6',
      color: '#b9b9c4',
      background: 'rgba(59, 130, 246, 0.06)',
      borderRadius: '0 6px 6px 0'
    }
    var MD_HR_STYLE = {
      border: 'none',
      borderTop: '1px solid rgba(128, 128, 128, 0.3)',
      margin: '10px 0'
    }
    var MD_LIST_STYLE = { margin: '4px 0', paddingLeft: '22px' }
    var MD_LI_STYLE = { margin: '2px 0', lineHeight: 1.6 }
    var MD_LINK_STYLE = { color: '#7cb3ff', textDecoration: 'none' }
    var MD_TABLE_WRAP_STYLE = { margin: '8px 0', overflowX: 'auto' }
    var MD_TABLE_STYLE = {
      borderCollapse: 'collapse',
      width: '100%',
      fontSize: '13px',
      lineHeight: 1.5
    }
    var MD_TH_STYLE = {
      border: '1px solid rgba(128, 128, 128, 0.35)',
      padding: '6px 10px',
      background: 'rgba(255, 255, 255, 0.06)',
      fontWeight: 700,
      textAlign: 'left',
      whiteSpace: 'nowrap'
    }
    var MD_TD_STYLE = {
      border: '1px solid rgba(128, 128, 128, 0.28)',
      padding: '6px 10px',
      textAlign: 'left'
    }

    // ---- 行内解析：`code` **bold** *italic* ~~del~~ [text](url) ----

    var INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g

    function renderInlineNodes(text) {
      var remaining = String(text == null ? '' : text)
      var nodes = []
      var last = 0
      var match
      var key = 0
      INLINE_RE.lastIndex = 0
      while ((match = INLINE_RE.exec(remaining)) !== null) {
        if (match.index > last) nodes.push(remaining.slice(last, match.index))
        var token = match[0]
        if (token.charAt(0) === '`') {
          nodes.push(React.createElement('code', { key: key++, style: MD_CODE_INLINE_STYLE }, token.slice(1, -1)))
        } else if (token.slice(0, 2) === '**') {
          nodes.push(React.createElement('strong', { key: key++ }, token.slice(2, -2)))
        } else if (token.slice(0, 2) === '~~') {
          nodes.push(React.createElement('del', { key: key++ }, token.slice(2, -2)))
        } else if (token.charAt(0) === '[') {
          var link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
          if (link) {
            nodes.push(React.createElement('a', {
              key: key++,
              href: link[2],
              target: '_blank',
              rel: 'noopener noreferrer',
              style: MD_LINK_STYLE
            }, link[1]))
          } else {
            nodes.push(token)
          }
        } else {
          nodes.push(React.createElement('em', { key: key++ }, token.slice(1, -1)))
        }
        last = match.index + token.length
      }
      if (last < remaining.length) nodes.push(remaining.slice(last))
      return nodes
    }

    function splitTableRow(line) {
      return line.trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map(function (cell) { return cell.trim() })
    }

    function isTableSeparator(line) {
      var t = line.trim()
      if (t.indexOf('|') === -1) return false
      var cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|')
      return cells.length > 0 && cells.every(function (cell) {
        return /^:?-{3,}:?$/.test(cell.trim())
      })
    }

    function renderTable(header, rows, key) {
      var thead = React.createElement('thead', null,
        React.createElement('tr', null, header.map(function (cell, index) {
          return React.createElement('th', { key: index, style: MD_TH_STYLE }, renderInlineNodes(cell))
        }))
      )
      var tbody = React.createElement('tbody', null, rows.map(function (row, rowIndex) {
        return React.createElement('tr', { key: rowIndex }, row.map(function (cell, cellIndex) {
          return React.createElement('td', { key: cellIndex, style: MD_TD_STYLE }, renderInlineNodes(cell))
        }))
      }))
      return React.createElement('div', { key: key, style: MD_TABLE_WRAP_STYLE },
        React.createElement('table', { style: MD_TABLE_STYLE }, thead, tbody)
      )
    }

    function isSpecialLine(line) {
      return /^\s*```/.test(line) ||
        /^\s*(#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s)/.test(line) ||
        /^\s*([-*_])\s*(\1\s*){2,}$/.test(line)
    }

    function renderMarkdown(text) {
      var lines = String(text == null ? '' : text).split('\n')
      var out = []
      var i = 0
      var key = 0

      while (i < lines.length) {
        var line = lines[i]

        // 代码块
        if (/^\s*```/.test(line)) {
          var codeLines = []
          i++
          while (i < lines.length && !/^\s*```/.test(lines[i])) {
            codeLines.push(lines[i])
            i++
          }
          i++ // 跳过结尾 ```
          out.push(React.createElement('pre', { key: key++, style: MD_PRE_STYLE },
            React.createElement('code', { style: MD_CODE_BLOCK_STYLE }, codeLines.join('\n'))
          ))
          continue
        }

        // 表格（表头 + 分隔行）
        if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
          var header = splitTableRow(line)
          i += 2
          var rows = []
          while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') !== -1) {
            rows.push(splitTableRow(lines[i]))
            i++
          }
          out.push(renderTable(header, rows, key++))
          continue
        }

        // 标题
        var heading = line.match(/^(#{1,6})\s+(.*)$/)
        if (heading) {
          var level = heading[1].length
          out.push(React.createElement('h' + level, { key: key++, style: MD_H_STYLE[level] }, renderInlineNodes(heading[2])))
          i++
          continue
        }

        // 引用块
        if (/^\s*>\s?/.test(line)) {
          var quoteLines = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            quoteLines.push(lines[i].replace(/^\s*>\s?/, ''))
            i++
          }
          out.push(React.createElement('blockquote', { key: key++, style: MD_QUOTE_STYLE },
            renderInlineNodes(quoteLines.join(' '))
          ))
          continue
        }

        // 分隔线
        if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
          out.push(React.createElement('hr', { key: key++, style: MD_HR_STYLE }))
          i++
          continue
        }

        // 无序列表
        if (/^\s*[-*+]\s+/.test(line)) {
          var items = []
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
            i++
          }
          out.push(React.createElement('ul', { key: key++, style: MD_LIST_STYLE },
            items.map(function (item, index) {
              return React.createElement('li', { key: index, style: MD_LI_STYLE }, renderInlineNodes(item))
            })
          ))
          continue
        }

        // 有序列表
        if (/^\s*\d+[.)]\s+/.test(line)) {
          var ordered = []
          while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
            ordered.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''))
            i++
          }
          out.push(React.createElement('ol', { key: key++, style: MD_LIST_STYLE },
            ordered.map(function (item, index) {
              return React.createElement('li', { key: index, style: MD_LI_STYLE }, renderInlineNodes(item))
            })
          ))
          continue
        }

        // 空行
        if (line.trim() === '') {
          i++
          continue
        }

        // 段落：累积连续普通行
        var paraLines = [line]
        i++
        while (i < lines.length && lines[i].trim() !== '' && !isSpecialLine(lines[i]) && !(lines[i].indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1]))) {
          paraLines.push(lines[i])
          i++
        }
        out.push(React.createElement('p', { key: key++, style: MD_P_STYLE }, renderInlineNodes(paraLines.join(' '))))
      }

      return out
    }

    function messageBubbleStyle(role) {
      return {
        margin: '6px 0',
        padding: '8px 10px',
        borderRadius: '10px',
        background: role === 'user' ? 'rgba(59, 130, 246, 0.16)' : 'rgba(255, 255, 255, 0.06)',
        whiteSpace: 'pre-wrap',
        fontSize: '13px',
        lineHeight: '1.6'
      }
    }

    function markdownBubbleStyle() {
      return {
        margin: '6px 0',
        padding: '8px 10px',
        borderRadius: '10px',
        background: 'rgba(255, 255, 255, 0.06)',
        fontSize: '13px',
        lineHeight: '1.6',
        overflowWrap: 'break-word'
      }
    }

    var TOGGLE_ON_STYLE = {
      border: '1px solid #3b82f6',
      background: 'rgba(59, 130, 246, 0.18)',
      color: '#ffffff',
      borderRadius: '999px',
      fontSize: '12px',
      lineHeight: '16px',
      padding: '3px 10px',
      cursor: 'pointer'
    }

    var TOGGLE_OFF_STYLE = {
      border: '1px solid rgba(128, 128, 128, 0.35)',
      background: 'transparent',
      color: '#9a9aa5',
      borderRadius: '999px',
      fontSize: '12px',
      lineHeight: '16px',
      padding: '3px 10px',
      cursor: 'pointer'
    }

    var NEW_CHAT_STYLE = {
      border: '1px solid rgba(59, 130, 246, 0.55)',
      background: 'rgba(59, 130, 246, 0.14)',
      color: '#dce8ff',
      borderRadius: '999px',
      fontSize: '12px',
      lineHeight: '16px',
      padding: '3px 10px',
      cursor: 'pointer'
    }

    function TextExplainOverlay(props) {
      var clientCtx = props && props.ctx ? props.ctx : null

      var selectedState = React.useState(null)
      var selected = selectedState[0]
      var setSelected = selectedState[1]

      var panelState = React.useState(null)
      var panel = panelState[0]
      var setPanel = panelState[1]
      // 「钉住」挂在 panel 上，**不新增 useState**——测试桩按调用序号分配状态，
      // 多一个 state 会让后面全部错位。
      var pinned = !!(panel && panel.pinned)

      var threadState = React.useState([])
      var thread = threadState[0]
      var setThread = threadState[1]

      var answerState = React.useState('')
      var answer = answerState[0]
      var setAnswer = answerState[1]

      var loadingState = React.useState(false)
      var loading = loadingState[0]
      var setLoading = loadingState[1]

      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]

      var inputState = React.useState('')
      var input = inputState[0]
      var setInput = inputState[1]

      var busyNewChatState = React.useState(false)
      var busyNewChat = busyNewChatState[0]
      var setBusyNewChat = busyNewChatState[1]

      var webState = React.useState(true)
      var webEnabled = webState[0]
      var setWebEnabled = webState[1]

      var fileState = React.useState(true)
      var fileEnabled = fileState[0]
      var setFileEnabled = fileState[1]

      // 讲解深度档位：打开弹窗时取设置里的默认档，弹窗里也能随时换（只影响本次）。
      var levelState = React.useState(function () { return getSettings().explainLevel })
      var level = levelState[0]
      var setLevel = levelState[1]

      var abortRef = React.useRef(null)
      var rootRef = React.useRef(null)
      var inputRef = React.useRef(null)

      function abortCurrent() {
        if (abortRef.current) {
          abortRef.current.abort()
          abortRef.current = null
        }
      }

      function closeAll() {
        abortCurrent()
        setSelected(null)
        setPanel(null)
        setThread([])
        setAnswer('')
        setError('')
        setInput('')
        setLoading(false)
      }

      React.useEffect(function () {
        function onMouseUp(event) {
          setTimeout(function () {
            var selection = window.getSelection()
            var text = selection ? selection.toString().trim() : ''
            if (text.length === 0) {
              setSelected(null)
              return
            }
            if (rootRef.current && selection.anchorNode && rootRef.current.contains(selection.anchorNode)) {
              return
            }

            var rect = null
            if (selection.rangeCount > 0) {
              try {
                rect = selection.getRangeAt(0).getBoundingClientRect()
              } catch (_error) {
                rect = null
              }
            }

            var x = event.clientX
            var y = event.clientY + 10
            if (rect && rect.width > 0 && rect.height > 0) {
              x = clamp(rect.left + rect.width / 2 - 78, 8, window.innerWidth - 190)
              y = rect.bottom + 8
            }
            if (y > window.innerHeight - 48) y = window.innerHeight - 48

            setSelected({ text: text, context: readContextText(selection.anchorNode, text), x: x, y: y })
          }, 0)
        }

        function onMouseDown(event) {
          // 钉住后，点页面别处不再关闭（用户要腾出手来对照原文）
          if (pinned) return
          if (rootRef.current && !rootRef.current.contains(event.target)) {
            closeAll()
          }
        }

        document.addEventListener('mouseup', onMouseUp)
        document.addEventListener('mousedown', onMouseDown)
        return function () {
          document.removeEventListener('mouseup', onMouseUp)
          document.removeEventListener('mousedown', onMouseDown)
        }
      }, [])

      React.useEffect(function () {
        return function () {
          abortCurrent()
        }
      }, [])

      React.useEffect(function () {
        if (panel && inputRef.current) {
          inputRef.current.focus()
        }
      }, [panel])

      /**
       * 发一次请求。
       * overrides 是给「刚改完档位/开关就立刻发请求」用的：setState 是异步的，
       * 那一瞬间闭包里的 level / webEnabled / fileEnabled 都还是旧值，必须显式传进来。
       */
      function runRequest(messages, contextText, overrides) {
        abortCurrent()
        var controller = new AbortController()
        abortRef.current = controller
        var patch = overrides && typeof overrides === 'object' ? overrides : {}
        var usedLevel = isLevelId(patch.level) ? patch.level : level
        var usedWeb = typeof patch.web === 'boolean' ? patch.web : webEnabled
        var usedFile = typeof patch.file === 'boolean' ? patch.file : fileEnabled
        // 按钮只负责「现在就去查一次」；至于工具平时给不给模型，由设置里的默认值决定。
        var usedForce = patch.force === 'web' || patch.force === 'file' ? patch.force : null
        // 这一轮是「解释」还是「追问」：只有追问需要显式说明，其余（首次解释、
        // 换档重讲、点联网/本地搜索）都算「解释」。后端优先听它——否则「保留旧回答」
        // 会让消息条数 > 1，那三个按钮就会被误判成追问。
        var usedTurn = patch.turn === 'followup' ? 'followup' : 'explain'
        setAnswer('')
        setError('')
        setLoading(true)

        fetch('/api/text-explain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: messages,
            context: contextText || '',
            enableWeb: usedWeb,
            enableFile: usedFile,
            forceTool: usedForce,
            turn: usedTurn,
            level: usedLevel
          }),
          signal: controller.signal
        }).then(function (response) {
          if (!response.ok) {
            return response.text().then(function (bodyText) {
              var parsed = null
              try {
                parsed = JSON.parse(bodyText)
              } catch (_error) {
                parsed = null
              }
              var message = parsed && parsed.error ? parsed.error : 'HTTP ' + response.status
              throw new Error(message)
            })
          }
          if (!response.body) throw new Error('current browser does not support streaming responses')

          var reader = response.body.getReader()
          var decoder = new TextDecoder('utf-8')
          var full = ''

          function readNext() {
            return reader.read().then(function (result) {
              if (result.done) return full
              var chunkText = decoder.decode(result.value, { stream: true })
              if (chunkText.length > 0) {
                full += chunkText
                setAnswer(full)
              }
              return readNext()
            })
          }

          return readNext()
        }).then(function (full) {
          setThread(function (previous) {
            return previous.concat([{ role: 'assistant', text: full }])
          })
          setAnswer('')
          setLoading(false)
        }).catch(function (err) {
          if (err && err.name === 'AbortError') return
          setError(err && err.message ? err.message : String(err))
          setLoading(false)
        })
      }

      /**
       * 打开弹窗时，从设置里取「默认档位」与「默认工具开关」——老手在设置里挑的偏好在此生效。
       * 顺手在后台重读一次设置（不阻塞本次），让刚在别处改过的默认值从下一次划词开始生效。
       */
      function applySavedDefaults() {
        var prefs = getSettings()
        setLevel(prefs.explainLevel)
        setWebEnabled(prefs.webDefault)
        setFileEnabled(prefs.fileDefault)
        fetchSettings()
        return prefs
      }

      function openExplain() {
        if (!selected) return
        var baseThread = [{ role: 'user', text: selected.text }]
        var prefs = applySavedDefaults()
        setPanel({ text: selected.text, context: selected.context, x: selected.x, y: selected.y })
        setThread(baseThread)
        setInput('')
        runRequest(baseThread, selected.context, {
          level: prefs.explainLevel,
          web: prefs.webDefault,
          file: prefs.fileDefault
        })
      }

      function openAsk() {
        if (!selected) return
        if (!panel) {
          var baseThread = [{ role: 'user', text: selected.text }]
          applySavedDefaults()
          setPanel({ text: selected.text, context: selected.context, x: selected.x, y: selected.y })
          setThread(baseThread)
          setAnswer('')
          setError('')
          setInput('')
        }
        setTimeout(function () {
          if (inputRef.current) inputRef.current.focus()
        }, 0)
      }

      function submitQuestion() {
        var question = input.trim()
        if (question.length === 0 || loading) return
        var nextThread = thread.concat([{ role: 'user', text: question }])
        setThread(nextThread)
        setInput('')
        runRequest(nextThread, panel && panel.context ? panel.context : '', { turn: 'followup' })
      }

      /** 把现有回答标记成「已被取代」——界面上折叠，历史里**保留**。 */
      function supersedeAnswers(list) {
        return list.map(function (message) {
          return message.role === 'assistant'
            ? Object.assign({}, message, { superseded: true })
            : message
        })
      }

      /**
       * 用指定档位把最后一问重讲一遍。
       *
       * 注意：**不删**旧回答，只把它折叠起来。这样用户能翻回去对照；而且旧回答留在
       * 发给模型的历史里，模型看得到自己上一条说了什么，「只补充新东西」更容易做到。
       */
      function retell(levelOverride) {
        if (thread.length < 2) return
        var next = supersedeAnswers(thread)
        setThread(next)
        runRequest(next, panel && panel.context ? panel.context : '', {
          level: levelOverride,
          turn: 'explain'
        })
      }

      /**
       * 按钮：让模型「现在就去查一次」（联网 / 本地），查完**只补充新东西**。
       *
       * 时机是关键：这个按钮是「已经看过一遍解释之后」才点的——用户想借工具挖得更透，
       * 不是想听同样的东西再讲一遍。后端会据此追加一段「先查证、不复述」的指令。
       */
      function forceSearch(kind) {
        if (thread.length < 2) return
        var next = supersedeAnswers(thread)
        // 补一条明确的指令：否则历史末尾是模型自己的回答，它会以为是「轮到自己续写」
        next = next.concat([{
          role: 'user',
          text: '请查证后补充。不要复述上面已经说过的内容，只讲新查到的。'
        }])
        setThread(next)
        runRequest(next, panel && panel.context ? panel.context : '', {
          force: kind,
          turn: 'explain'
        })
      }

      /**
       * 换一个讲解档位——**只管本次弹窗**。
       * 若已经有回答，立刻用新档位重讲一遍：「同一句话、换种讲法」的差别，一眼就能看见。
       * 想让它成为默认档，去「设置 → 划词解释」里选好再点「保存」——凡没点保存的，一律不落盘。
       */
      function switchLevel(nextLevel) {
        if (!isLevelId(nextLevel) || nextLevel === level) return
        setLevel(nextLevel)
        if (!loading && thread.length > 1) retell(nextLevel)
      }

      /**
       * 把这次划词问答整理成一份「交接单」，供新会话接手。
       *
       * 基调是**待命**：用户点「新建为对话」，通常意味着他要换个战场去做别的事，
       * 而不是让 AI 立刻接着长篇开讲。若在弹窗里已经点过「解释」，他显然不需要再听一遍；
       * 若是点「追问」，他要的也只是继续问下去——两种情形下，让新会话自己先开口都是多余的。
       * 故末尾写明「只回一句，别总结、别提问、别展开」：背景照带，话留给他起头。
       */
      function buildThreadDocument() {
        var lines = []
        lines.push('# 从划词解释继续')
        lines.push('')
        lines.push('> 这是一份交接单：我在别处划了一段话，下面是原文、它所在的完整消息，')
        lines.push('> 以及当时已问过的内容。**先把这些背景收好，等我的问题。**')
        lines.push('')
        lines.push('## 选中的原文')
        lines.push('')
        lines.push('> ' + String(panel && panel.text ? panel.text : '').replace(/\n/g, '\n> '))
        if (panel && panel.context && panel.context.trim().length > 0) {
          lines.push('')
          lines.push('## 这段原文所在的完整消息')
          lines.push('')
          lines.push(panel.context)
        }
        lines.push('')
        lines.push('## 已进行的解释与追问')
        lines.push('')
        var visible = thread.slice(1)
        if (visible.length === 0) {
          lines.push('（暂无，仅有上面的原文）')
        } else {
          visible.forEach(function (message) {
            lines.push(message.role === 'user' ? '**我：** ' + message.text : '**AI：** ' + message.text)
            lines.push('')
          })
        }
        lines.push('---')
        lines.push('')
        lines.push('以上是背景资料，交接完毕。请只回复一句「背景已了解，等你开口」——')
        lines.push('**不要总结、不要提问、不要展开**，等我自己开口。')
        return lines.join('\n')
      }

      /** 划词解释专用工作区的目录端点（后端会顺手把目录建好）。 */
      function explainWorkspaceUrl() {
        var base = String(getSettings().endpoint || '').replace(/\/+$/, '')
        return base.replace(/\/v1$/, '') + '/explain-workspace'
      }

      /** 在指定工作区里开一个新会话（拿它的 id）。 */
      function startSessionIn(workspaceId) {
        var beforeIds = new Set()
        try {
          var ids = clientCtx.sessions.list.getSnapshot().ids
          for (var i = 0; i < ids.length; i += 1) beforeIds.add(ids[i])
        } catch (_error) {
          return Promise.resolve(clientCtx.sessions.create({ workspaceId: workspaceId }))
        }
        clientCtx.uiWorkspace.startSession(workspaceId)
        return waitForNewSession(clientCtx, beforeIds, 8000)
      }

      /**
       * 按设置决定新会话落在哪里。
       * - same-workspace（默认）：走官方新建入口 startSession()，省略工作区参数即「继承当前或最近的工作区」
       * - text-explain：固定落到「划词解释」工作区——先向后端要那个目录（后端顺手建好），
       *   再让客户端把它注册成工作区，最后在那边开会话
       * - ungrouped：直接 create，不归入任何工作区
       * 任一环失败都退回普通创建，保证按钮不因设置而失灵。
       */
      function openTargetSession() {
        var settings = getSettings()
        if (settings.newSessionTarget === 'ungrouped') {
          return clientCtx.sessions.create({})
        }
        if (settings.newSessionTarget === 'text-explain') {
          if (!clientCtx.workspaces) return clientCtx.sessions.create({})
          return fetch(explainWorkspaceUrl(), { method: 'POST' })
            .then(function (response) { return response.json() })
            .then(function (data) {
              if (!data || typeof data.path !== 'string' || data.path.length === 0) {
                return clientCtx.sessions.create({})
              }
              // create 对同一目录是复用的，不必先查是否存在
              return Promise.resolve(clientCtx.workspaces.create({ path: data.path })).then(
                function (view) {
                  var workspaceId = view && (view.id || view.workspaceId)
                  if (!workspaceId) return clientCtx.sessions.create({})
                  return startSessionIn(workspaceId)
                }
              )
            })
            .catch(function () { return clientCtx.sessions.create({}) })
        }
        return startSessionIn(undefined)
      }

      function createSessionFromThread() {
        if (!clientCtx || !clientCtx.sessions || !clientCtx.uiWorkspace) {
          setError('当前环境不支持新建会话（缺少 sessions / uiWorkspace 服务）')
          return
        }
        if (busyNewChat) return
        setBusyNewChat(true)
        setError('')
        var document = buildThreadDocument()
        Promise.resolve()
          .then(function () {
            return openTargetSession()
          })
          .then(function (sessionId) {
            try {
              clientCtx.uiWorkspace.openSession(sessionId)
            } catch (_error) {
              // 导航失败不阻塞内容注入
            }
            var reference = clientCtx.sessions.retain(sessionId, { source: 'controllerOperation' })
            return reference.ready.then(function (binding) {
              if (!binding || !binding.session) throw new Error('无法取得新会话的写入通道')
              return binding.session.prompt([{ type: 'text', text: document }], 'queue')
            })
          })
          .then(function () {
            setBusyNewChat(false)
            closeAll()
          })
          .catch(function (err) {
            setBusyNewChat(false)
            setError('新建对话失败：' + (err && err.message ? err.message : String(err)))
          })
      }

      function onInputChange(event) {
        setInput(event.target.value)
      }

      function onInputKeyDown(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          submitQuestion()
        }
      }

      function renderButtons() {
        if (!selected || panel) return null
        return React.createElement('div', {
          style: {
            position: 'fixed',
            left: selected.x + 'px',
            top: selected.y + 'px',
            display: 'flex',
            gap: '8px',
            zIndex: 99991,
            pointerEvents: 'auto'
          }
        },
          React.createElement('button', { onClick: openExplain, style: BUTTON_STYLE }, 'AI 解释'),
          React.createElement('button', { onClick: openAsk, style: BUTTON_STYLE }, '追问')
        )
      }

      function renderPanel() {
        if (!panel) return null
        var left = clamp(panel.x, 12, Math.max(12, window.innerWidth - 444))
        var top = clamp(panel.y, 12, Math.max(12, window.innerHeight - 584))
        var visibleThread = thread.slice(1)

        var levelButtons = LEVEL_OPTIONS.map(function (option) {
          var active = option.id === level
          return React.createElement('button', {
            key: option.id,
            onClick: function () { switchLevel(option.id) },
            style: Object.assign({}, active ? TOGGLE_ON_STYLE : TOGGLE_OFF_STYLE, { padding: '2px 9px' }),
            title: option.hint + '（只影响本次；换了会立刻用新档位重讲一遍。想设为默认，去「设置 → 划词解释」保存一次）'
          }, option.label)
        })

        var conversationChildren = []
        visibleThread.forEach(function (message, index) {
          if (message.role === 'assistant') {
            var bubble = React.createElement('div', {
              key: 'bubble-' + index,
              style: markdownBubbleStyle()
            },
              React.createElement('div', {
                style: { fontSize: '11px', color: '#9a9aa5', marginBottom: '4px' }
              }, '回答'),
              renderMarkdown(message.text)
            )
            if (message.superseded === true) {
              // 被「换档重讲 / 联网搜索」取代的旧回答：折叠保留，用户想对照可以展开
              conversationChildren.push(React.createElement('details', {
                key: 'message-' + index,
                style: { marginBottom: '8px' }
              },
                React.createElement('summary', {
                  style: { cursor: 'pointer', fontSize: '12px', color: '#9a9aa5' }
                }, '📄 上一次的回答（点开查看）'),
                bubble
              ))
            } else {
              conversationChildren.push(bubble)
            }
          } else {
            conversationChildren.push(React.createElement('div', {
              key: 'message-' + index,
              style: messageBubbleStyle(message.role)
            },
              React.createElement('div', {
                style: { fontSize: '11px', color: '#9a9aa5', marginBottom: '4px' }
              }, '追问'),
              message.text
            ))
          }
        })

        if (loading && answer.length === 0) {
          conversationChildren.push(React.createElement('div', {
            key: 'loading',
            style: { color: '#c9c9d2', padding: '8px 0' }
          }, '正在思考…'))
        }

        if (answer.length > 0) {
          conversationChildren.push(React.createElement('div', {
            key: 'answer-stream',
            style: markdownBubbleStyle()
          }, renderMarkdown(answer)))
        }

        if (error.length > 0) {
          conversationChildren.push(React.createElement('div', {
            key: 'error',
            style: { color: '#ff8a8a', padding: '8px 0', whiteSpace: 'pre-wrap' }
          }, error))
        }

        return React.createElement('div', {
          style: Object.assign({}, PANEL_STYLE, { left: left + 'px', top: top + 'px' })
        },
          React.createElement('div', {
            // 标题栏整条可拖：按住它移动弹窗，位置落在 panel.x / panel.y 里
            onMouseDown: function (event) {
              if (event.target && event.target.tagName === 'BUTTON') return
              event.preventDefault()
              var startX = event.clientX
              var startY = event.clientY
              var originX = left
              var originY = top
              function onMove(moveEvent) {
                setPanel(Object.assign({}, panel, {
                  x: clamp(originX + moveEvent.clientX - startX, 0, window.innerWidth - 120),
                  y: clamp(originY + moveEvent.clientY - startY, 0, window.innerHeight - 60)
                }))
              }
              function onUp() {
                document.removeEventListener('mousemove', onMove)
                document.removeEventListener('mouseup', onUp)
              }
              document.addEventListener('mousemove', onMove)
              document.addEventListener('mouseup', onUp)
            },
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 14px',
              borderBottom: '1px solid rgba(128, 128, 128, 0.25)',
              cursor: 'move',
              userSelect: 'none'
            }
          },
            React.createElement('span', { style: { fontSize: '14px', fontWeight: 600 } }, '划词解释与追问'),
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '2px' } },
              React.createElement('button', {
                onClick: function () {
                  setPanel(Object.assign({}, panel, { pinned: !pinned }))
                },
                style: Object.assign({}, CLOSE_BUTTON_STYLE, {
                  opacity: pinned ? 1 : 0.55
                }),
                title: pinned ? '已钉住：点页面别处不会关' : '钉住：点页面别处不关闭'
              }, '📌'),
              React.createElement('button', { onClick: closeAll, style: CLOSE_BUTTON_STYLE }, '✕')
            )
          ),
          React.createElement('div', {
            style: {
              padding: '10px 14px',
              maxHeight: '110px',
              overflow: 'auto',
              fontSize: '13px',
              color: '#c9c9d2',
              borderBottom: '1px solid rgba(128, 128, 128, 0.18)',
              whiteSpace: 'pre-wrap'
            }
          }, panel.text),
          React.createElement('div', {
            style: {
              padding: '12px 14px',
              overflowY: 'auto',
              flex: 1,
              fontSize: '14px',
              lineHeight: '1.6'
            }
          }, conversationChildren),
          React.createElement('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '6px',
              padding: '8px 14px 0',
              borderTop: '1px solid rgba(128, 128, 128, 0.2)'
            }
          },
            React.createElement('span', {
              style: { fontSize: '11px', color: '#9a9aa5' }
            }, '讲给谁听'),
            levelButtons
          ),
          React.createElement('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 14px',
              borderTop: '1px solid rgba(128, 128, 128, 0.2)'
            }
          },
            getSettings().showWebButton === false ? null : React.createElement('button', {
              key: 'tool-web',
              onClick: function () { forceSearch('web') },
              disabled: loading,
              style: TOGGLE_OFF_STYLE,
              title: '让 AI 现在就去联网查一次，把新查到的补给你（不会重复已经讲过的内容）'
            }, '🌐 联网搜索'),
            getSettings().showFileButton === false ? null : React.createElement('button', {
              key: 'tool-file',
              onClick: function () { forceSearch('file') },
              disabled: loading,
              style: TOGGLE_OFF_STYLE,
              title: '让 AI 现在就去本机查一次相关文件，把新查到的补给你'
            }, '📄 本地搜索'),
            React.createElement('div', { style: { flex: 1 } }),
            React.createElement('button', {
              onClick: createSessionFromThread,
              disabled: busyNewChat || thread.length === 0,
              style: busyNewChat ? TOGGLE_OFF_STYLE : NEW_CHAT_STYLE,
              title: '把原文、它所在的消息与已问过的内容打包成一个新会话；新会话会先记住背景、等您开口（想让它讲，在那里说一声即可）'
            }, busyNewChat ? '正在新建…' : '✦ 新建为对话')
          ),
          React.createElement('div', {
            style: {
              display: 'flex',
              gap: '8px',
              padding: '0 14px 10px'
            }
          },
            React.createElement('input', {
              ref: inputRef,
              type: 'text',
              value: input,
              onChange: onInputChange,
              onKeyDown: onInputKeyDown,
              placeholder: '输入追问，Enter 发送',
              style: INPUT_STYLE
            }),
            React.createElement('button', {
              onClick: submitQuestion,
              disabled: loading || input.trim().length === 0,
              style: SEND_STYLE
            }, '发送')
          )
        )
      }

      return React.createElement('div', {
        ref: rootRef,
        style: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 99990 }
      }, renderButtons(), renderPanel())
    }

    // ---- 设置界面（注册进「设置 → 插件」里的一个标签页）----

    var SETTINGS_PANEL_STYLE = { padding: '4px 2px', fontSize: '13px', lineHeight: '1.6' }
    var SETTINGS_GROUP_STYLE = {
      margin: '6px 0 8px',
      fontSize: '12px',
      fontWeight: 700,
      letterSpacing: '0.04em',
      color: '#9a9aa5'
    }
    var SETTINGS_ROW_STYLE = {
      padding: '12px 14px',
      marginBottom: '10px',
      border: '1px solid rgba(128, 128, 128, 0.25)',
      borderRadius: '10px',
      background: 'rgba(255, 255, 255, 0.03)'
    }
    var SETTINGS_LABEL_STYLE = { fontWeight: 600, marginBottom: '4px' }
    var SETTINGS_HINT_STYLE = { color: '#9a9aa5', fontSize: '12px', marginBottom: '8px' }
    var SETTINGS_OPTION_ROW_STYLE = { display: 'flex', flexWrap: 'wrap', gap: '8px' }
    var SETTINGS_BUTTON_STYLE = {
      border: '1px solid rgba(128, 128, 128, 0.35)',
      background: 'transparent',
      color: '#e6e6eb',
      borderRadius: '8px',
      fontSize: '12px',
      lineHeight: '16px',
      padding: '5px 12px',
      cursor: 'pointer'
    }
    var SETTINGS_PRIMARY_BUTTON_STYLE = Object.assign({}, SETTINGS_BUTTON_STYLE, {
      border: '1px solid #3b82f6',
      background: 'rgba(59, 130, 246, 0.18)',
      color: '#ffffff'
    })
    var SETTINGS_MUTED_BUTTON_STYLE = Object.assign({}, SETTINGS_BUTTON_STYLE, { opacity: 0.55 })

    /**
     * 设置面板：常用设置常显，高级设置收起在「高级设置」里。
     * 小白打开就有能用的默认值，老手点开「高级设置」再慢慢调。
     *
     * 与磁盘的关系（要紧）：面板打开时从宿主读一次；此后每一次点选**只改草稿**；
     * 点「保存」才把整份草稿交给宿主写进配置文件，点「刷新」则丢弃草稿、重新读一次。
     * 一句话：**不点保存，磁盘上不会多一个字**。
     */
    function TextExplainSettings() {
      var savedState = React.useState(null)
      var saved = savedState[0]
      var setSaved = savedState[1]
      var draftState = React.useState(null)
      var draft = draftState[0]
      var setDraft = draftState[1]
      var noteState = React.useState('')
      var note = noteState[0]
      var setNote = noteState[1]
      var phaseState = React.useState('loading')
      var phase = phaseState[0]
      var setPhase = phaseState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      // 打开面板时读一次；组件卸载后回来的结果一律丢掉，免得往已卸载的组件里写状态
      React.useEffect(function () {
        var alive = true
        fetchSettings().then(function (fresh) {
          if (!alive) return
          if (fresh === null) {
            setPhase('error')
            setNote('读取设置失败——宿主的设置接口没有应答。点「刷新」再试一次。')
            return
          }
          setSaved(fresh)
          setDraft(fresh)
          setPhase('ready')
        })
        return function () {
          alive = false
        }
      }, [])

      var ready = phase === 'ready' && saved !== null && draft !== null
      var dirty = ready && !sameSettings(saved, draft)

      function patch(change) {
        if (!ready) return
        setDraft(Object.assign({}, draft, change))
        setNote('')
      }

      function reload() {
        if (busy) return
        var wasDirty = dirty
        setBusy(true)
        setNote('正在重新载入…')
        fetchSettings().then(function (fresh) {
          setBusy(false)
          if (fresh === null) {
            setPhase('error')
            setNote('读取设置失败——宿主的设置接口没有应答。再点一次「刷新」重试。')
            return
          }
          setSaved(fresh)
          setDraft(fresh)
          setPhase('ready')
          setNote(wasDirty ? '已重新载入；未保存的改动已丢弃' : '已重新载入')
        })
      }

      function save() {
        if (!ready || busy) return
        setBusy(true)
        setNote('正在保存…')
        saveSettings(draft).then(function (next) {
          setBusy(false)
          if (next === null) {
            setNote('保存失败——没有写进设置文件，请再点一次「保存」。')
            return
          }
          setSaved(next)
          setDraft(next)
          setPhase('ready')
          setNote('已保存 ✓ 对之后的操作生效')
        })
      }

      /** 一行文字输入（模型名用）。锁着时 disabled + 灰。 */
      function textField(key, label, value, locked, onChange) {
        return React.createElement('label', {
          key: key,
          style: { flex: '1 1 180px', fontSize: '12px', color: '#c9c9d2' }
        },
          React.createElement('div', { style: { marginBottom: '4px' } }, label),
          React.createElement('input', {
            type: 'text',
            value: value || '',
            disabled: locked,
            placeholder: '留空用默认',
            spellCheck: false,
            onChange: function (event) { onChange(event.target.value) },
            style: {
              width: '100%',
              boxSizing: 'border-box',
              padding: '5px 8px',
              borderRadius: '8px',
              border: '1px solid rgba(128, 128, 128, 0.35)',
              background: locked ? 'transparent' : 'rgba(255, 255, 255, 0.04)',
              color: 'inherit',
              fontSize: '12px'
            }
          })
        )
      }

      /** 推理等级三档（关 / 低 / 高）。锁着时按钮 disabled。 */
      function effortField(key, label, value, locked, onChange) {
        var options = [
          { id: 'off', text: '关', hint: '最快、最省。划词解释的推荐值' },
          { id: 'low', text: '低', hint: '略微思考，速度与质量折中' },
          { id: 'high', text: '高', hint: '想得更深，但更慢、更费；难题才值得' }
        ]
        return React.createElement('div', {
          key: key,
          style: { flex: '1 1 180px', fontSize: '12px', color: '#c9c9d2' }
        },
          React.createElement('div', { style: { marginBottom: '4px' } }, label),
          React.createElement('div', { style: { display: 'flex', gap: '6px' } },
            options.map(function (option) {
              var active = value === option.id
              return React.createElement('button', {
                key: option.id,
                disabled: locked,
                title: option.hint,
                onClick: function () { if (!locked) onChange(option.id) },
                style: {
                  border: '1px solid ' + (active ? '#3b82f6' : 'rgba(128, 128, 128, 0.35)'),
                  background: active ? 'rgba(59, 130, 246, 0.18)' : 'transparent',
                  color: active ? '#ffffff' : 'inherit',
                  borderRadius: '8px',
                  fontSize: '12px',
                  padding: '4px 12px',
                  cursor: locked ? 'not-allowed' : 'pointer'
                }
              }, option.text)
            })
          )
        )
      }

      function choiceButton(key, active, text, hint, onClick) {
        return React.createElement('button', {
          key: key,
          onClick: onClick,
          style: active ? TOGGLE_ON_STYLE : TOGGLE_OFF_STYLE,
          title: hint
        }, (active ? '● ' : '○ ') + text)
      }

      // 还没读到设置之前，不摆出任何选项——免得小白对着假默认值点了一通
      if (phase === 'loading') {
        return React.createElement('div', { style: SETTINGS_PANEL_STYLE },
          React.createElement('div', {
            style: { color: '#9a9aa5', fontSize: '12px', padding: '10px 2px' }
          }, '正在读取设置…')
        )
      }

      var children = []

      // 顶部工具行：「刷新 / 保存」＋ 未保存状态提示
      children.push(React.createElement('div', {
        key: 'bar',
        style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 10px' }
      },
        React.createElement('span', {
          style: { flex: 1, fontSize: '12px', color: dirty ? '#ffcc80' : '#9a9aa5' }
        }, note.length > 0 ? note : (dirty ? '有未保存的改动' : '无未保存改动')),
        React.createElement('button', {
          onClick: reload,
          disabled: busy,
          style: SETTINGS_BUTTON_STYLE,
          title: '丢弃未保存的改动，重新从宿主的设置文件读一次'
        }, '刷新'),
        React.createElement('button', {
          onClick: save,
          disabled: !ready || busy,
          style: dirty ? SETTINGS_PRIMARY_BUTTON_STYLE : SETTINGS_MUTED_BUTTON_STYLE,
          title: dirty ? '把当前改动写进宿主的设置文件' : '当前没有需要保存的改动'
        }, '保存')
      ))

      // 读不到设置时，只给一条路：点「刷新」重来——绝不让面板摆出假的默认值
      if (phase === 'error') {
        children.push(React.createElement('div', {
          key: 'load-error',
          style: Object.assign({}, SETTINGS_ROW_STYLE, { borderColor: 'rgba(255, 138, 138, 0.5)' })
        },
          React.createElement('div', { style: SETTINGS_LABEL_STYLE }, '没能读到设置'),
          React.createElement('div', {
            style: Object.assign({}, SETTINGS_HINT_STYLE, { marginBottom: 0 })
          }, '宿主的设置接口没有应答（插件刚更新过、还没重启时也会这样）。点右上角「刷新」再试；在那之前，这里不改动任何东西。')
        ))
        return React.createElement('div', { style: SETTINGS_PANEL_STYLE }, children)
      }

      children.push(React.createElement('div', { key: 'g1', style: SETTINGS_GROUP_STYLE }, '常用设置'))

      children.push(React.createElement('div', { key: 'r-level', style: SETTINGS_ROW_STYLE },
        React.createElement('div', { style: SETTINGS_LABEL_STYLE }, '讲给谁听（解释深度）'),
        React.createElement('div', { style: SETTINGS_HINT_STYLE },
          '同一段话，换个档位就换个讲法。默认「小白」——不懂 AI 的人也看得懂；嫌讲得浅，再往上调。弹窗里也能随手切，但那只管一次，要「以后都这样」得在这儿保存。'),
        React.createElement('div', { style: SETTINGS_OPTION_ROW_STYLE }, LEVEL_OPTIONS.map(function (option) {
          return choiceButton(
            option.id,
            draft.explainLevel === option.id,
            option.label,
            option.hint,
            function () { patch({ explainLevel: option.id }) }
          )
        }))
      ))

      children.push(React.createElement('div', { key: 'r-session', style: SETTINGS_ROW_STYLE },
        React.createElement('div', { style: SETTINGS_LABEL_STYLE }, '「新建为对话」把新会话放在哪里'),
        React.createElement('div', { style: SETTINGS_HINT_STYLE },
          '「划词解释」是插件自建的工作区（目录在 DSH 家目录下的 text-explain/划词解释）。' +
          '把划词攒下来的会话都收在一处，找起来方便，也不会和您本来的项目工作区混在一起。'),
        React.createElement('div', { style: SETTINGS_OPTION_ROW_STYLE },
          choiceButton('same-workspace', draft.newSessionTarget === 'same-workspace', '与当前对话同工作区',
            '新会话落在当前对话所在的工作区（默认）',
            function () { patch({ newSessionTarget: 'same-workspace' }) }),
          choiceButton('text-explain', draft.newSessionTarget === 'text-explain', '划词解释（推荐）',
            '新会话固定落到插件自建的「划词解释」工作区，划词记录集中在一处',
            function () { patch({ newSessionTarget: 'text-explain' }) }),
          choiceButton('ungrouped', draft.newSessionTarget === 'ungrouped', '未分组',
            '新会话不归入任何工作区',
            function () { patch({ newSessionTarget: 'ungrouped' }) })
        )
      ))

      children.push(React.createElement('div', { key: 'r-advanced-toggle', style: SETTINGS_ROW_STYLE },
        React.createElement('button', {
          onClick: function () { patch({ advancedVisible: !draft.advancedVisible }) },
          style: draft.advancedVisible ? TOGGLE_ON_STYLE : TOGGLE_OFF_STYLE,
          title: '展开或收起「高级设置」——这一下同样要先「保存」才会记住'
        }, (draft.advancedVisible ? '▾ ' : '▸ ') + '高级设置'),
        React.createElement('div', {
          style: Object.assign({}, SETTINGS_HINT_STYLE, { marginTop: '8px', marginBottom: 0 })
        }, '给愿意折腾的人用。默认收起，收着也不影响日常使用；展开或收起这一下，同样要点「保存」才记得住。')
      ))

      if (draft.advancedVisible) {
        // 「模型与推理等级」：默认**锁着**，整组灰白不可点。
        // 理由很实在——不熟悉模型特性的人乱调参数，最容易花不该花的钱。
        var paramsLocked = !draft.customParamsUnlocked
        var LOCKED_HINT =
          '默认参数已按服务商精选，够用且省钱。想自己调，请先打开上面的开关——' +
          '不熟悉模型特性时乱调，最容易花冤枉钱。'

        children.push(React.createElement('div', { key: 'r-model', style: SETTINGS_ROW_STYLE },
          React.createElement('div', { style: SETTINGS_LABEL_STYLE }, '模型与推理等级'),
          React.createElement('div', { style: SETTINGS_HINT_STYLE },
            '「解释」与「追问」**分开设**：解释要快（默认**不开推理**），追问可以更深。' +
            '理由：划词解释卡在等待上，而且随时能开个新会话深入，没必要在划词那一下烧推理。'),
          React.createElement('div', { style: SETTINGS_OPTION_ROW_STYLE },
            choiceButton('unlock-params', draft.customParamsUnlocked, '🔓 自定义模型参数',
              '打开后才能改下面的模型名与推理等级；关掉即回到默认策略，这一栏也会变灰',
              function () { patch({ customParamsUnlocked: !draft.customParamsUnlocked }) })
          ),
          React.createElement('div', {
            style: Object.assign({}, SETTINGS_HINT_STYLE, { marginTop: '10px' },
              paramsLocked ? { opacity: 0.5 } : {})
          }, paramsLocked ? LOCKED_HINT : '模型名留空即用内置默认（deepseek-v4-flash）。'),
          React.createElement('div', {
            style: Object.assign({}, SETTINGS_OPTION_ROW_STYLE, paramsLocked ? { opacity: 0.5 } : {})
          },
            textField('explain-model', '解释用模型', draft.explainModel, paramsLocked,
              function (value) { patch({ explainModel: value }) }),
            textField('followup-model', '追问用模型', draft.followupModel, paramsLocked,
              function (value) { patch({ followupModel: value }) })
          ),
          React.createElement('div', {
            style: Object.assign({}, SETTINGS_OPTION_ROW_STYLE, { marginTop: '8px' },
              paramsLocked ? { opacity: 0.5 } : {})
          },
            effortField('explain-effort', '解释的推理等级', draft.explainEffort, paramsLocked,
              function (value) { patch({ explainEffort: value }) }),
            effortField('followup-effort', '追问的推理等级', draft.followupEffort, paramsLocked,
              function (value) { patch({ followupEffort: value }) })
          ),
          React.createElement('div', {
            style: Object.assign({}, SETTINGS_HINT_STYLE, { marginTop: '8px', marginBottom: 0 },
              paramsLocked ? { opacity: 0.5 } : {})
          }, '推理等级取值由各模型服务自己决定（DSH 里它不是固定枚举）。该模型若不认，换回「关」即可。')
        ))

        children.push(React.createElement('div', { key: 'r-tools', style: SETTINGS_ROW_STYLE },
          React.createElement('div', { style: SETTINGS_LABEL_STYLE }, '工具：平时给不给模型'),
          React.createElement('div', { style: SETTINGS_HINT_STYLE },
            '默认给（推荐）：模型自己判断该不该联网、该不该查本机文件。关掉后它手里就没有这些工具；' +
            '但弹窗底部的「联网搜索」「本地搜索」按钮**永远**能强制它查一次。'),
          React.createElement('div', { style: SETTINGS_OPTION_ROW_STYLE },
            choiceButton('web-default', draft.webDefault, '默认开启联网',
              '关掉后模型平时不联网，省时间也省额度；需要时按「联网搜索」仍可强制查一次',
              function () { patch({ webDefault: !draft.webDefault }) }),
            choiceButton('file-default', draft.fileDefault, '默认开启本地查找',
              '关掉后模型平时不查本机文件；需要时按「本地搜索」仍可强制查一次',
              function () { patch({ fileDefault: !draft.fileDefault }) })
          )
        ))

        children.push(React.createElement('div', { key: 'r-show-buttons', style: SETTINGS_ROW_STYLE },
          React.createElement('div', { style: SETTINGS_LABEL_STYLE }, '弹窗上显示哪些按钮'),
          React.createElement('div', { style: SETTINGS_HINT_STYLE },
            '关掉就是不显示那个按钮，弹窗更清爽（功能不受影响：模型该用时照样会用）。'),
          React.createElement('div', { style: SETTINGS_OPTION_ROW_STYLE },
            choiceButton('show-web', draft.showWebButton, '显示「联网搜索」',
              '关掉后弹窗底部不再出现这个按钮',
              function () { patch({ showWebButton: !draft.showWebButton }) }),
            choiceButton('show-file', draft.showFileButton, '显示「本地搜索」',
              '关掉后弹窗底部不再出现这个按钮',
              function () { patch({ showFileButton: !draft.showFileButton }) })
          )
        ))
      }

      return React.createElement('div', { style: SETTINGS_PANEL_STYLE }, children)
    }

    exports.inject = ['slots', 'sessions', 'uiWorkspace', 'workspaces']

    function apply(ctx) {
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          { name: 'shell.overlay', id: 'dsh-text-explain', order: 1000 },
          function () {
            return React.createElement(TextExplainOverlay, { ctx: ctx })
          }
        )
      })

      // 「设置」侧边栏里的一个整页（官方给仓库外插件预留的挂载位）。
      // 写法照抄 whale-persona：插槽不存在也不连累设置页，故整段包 try。
      ctx.effect(function () {
        try {
          return ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'dsh-text-explain',
              order: 60,
              label: function () { return '划词解释' }
            }, TextExplainSettings)
          })
        } catch (_error) {
          return function () {}
        }
      }, 'dsh-text-explain: settings section')

      // 挂载时先把设置读进内存缓存——此后开弹窗、定新会话落点都能立刻取到，
      // 不必等网络。读不到也不要紧：缓存会退回内置默认值，插件照常可用。
      ctx.effect(function () {
        fetchSettings()
        return function () {}
      }, 'dsh-text-explain: settings bootstrap')
    }

    exports.apply = apply
    return module.exports
  }
})
