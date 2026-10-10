/**
 * 内容脚本：划词/右键 → 浮窗 → 流式解释 → 就地追问。
 *
 * 界面整个放在一个 **Shadow DOM** 里：既不让页面的 CSS 污染浮窗，
 * 也不必把我们的样式洒进别人的页面。
 *
 * 三件事值得说明：
 *
 * ① **网页上下文**。选中一句「它指的是这个」，脱开页面谁也不知道「它」是什么。
 *    所以打开浮窗时会顺手收集：所在段落的原文、最近的上级标题、页面标题与网址，
 *    拼在第一条消息里一起发给模型。解释与后续交接共用这一份。
 *
 * ② **追问**。浮窗里维护一条对话流（用户/助手交替），每次追问都把完整历史发出去，
 *    所以模型记得前面聊过什么。
 *
 * ③ **钉住**。默认点页面别处就关（免得挡视线）；点一下图钉后，只有 Esc 或关闭
 *    按钮能关它——解决「不小心点到外面就没了」。
 *
 * 请求本身不在这里发 —— 交给后台的 service worker（原因见 background.js 顶部）。
 */
(function () {
  if (window.__dshTextExplainLoaded === true) return
  window.__dshTextExplainLoaded = true

  var LEVELS = ['plain', 'general', 'pro']
  var LEVEL_LABELS = { plain: '小白', general: '通识', pro: '专业' }
  var LEVEL_ALIASES = { expert: 'pro' } // 四档时代的旧值，平滑迁移
  var BLOCK_TAGS = {
    P: 1, LI: 1, TD: 1, TH: 1, DD: 1, DT: 1, BLOCKQUOTE: 1, FIGCAPTION: 1, PRE: 1,
    ARTICLE: 1, SECTION: 1, MAIN: 1
  }
  var MAX_PARAGRAPH_CHARS = 1200
  var MAX_HEADING_CHARS = 120

  var host = null
  var shadow = null
  var triggerEl = null
  var panelEl = null
  var bodyEl = null
  var inputEl = null
  var sendEl = null
  var statusEl = null
  var errorEl = null
  var pinEl = null
  var levelButtons = {}

  var currentLevel = 'plain'
  var triggerMode = 'context-menu'
  var pinned = false
  var conversation = [] // [{ role: 'user' | 'assistant', content }]
  var pageContext = null
  var pendingForceTool = null // 下一次请求要强制用的工具（「联网搜索」按钮设的）
  var activeRequestId = null

  function normalizeLevel(value) {
    var resolved = LEVEL_ALIASES[value] || value
    return LEVELS.indexOf(resolved) >= 0 ? resolved : 'plain'
  }

  function wantsSelectionButton() {
    return triggerMode === 'selection-button' || triggerMode === 'both'
  }

  function ensureHost() {
    if (host !== null) return
    host = document.createElement('div')
    host.style.position = 'absolute'
    host.style.top = '0'
    host.style.left = '0'
    host.style.width = '0'
    host.style.height = '0'
    shadow = host.attachShadow({ mode: 'open' })
    var style = document.createElement('style')
    style.textContent = TextExplainStyles
    shadow.appendChild(style)
    var ui = document.createElement('div')
    ui.className = 'dsh-te-ui'
    shadow.appendChild(ui)
    shadow.__ui = ui
    document.documentElement.appendChild(host)
  }

  function uiRoot() {
    ensureHost()
    return shadow.__ui
  }

  function pageRect(rect) {
    return {
      left: rect.left + window.scrollX,
      top: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height
    }
  }

  function currentSelectionRect() {
    var selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return null
    var rect = selection.getRangeAt(0).getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null
    return rect
  }

  function currentSelectionText() {
    var selection = window.getSelection()
    if (!selection) return ''
    return String(selection.toString() || '').trim()
  }

  // ---- 网页上下文 ----

  /** 把选中的那段话「放回它所在的段落」——这是最值钱的上下文。 */
  function findSurroundingParagraph(range) {
    var node = range.startContainer
    var element = node.nodeType === 1 ? node : node.parentElement
    while (element && element !== document.body) {
      if (BLOCK_TAGS[element.tagName] === 1) {
        var own = String(element.innerText || element.textContent || '').trim()
        if (own.length > 0) return own
      }
      element = element.parentElement
    }
    var body = document.body
    return body ? String(body.innerText || '').trim() : ''
  }

  /** 往上找最近的一个上级标题（h1–h6），用来说明「这一节在讲什么」。 */
  function findNearestHeading(range) {
    var cursor = range.startContainer
    cursor = cursor.nodeType === 1 ? cursor : cursor.parentElement
    while (cursor && cursor !== document.body) {
      var previous = cursor.previousElementSibling
      while (previous) {
        if (/^H[1-6]$/.test(previous.tagName)) return String(previous.textContent || '').trim()
        if (previous.querySelector) {
          var inner = previous.querySelector('h1,h2,h3,h4,h5,h6')
          if (inner) return String(inner.textContent || '').trim()
        }
        previous = previous.previousElementSibling
      }
      cursor = cursor.parentElement
    }
    return ''
  }

  function collectPageContext() {
    var context = {
      title: String(document.title || '').trim(),
      url: String(location.href || ''),
      heading: '',
      paragraph: ''
    }
    try {
      var selection = window.getSelection()
      if (!selection || selection.rangeCount === 0) return context
      var range = selection.getRangeAt(0)
      context.paragraph = findSurroundingParagraph(range).slice(0, MAX_PARAGRAPH_CHARS)
      context.heading = findNearestHeading(range).slice(0, MAX_HEADING_CHARS)
    } catch (_error) {
      /* 拿不到就算了，不影响解释本身 */
    }
    return context
  }

  /** 第一条消息 = 上下文 + 我要问的片段。 */
  function composeFirstMessage(text, context) {
    var parts = []
    if (context.title || context.url) {
      parts.push('【所在页面】' + (context.title || '（无标题）') + (context.url ? '\n' + context.url : ''))
    }
    if (context.heading) parts.push('【所在小节】' + context.heading)
    if (context.paragraph) parts.push('【这一段的原文】\n' + context.paragraph)
    parts.push('【我要问的片段】\n' + text)
    parts.push('请结合这一段的意思，把【我要问的片段】用大白话讲清楚。')
    return parts.join('\n\n')
  }

  // ---- 小按钮（「划词即出」模式下才用） ----

  function hideTrigger() {
    if (triggerEl !== null) {
      triggerEl.remove()
      triggerEl = null
    }
  }

  function showTrigger() {
    if (!wantsSelectionButton()) {
      hideTrigger()
      return
    }
    var text = currentSelectionText()
    if (text.length < 2 || text.length > 4000) {
      hideTrigger()
      return
    }
    var rect = currentSelectionRect()
    if (rect === null) {
      hideTrigger()
      return
    }
    ensureHost()

    if (triggerEl === null) {
      triggerEl = document.createElement('div')
      triggerEl.className = 'dsh-te-trigger'
      triggerEl.textContent = '✦ 解释'
      // 关键：按下时阻止默认行为，否则点击会让选区消失，抓不到选中的文字
      triggerEl.addEventListener('mousedown', function (event) {
        event.preventDefault()
        event.stopPropagation()
      })
      triggerEl.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        openPanel(text)
      })
      uiRoot().appendChild(triggerEl)
    }

    var box = pageRect(rect)
    triggerEl.style.left = Math.round(box.left) + 'px'
    triggerEl.style.top = Math.round(box.top + box.height + 6) + 'px'
  }

  // ---- 浮窗 ----

  function closePanel() {
    if (panelEl !== null) {
      panelEl.remove()
      panelEl = null
      bodyEl = null
      inputEl = null
      sendEl = null
      statusEl = null
      errorEl = null
      pinEl = null
      levelButtons = {}
    }
    activeRequestId = null
    conversation = []
    pageContext = null
  }

  function setStatus(text) {
    if (statusEl === null) return
    statusEl.textContent = text
    statusEl.style.display = text ? 'block' : 'none'
  }

  function setError(text) {
    if (errorEl === null) return
    errorEl.textContent = text
    errorEl.style.display = text ? 'block' : 'none'
  }

  function setBusy(busy) {
    if (sendEl !== null) sendEl.disabled = busy
    if (inputEl !== null) inputEl.disabled = busy
  }

  /** 把整条对话流画出来：提问单独成行，回答走 markdown。 */
  function renderConversation() {
    if (bodyEl === null) return
    var html = []
    // 语境默认折叠：它动辄上千字，摊开会把回答挤没
    if (pageContext && (pageContext.heading || pageContext.title || pageContext.paragraph)) {
      var where = pageContext.heading || pageContext.title || '本页'
      html.push('<details class="dsh-te-ctx"><summary>📎 语境：' + TextExplainMarkdown(where) + '</summary>')
      if (pageContext.title) {
        html.push('<div class="dsh-te-ctx-line">页面：' + TextExplainMarkdown(pageContext.title) + '</div>')
      }
      if (pageContext.heading) {
        html.push('<div class="dsh-te-ctx-line">小节：' + TextExplainMarkdown(pageContext.heading) + '</div>')
      }
      if (pageContext.paragraph) {
        html.push('<div class="dsh-te-ctx-line">段落：' + TextExplainMarkdown(pageContext.paragraph) + '</div>')
      }
      html.push('</details>')
    }
    for (var i = 0; i < conversation.length; i += 1) {
      var message = conversation[i]
      if (message.role === 'user') {
        html.push('<div class="dsh-te-ask">' + TextExplainMarkdown(message.content) + '</div>')
      } else if (message.content.length > 0) {
        html.push('<div class="dsh-te-answer">' + TextExplainMarkdown(message.content) + '</div>')
      }
    }
    bodyEl.innerHTML = html.join('')
    bodyEl.scrollTop = bodyEl.scrollHeight
  }

  function syncLevelButtons() {
    LEVELS.forEach(function (id) {
      var button = levelButtons[id]
      if (button) button.setAttribute('data-on', id === currentLevel ? '1' : '0')
    })
  }

  function syncPin() {
    if (pinEl !== null) pinEl.setAttribute('data-on', pinned ? '1' : '0')
  }

  function openPanel(text, options) {
    var content = String(text || '').trim()
    if (content.length === 0) return
    var keepPinned = options && options.keepPinned === true
    var wasPinned = pinned
    closePanel()
    pinned = keepPinned ? wasPinned : false
    ensureHost()
    hideTrigger()

    pageContext = collectPageContext()
    // 分开两件事：content 是「显示用」（用户实际选中的那句），
    // full 是「发送用」（含网页上下文）。合成一份的话，那一大段页面原文
    // 会当成用户提问铺满浮窗——这正是上一版的问题。
    conversation = [
      { role: 'user', content: content, full: composeFirstMessage(content, pageContext) }
    ]

    panelEl = document.createElement('div')
    panelEl.className = 'dsh-te-panel'
    panelEl.addEventListener('mousedown', function (event) {
      event.stopPropagation()
    })

    // 顶栏：档位 + 图钉 + 关闭
    var head = document.createElement('div')
    head.className = 'dsh-te-head'

    var levels = document.createElement('div')
    levels.className = 'dsh-te-levels'
    LEVELS.forEach(function (id) {
      var button = document.createElement('button')
      button.className = 'dsh-te-level'
      button.type = 'button'
      button.textContent = LEVEL_LABELS[id]
      button.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        if (currentLevel === id && activeRequestId !== null) return
        currentLevel = id
        syncLevelButtons()
        chrome.storage.local.set({ level: id })
        // 换档位 = 用新讲法重讲第一个问题（历史清空重来）
        if (conversation.length > 0) {
          var first = conversation[0].content
          conversation = [{ role: 'user', content: first }]
          ask(first)
        }
      })
      levelButtons[id] = button
      levels.appendChild(button)
    })
    head.appendChild(levels)

    pinEl = document.createElement('button')
    pinEl.className = 'dsh-te-icon'
    pinEl.type = 'button'
    pinEl.textContent = '📌'
    pinEl.title = '钉住：不再随点击页面而关闭'
    pinEl.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      pinned = !pinned
      syncPin()
      if (pinEl !== null) pinEl.title = pinned ? '已钉住：只有 Esc 或 × 能关' : '钉住：不再随点击页面而关闭'
    })
    head.appendChild(pinEl)

    var close = document.createElement('button')
    close.className = 'dsh-te-close'
    close.type = 'button'
    close.textContent = '×'
    close.title = '关闭（Esc）'
    close.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      closePanel()
    })
    head.appendChild(close)
    panelEl.appendChild(head)

    bodyEl = document.createElement('div')
    bodyEl.className = 'dsh-te-body'
    panelEl.appendChild(bodyEl)

    var inputRow = document.createElement('div')
    inputRow.className = 'dsh-te-input'
    inputEl = document.createElement('input')
    inputEl.type = 'text'
    inputEl.placeholder = '追问一句…（回车发送）'
    inputEl.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        submitFollowUp()
      }
    })
    inputRow.appendChild(inputEl)
    sendEl = document.createElement('button')
    sendEl.className = 'dsh-te-send'
    sendEl.type = 'button'
    sendEl.textContent = '追问'
    sendEl.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      submitFollowUp()
    })
    inputRow.appendChild(sendEl)
    panelEl.appendChild(inputRow)

    /**
     * 「联网搜索」：让模型**现在就去查一次**，查完只补充新东西。
     *
     * 时机和 DSH 里那个按钮一样——是「已经看过一遍解释之后」才点的：
     * 用户想借工具挖得更透，不是想听同样的东西再讲一遍。后端据此追加
     * 一段「先查证、不复述」的指令。
     */
    function forceWebSearch() {
      while (conversation.length > 0 && conversation[conversation.length - 1].role === 'assistant') {
        conversation.pop()
      }
      if (conversation.length === 0) return
      pendingForceTool = 'web'
      renderConversation()
      ask()
    }

    // 交接：把这次问答（连同网页上下文）交给 DSH 继续。
    // 两种形态由设置决定——「在 DSH 里继续」（默认）或「复制交接单」。
    // 逻辑内联在这里，是为了少一处跨函数的状态；设置现场读取，改了立刻生效。
    var actions = document.createElement('div')
    actions.className = 'dsh-te-actions'

    var webEl = document.createElement('button')
    webEl.className = 'dsh-te-handoff'
    webEl.type = 'button'
    webEl.textContent = '🌐 联网搜索'
    webEl.title = '让 AI 现在就去联网查一次，把新查到的补给你（不会重复已经讲过的内容）'
    webEl.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      forceWebSearch()
    })
    actions.appendChild(webEl)

    var handoffEl = document.createElement('button')
    handoffEl.className = 'dsh-te-handoff'
    handoffEl.type = 'button'
    handoffEl.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      if (conversation.length === 0) return

      var lines = ['# 划词解释 · 交接']
      if (pageContext) {
        if (pageContext.title || pageContext.url) {
          lines.push('', '**来源页面**：' + (pageContext.title || '（无标题）') +
            (pageContext.url ? '（' + pageContext.url + '）' : ''))
        }
        if (pageContext.heading) lines.push('', '**所在小节**：' + pageContext.heading)
      }
      lines.push('', '---', '')
      for (var i = 0; i < conversation.length; i += 1) {
        var item = conversation[i]
        if (item.role === 'user') lines.push('**我问的**', '', item.content, '')
        else if (item.content.length > 0) lines.push('**解释**', '', item.content, '')
      }
      lines.push('---', '',
        '以上是背景资料，交接完毕。请只回复一句「背景已了解，等你开口」——' +
        '**不要总结、不要提问、不要展开**，等我自己开口。')
      var document_ = lines.join('\n')

      handoffEl.disabled = true
      handoffEl.textContent = '正在交接…'

      chrome.storage.local.get({ handoffMode: 'session' }, function (stored) {
        if (stored.handoffMode === 'clipboard') {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(document_).then(function () {
              handoffEl.textContent = '已复制 ✓ 粘进 DSH 新会话即可'
              window.setTimeout(function () { handoffEl.disabled = false; handoffEl.textContent = '复制交接单' }, 2500)
            }, function () {
              handoffEl.disabled = false
              handoffEl.textContent = '复制失败，试试「在 DSH 里继续」'
            })
          } else {
            handoffEl.disabled = false
            handoffEl.textContent = '此页面不支持复制'
          }
          return
        }
        chrome.runtime.sendMessage({ type: 'text-explain/handoff', text: document_ }, function (response) {
          if (chrome.runtime.lastError) {
            handoffEl.disabled = false
            handoffEl.textContent = '交接失败：' + chrome.runtime.lastError.message
            return
          }
          if (response && response.ok === true) {
            handoffEl.textContent = '已在新会话中等你 ✓'
            // DSH 没有「用 URL 打开某个会话」的入口，所以只能打开它、让侧栏自己冒出来
            // （宿主建好会话后，已打开的页面会经 follow 流自动收到）
          } else {
            handoffEl.disabled = false
            handoffEl.textContent = '交接失败：' + ((response && response.message) || '未知原因')
          }
        })
      })
    })
    actions.appendChild(handoffEl)
    panelEl.appendChild(actions)

    statusEl = document.createElement('div')
    statusEl.className = 'dsh-te-status'
    panelEl.appendChild(statusEl)

    errorEl = document.createElement('div')
    errorEl.className = 'dsh-te-error'
    errorEl.style.display = 'none'
    panelEl.appendChild(errorEl)

    uiRoot().appendChild(panelEl)
    syncLevelButtons()
    syncPin()
    renderConversation()

    var rect = currentSelectionRect()
    var box = rect === null
      ? { left: 40 + window.scrollX, top: 80 + window.scrollY, width: 0, height: 0 }
      : pageRect(rect)
    var width = 440
    var left = Math.min(Math.max(8, box.left), Math.max(8, window.scrollX + window.innerWidth - width - 16))
    panelEl.style.left = Math.round(left) + 'px'
    panelEl.style.top = Math.round(box.top + box.height + 10) + 'px'

    renderConversation()
    ask()
    if (inputEl !== null) inputEl.focus()
  }

  /** 把当前对话历史整理成要发给后端的 messages。 */
  function buildMessages() {
    var outgoing = []
    for (var i = 0; i < conversation.length; i += 1) {
      var message = conversation[i]
      if (message.role === 'assistant' && message.content.length === 0) continue // 空占位不发
      outgoing.push({ role: message.role, content: message.full || message.content })
    }
    return outgoing
  }

  /** 真正发起一次请求（历史里最后一条助手消息此时是空占位）。 */
  function ask() {
    if (panelEl === null) return
    conversation.push({ role: 'assistant', content: '' })
    renderConversation()
    setError('')
    setStatus(pendingForceTool === 'web' ? '正在联网查…' : '正在解释…')
    setBusy(true)
    activeRequestId = 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    var forceToolForThisRequest = pendingForceTool
    pendingForceTool = null
    chrome.runtime.sendMessage(
      {
        type: 'text-explain/start',
        requestId: activeRequestId,
        messages: buildMessages(),
        forceTool: forceToolForThisRequest,
        level: currentLevel
      },
      function (response) {
        if (chrome.runtime.lastError) {
          setError('扩展后台没有响应：' + chrome.runtime.lastError.message)
          setStatus('')
          setBusy(false)
          return
        }
        if (!response || response.ok !== true) {
          setError((response && response.message) || '无法开始请求')
          setStatus('')
          setBusy(false)
        }
      }
    )
  }

  function submitFollowUp() {
    if (inputEl === null || sendEl === null || sendEl.disabled) return
    var question = String(inputEl.value || '').trim()
    if (question.length === 0) return
    inputEl.value = ''
    conversation.push({ role: 'user', content: question })
    renderConversation()
    ask()
  }

  // ---- 后台推回来的流 ----

  chrome.runtime.onMessage.addListener(function (message) {
    // 右键菜单来的指令：用菜单里带的文字开浮窗
    if (message && message.type === 'text-explain/open') {
      var text = currentSelectionText() || String(message.text || '')
      openPanel(text)
      return
    }
    if (!message || message.requestId !== activeRequestId) return
    if (message.type === 'text-explain/chunk') {
      var last = conversation[conversation.length - 1]
      if (last && last.role === 'assistant') {
        last.content += message.text
        renderConversation()
      }
      return
    }
    if (message.type === 'text-explain/done') {
      setStatus('')
      setBusy(false)
      activeRequestId = null
      if (inputEl !== null) inputEl.focus()
      return
    }
    if (message.type === 'text-explain/error') {
      setError(message.message || '出错了')
      setStatus('')
      setBusy(false)
      activeRequestId = null
    }
  })

  // ---- 事件 ----

  document.addEventListener('mouseup', function (event) {
    if (host !== null && event.composedPath && event.composedPath().indexOf(host) >= 0) return
    window.setTimeout(function () {
      showTrigger()
    }, 10)
  })

  document.addEventListener('mousedown', function (event) {
    if (host !== null && event.composedPath && event.composedPath().indexOf(host) >= 0) return
    hideTrigger()
    if (!pinned) closePanel() // 钉住后，点页面别处不再关它
  })

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      hideTrigger()
      closePanel()
    }
  })

  window.addEventListener('scroll', hideTrigger, true)

  chrome.storage.local.get({ level: 'plain', triggerMode: 'context-menu' }, function (stored) {
    currentLevel = normalizeLevel(stored.level)
    triggerMode =
      stored.triggerMode === 'selection-button' || stored.triggerMode === 'both'
        ? stored.triggerMode
        : 'context-menu'
  })

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return
    if (changes.triggerMode) {
      triggerMode =
        changes.triggerMode.newValue === 'selection-button' || changes.triggerMode.newValue === 'both'
          ? changes.triggerMode.newValue
          : 'context-menu'
      if (!wantsSelectionButton()) hideTrigger()
    }
    if (changes.level) {
      currentLevel = normalizeLevel(changes.level.newValue)
      syncLevelButtons()
    }
  })
})()
