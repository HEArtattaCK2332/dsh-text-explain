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
  // 用户拖动后的位置；为 null 时按选区自动定位（默认行为不变）
  var userPos = null
  var conversation = [] // [{ role: 'user' | 'assistant', content }]
  var pageContext = null
  var pendingForceTool = null // 下一次请求要强制用的工具（「联网搜索」按钮设的）
  var backendMode = 'dsh' // 'dsh' 接本机插件；'custom' 接用户自己的 OpenAI 兼容接口
  var pendingTurn = 'explain' // 'explain' | 'followup'：显式告诉后端这一轮是什么
  var activeRequestId = null

  // 「解锁划词」：有的网站明文禁止选中文字（怕被复制），于是划不动、右键菜单也不出现
  // ——「看不懂就问不了」。这一段就是掀掉那层封印。
  // 默认开着（装上就能用是底线），但**可关**：掀开之后，地图、拖拽排序这类界面
  // 可能多出「选中蓝」。设置页「高级设置」里能关掉它。
  var UNLOCK_STYLE_ID = 'dsh-text-explain-unlock'
  var unlockEnabled = true
  var unlockStyleEl = null

  function normalizeLevel(value) {
    var resolved = LEVEL_ALIASES[value] || value
    return LEVELS.indexOf(resolved) >= 0 ? resolved : 'plain'
  }

  function wantsSelectionButton() {
    return triggerMode === 'selection-button' || triggerMode === 'both'
  }

  // ---- 解锁划词 ----

  /**
   * 掀封印的第 ① 步：CSS。
   *
   * 站点用 `user-select: none` 说「不许选」。我们注入一条**优先级更高**的规则压过去
   * （样式表里的 !important 能压住元素的行内普通样式）。
   * 顺带排除输入框——它们本来就能选，不必多此一举。
   *
   * 刻意**不**覆盖 `::selection` 的颜色：那会波及所有网站（连本来正常的也变色），
   * 为治少数站点而改全网的选中观感，不划算。少数「选了看不见」的站点，
   * 功能仍可用（按钮出不出来只看选中内容，不看颜色），只是观感费解。
   */
  function applyUnlock() {
    if (!unlockEnabled) {
      removeUnlock()
      return
    }
    if (unlockStyleEl !== null && unlockStyleEl.isConnected === true) return
    unlockStyleEl = document.createElement('style')
    unlockStyleEl.id = UNLOCK_STYLE_ID
    unlockStyleEl.textContent =
      'html body *:not(input):not(textarea):not(select){' +
      '-webkit-user-select:text !important;user-select:text !important}'
    ;(document.head || document.documentElement).appendChild(unlockStyleEl)
  }

  function removeUnlock() {
    if (unlockStyleEl !== null) {
      unlockStyleEl.remove()
      unlockStyleEl = null
    }
  }

  /**
   * 掀封印的第 ② 步：按掉「看门人」。
   *
   * 另一派站点不用 CSS，而是监听 `selectstart` 并 preventDefault。
   * 我们只**按住别人**（stopImmediatePropagation），**不碰默认行为**——
   * 「不许选」这道禁令，恰恰要靠默认行为来作废。
   *
   * 为什么不去拦 mousedown：很多站点的按钮、拖拽、播放器全靠它，
   * 拦了会把正常操作一起弄坏。这一派站点暂时只能靠以后的手输兜底。
   */
  function blockSelectStart(event) {
    if (!unlockEnabled) return
    event.stopImmediatePropagation()
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
    userPos = null // 下次重新按选区定位
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
        if (message.superseded === true) {
          // 被新一次「联网搜索 / 换档重讲」取代的回答：折叠保留，用户还能翻回去看
          html.push(
            '<details class="dsh-te-ctx"><summary>📄 上一次的回答（点开查看）</summary>' +
              '<div class="dsh-te-ctx-line">' + TextExplainMarkdown(message.content) + '</div>' +
              '</details>'
          )
        } else {
          html.push('<div class="dsh-te-answer">' + TextExplainMarkdown(message.content) + '</div>')
        }
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

    // 顶栏：档位 + 图钉 + 关闭（同时也是拖动手柄）
    var head = document.createElement('div')
    head.className = 'dsh-te-head'
    head.addEventListener('mousedown', function (event) {
      // 点在按钮上不算拖动，否则「点关闭」会先被拖走
      if (event.target && event.target.tagName === 'BUTTON') return
      if (event.button !== 0) return
      event.preventDefault()
      var startX = event.clientX
      var startY = event.clientY
      var originLeft = panelEl.offsetLeft
      var originTop = panelEl.offsetTop
      function onMove(moveEvent) {
        var nextLeft = originLeft + (moveEvent.clientX - startX)
        var nextTop = originTop + (moveEvent.clientY - startY)
        panelEl.style.left = Math.round(nextLeft) + 'px'
        panelEl.style.top = Math.round(nextTop) + 'px'
        userPos = { left: nextLeft, top: nextTop }
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })

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
      if (conversation.length === 0) return
      // 不删旧回答，只把它标记为「已被取代」并在界面上折叠。
      // 这么做有两个好处：用户仍能翻回去对照；模型的历史里也留着自己上一条，
      // 「只补充新东西、不复述」这条指令因此更容易真正执行到位。
      for (var i = 0; i < conversation.length; i += 1) {
        if (conversation[i].role === 'assistant') conversation[i].superseded = true
      }
      // 补一条明确的指令：这样历史末尾仍是 user，模型不至于收到一个「轮到你续写」的尾巴
      conversation.push({
        role: 'user',
        content: '请联网查证后补充。不要复述上面已经说过的内容，只讲新查到的。'
      })
      pendingTurn = 'explain' // 这是「再讲一遍」，不是追问
      pendingForceTool = 'web'
      renderConversation()
      ask()
    }

    // 交接：把这次问答（连同网页上下文）交给 DSH 继续。
    // 两种形态由设置决定——「在 DSH 里继续」（默认）或「复制交接单」。
    // 逻辑内联在这里，是为了少一处跨函数的状态；设置现场读取，改了立刻生效。
    var actions = document.createElement('div')
    actions.className = 'dsh-te-actions'

    // 自带 API 模式下没有联网工具（那是 DSH 的能力），索性不显示这个按钮，
    // 而不是摆一个点了没用的东西。
    // 联网是 DSH 提供的能力；「自己的 API」与「免费模型」都没有，所以不建这个按钮
    var webEl = backendMode === 'dsh' ? document.createElement('button') : null
    if (webEl !== null) {
      webEl.className = 'dsh-te-handoff'
      webEl.type = 'button'
      webEl.textContent = '🌐 联网搜索'
    webEl.title = '让 AI 现在就去联网查一次，把新查到的补给你（不会重复已经讲过的内容）'
    webEl.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      forceWebSearch()
    })
    }
    if (webEl !== null) actions.appendChild(webEl)

    var handoffEl = document.createElement('button')
    handoffEl.className = 'dsh-te-handoff'
    handoffEl.type = 'button'
    // 初始文案（之前漏了，按钮在浮窗底部是空白的）
    handoffEl.textContent = backendMode === 'dsh' ? '在 DSH 里继续' : '复制交接单'
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
        // 自带 API 模式没有 DSH 可开新会话，只能复制交接单
        if (backendMode !== 'dsh' || stored.handoffMode === 'clipboard') {
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
    if (userPos === null) {
      panelEl.style.left = Math.round(left) + 'px'
      panelEl.style.top = Math.round(box.top + box.height + 10) + 'px'
    } else {
      panelEl.style.left = Math.round(userPos.left) + 'px'
      panelEl.style.top = Math.round(userPos.top) + 'px'
    }

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
    var turnForThisRequest = pendingTurn
    pendingForceTool = null
    pendingTurn = 'explain'
    chrome.runtime.sendMessage(
      {
        type: 'text-explain/start',
        requestId: activeRequestId,
        messages: buildMessages(),
        forceTool: forceToolForThisRequest,
        turn: turnForThisRequest,
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
    pendingTurn = 'followup'
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

  // 解锁划词的第 ② 步挂在这里：window 的**捕获阶段**是整条事件路上最早的一站，
  // 站点不管把拦截器挂在 document、body 还是具体元素上，都会被我们抢先按住。
  window.addEventListener('selectstart', blockSelectStart, true)

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

  chrome.storage.local.get(
    { level: 'plain', triggerMode: 'context-menu', backend: 'dsh', unlockSelection: true },
    function (stored) {
      backendMode =
        stored.backend === 'custom' || stored.backend === 'free' ? stored.backend : 'dsh'
      currentLevel = normalizeLevel(stored.level)
    triggerMode =
      stored.triggerMode === 'selection-button' || stored.triggerMode === 'both'
        ? stored.triggerMode
        : 'context-menu'
      // 默认开：只有明确存成 false 才算关（老设置里没有这个键，那也是开）
      unlockEnabled = stored.unlockSelection !== false
      applyUnlock()
  })

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return
    if (changes.backend) {
      var next = changes.backend.newValue
      backendMode = next === 'custom' || next === 'free' ? next : 'dsh'
    }
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
    if (changes.unlockSelection) {
      unlockEnabled = changes.unlockSelection.newValue !== false
      applyUnlock()
    }
  })
})()
