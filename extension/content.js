/**
 * 内容脚本：划词/右键 → 浮窗 → 流式解释。
 *
 * 界面整个放在一个 **Shadow DOM** 里：既不让页面的 CSS 污染浮窗，
 * 也不必把我们的样式洒进别人的页面。
 *
 * 触发方式由设置决定（默认「右键菜单」）：
 *   - context-menu     只认右键菜单里的那一项（默认，日常浏览最不打扰）
 *   - selection-button 只认划词后浮出的小按钮
 *   - both             两者都要
 *
 * 请求本身不在这里发 —— 交给后台的 service worker（原因见 background.js 顶部）。
 */
(function () {
  if (window.__dshTextExplainLoaded === true) return
  window.__dshTextExplainLoaded = true

  var LEVELS = ['plain', 'general', 'pro']
  var LEVEL_LABELS = { plain: '小白', general: '通识', pro: '专业' }
  var LEVEL_ALIASES = { expert: 'pro' } // 四档时代的旧值，平滑迁移

  var host = null
  var shadow = null
  var triggerEl = null
  var panelEl = null
  var bodyEl = null
  var statusEl = null
  var errorEl = null
  var levelButtons = {}

  var currentLevel = 'plain'
  var triggerMode = 'context-menu'
  var activeRequestId = null
  var renderedSoFar = ''
  var pendingText = ''

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

  /** 页面坐标（把视口坐标加上滚动量，浮窗才不会跟着滚跑）。 */
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
    pendingText = text
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
        openPanel(pendingText)
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
      statusEl = null
      errorEl = null
      levelButtons = {}
    }
    activeRequestId = null
    renderedSoFar = ''
  }

  function setStatus(text) {
    if (statusEl !== null) {
      statusEl.textContent = text
      statusEl.style.display = text ? 'block' : 'none'
    }
  }

  function setError(text) {
    if (errorEl === null) return
    errorEl.textContent = text
    errorEl.style.display = text ? 'block' : 'none'
  }

  function paintMarkdown() {
    if (bodyEl === null) return
    bodyEl.innerHTML = TextExplainMarkdown(renderedSoFar)
  }

  function syncLevelButtons() {
    LEVELS.forEach(function (id) {
      var button = levelButtons[id]
      if (button) button.setAttribute('data-on', id === currentLevel ? '1' : '0')
    })
  }

  function openPanel(text) {
    var content = String(text || '').trim()
    if (content.length === 0) return
    closePanel()
    ensureHost()
    hideTrigger()
    renderedSoFar = ''

    panelEl = document.createElement('div')
    panelEl.className = 'dsh-te-panel'
    panelEl.addEventListener('mousedown', function (event) {
      event.stopPropagation()
    })

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
        startExplain(content)
      })
      levelButtons[id] = button
      levels.appendChild(button)
    })
    head.appendChild(levels)

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

    statusEl = document.createElement('div')
    statusEl.className = 'dsh-te-status'
    panelEl.appendChild(statusEl)

    errorEl = document.createElement('div')
    errorEl.className = 'dsh-te-error'
    errorEl.style.display = 'none'
    panelEl.appendChild(errorEl)

    uiRoot().appendChild(panelEl)
    syncLevelButtons()

    var rect = currentSelectionRect()
    var box = rect === null ? { left: 40 + window.scrollX, top: 80 + window.scrollY, width: 0, height: 0 } : pageRect(rect)
    var width = 420
    var left = Math.min(Math.max(8, box.left), Math.max(8, window.scrollX + window.innerWidth - width - 16))
    panelEl.style.left = Math.round(left) + 'px'
    panelEl.style.top = Math.round(box.top + box.height + 10) + 'px'

    startExplain(content)
  }

  function startExplain(text) {
    if (panelEl === null) return
    renderedSoFar = ''
    paintMarkdown()
    setError('')
    setStatus('正在解释…')
    activeRequestId = 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    chrome.runtime.sendMessage(
      {
        type: 'text-explain/start',
        requestId: activeRequestId,
        text: text,
        level: currentLevel
      },
      function (response) {
        if (chrome.runtime.lastError) {
          setError('扩展后台没有响应：' + chrome.runtime.lastError.message)
          setStatus('')
          return
        }
        if (!response || response.ok !== true) {
          setError((response && response.message) || '无法开始请求')
          setStatus('')
        }
      }
    )
  }

  // ---- 后台推回来的流 ----

  chrome.runtime.onMessage.addListener(function (message) {
    // 右键菜单来的指令：用菜单里带的文字开浮窗
    if (message && message.type === 'text-explain/open') {
      // 右键时选区还在，优先用页面上的选区（更准）；没有就用菜单传回来的
      var text = currentSelectionText() || String(message.text || '')
      openPanel(text)
      return
    }
    if (!message || message.requestId !== activeRequestId) return
    if (message.type === 'text-explain/chunk') {
      renderedSoFar += message.text
      paintMarkdown()
      if (bodyEl !== null) bodyEl.scrollTop = bodyEl.scrollHeight
      return
    }
    if (message.type === 'text-explain/done') {
      setStatus('')
      activeRequestId = null
      return
    }
    if (message.type === 'text-explain/error') {
      setError(message.message || '出错了')
      setStatus('')
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
    closePanel()
  })

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      hideTrigger()
      closePanel()
    }
  })

  window.addEventListener('scroll', hideTrigger, true)

  // 记住上次用的档位与触发方式
  chrome.storage.local.get({ level: 'plain', triggerMode: 'context-menu' }, function (stored) {
    currentLevel = normalizeLevel(stored.level)
    triggerMode =
      stored.triggerMode === 'selection-button' || stored.triggerMode === 'both'
        ? stored.triggerMode
        : 'context-menu'
  })

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes.triggerMode) {
      triggerMode =
        changes.triggerMode.newValue === 'selection-button' || changes.triggerMode.newValue === 'both'
          ? changes.triggerMode.newValue
          : 'context-menu'
      if (!wantsSelectionButton()) hideTrigger()
    }
  })
})()
