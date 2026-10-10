/**
 * 扩展的后台（MV3 service worker）。
 *
 * 职责有二：
 *  1. 右键菜单（**默认**触发方式）——「用大白话解释『选中的字』」；
 *  2. 真正发请求——流式读后端的 SSE，再逐片推回来源标签页。
 *
 * 为什么请求要在这里发、而不是在内容脚本里发：
 * 内容脚本跑在**网页自己的来源**下，它发的 fetch 会带上那个网站的 Origin，
 * 于是被浏览器的跨源策略拦住（我们没有、也不该把全网都加进后端白名单）。
 * service worker 的 fetch 带的是**扩展自己的来源**，配合 manifest 里的
 * host_permissions，可以直接访问本机后端，不受跨源限制。
 */

var DEFAULT_ENDPOINT = 'http://127.0.0.1:3080/api/text-explain/v1'
var LEVELS = ['plain', 'general', 'pro']
var TRIGGER_MODES = ['context-menu', 'selection-button', 'both']
var MENU_ID = 'text-explain-selection'

function readSettings() {
  return chrome.storage.local
    .get({ endpoint: DEFAULT_ENDPOINT, level: 'plain', triggerMode: 'context-menu' })
    .then(function (stored) {
      return {
        endpoint:
          typeof stored.endpoint === 'string' && stored.endpoint.length > 0
            ? stored.endpoint
            : DEFAULT_ENDPOINT,
        level: LEVELS.indexOf(stored.level) >= 0 ? stored.level : 'plain',
        triggerMode:
          TRIGGER_MODES.indexOf(stored.triggerMode) >= 0 ? stored.triggerMode : 'context-menu'
      }
    })
}

// ---- 右键菜单 ----

/** 按设置建/撤右键项。「划词即出按钮」模式下不建，免得两处都被打扰。 */
function syncContextMenu(mode) {
  chrome.contextMenus.removeAll(function () {
    if (mode === 'selection-button') return
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '用大白话解释「%s」',
      contexts: ['selection']
    })
  })
}

function refreshContextMenu() {
  return readSettings().then(function (settings) {
    syncContextMenu(settings.triggerMode)
  })
}

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId !== MENU_ID) return
  if (!tab || typeof tab.id !== 'number') return
  try {
    chrome.tabs.sendMessage(tab.id, {
      type: 'text-explain/open',
      text: String(info.selectionText || '')
    })
  } catch (_error) {
    /* 该标签页不允许注入，忽略 */
  }
})

// ---- 请求 ----

function runExplain(job) {
  return readSettings().then(function (settings) {
    var url = settings.endpoint.replace(/\/+$/, '') + '/chat/completions'
    var level = LEVELS.indexOf(job.level) >= 0 ? job.level : settings.level

    function send(payload) {
      try {
        chrome.tabs.sendMessage(job.tabId, Object.assign({ requestId: job.requestId }, payload))
      } catch (_error) {
        /* 标签页可能已经关了，忽略 */
      }
    }

    // 多轮：内容脚本会把完整对话历史发过来；旧调用只给一段 text 也照样能用。
    var outgoing = Array.isArray(job.messages) && job.messages.length > 0
      ? job.messages
      : [{ role: 'user', content: String(job.text || '') }]
    // 「联网搜索」按钮设的强制标记；没设就不发这个字段，请求保持干净
    var forceTool = job.forceTool === 'web' || job.forceTool === 'file' ? job.forceTool : null

    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign(
        {
          model: 'text-explain-' + level,
          messages: outgoing,
          stream: true
        },
        forceTool === null ? {} : { forceTool: forceTool }
      ))
    })
      .then(function (response) {
        if (!response.ok) {
          return response.text().then(function (detail) {
            throw new Error('HTTP ' + response.status + (detail ? '：' + detail.slice(0, 200) : ''))
          })
        }
        if (!response.body) throw new Error('后端没有返回流')

        var reader = response.body.getReader()
        var decoder = new TextDecoder('utf-8')
        var buffer = ''

        function pump() {
          return reader.read().then(function (result) {
            if (result.done) {
              send({ type: 'text-explain/done' })
              return
            }
            buffer += decoder.decode(result.value, { stream: true })
            var parts = buffer.split('\n\n')
            buffer = parts.pop() || ''
            for (var i = 0; i < parts.length; i += 1) {
              var line = parts[i].trim()
              if (line.indexOf('data:') !== 0) continue
              var data = line.slice(5).trim()
              if (data === '[DONE]') {
                send({ type: 'text-explain/done' })
                return
              }
              try {
                var parsed = JSON.parse(data)
                if (parsed.error) {
                  send({
                    type: 'text-explain/error',
                    message: String(parsed.error.message || '后端报错')
                  })
                  return
                }
                var choice = parsed.choices && parsed.choices[0]
                var delta = choice && choice.delta
                if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
                  send({ type: 'text-explain/chunk', text: delta.content })
                }
              } catch (_error) {
                /* 半个分片，等下一轮补齐 */
              }
            }
            return pump()
          })
        }
        return pump()
      })
      .catch(function (error) {
        send({
          type: 'text-explain/error',
          message: '连不上后端：' + (error && error.message ? error.message : String(error))
        })
      })
  })
}

// ---- 交接：把一次问答交给 DSH 继续 ----

/**
 * 打开（或切到）DSH 页面。
 * DSH 没有「用 URL 打开某个会话」的入口，所以只能打开它——会话由宿主建好，
 * 已打开的页面会经 follow 流自动收到，侧栏里自己就冒出来了。
 */
function focusDsh(base) {
  var root = base.replace(/\/api\/text-explain\/v1$/, '').replace(/\/+$/, '')
  try {
    chrome.tabs.query({ url: root + '/*' }, function (tabs) {
      if (chrome.runtime.lastError) return
      if (tabs && tabs.length > 0 && typeof tabs[0].id === 'number') {
        chrome.tabs.update(tabs[0].id, { active: true })
      } else {
        chrome.tabs.create({ url: root + '/' })
      }
    })
  } catch (_error) {
    /* 打不开就算了：会话已经建好，用户自己切过去也一样 */
  }
}

function handleHandoff(text) {
  return readSettings().then(function (settings) {
    var base = settings.endpoint.replace(/\/+$/, '')
    var root = base.replace(/\/v1$/, '')
    return fetch(root + '/new-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text || '') })
    })
      .then(function (response) {
        if (!response.ok) {
          return response.text().then(function (detail) {
            throw new Error('HTTP ' + response.status + (detail ? '：' + detail.slice(0, 160) : ''))
          })
        }
        return response.json()
      })
      .then(function (data) {
        focusDsh(base)
        return { ok: true, sessionId: data && data.sessionId ? data.sessionId : null }
      })
      .catch(function (error) {
        return { ok: false, message: error && error.message ? error.message : String(error) }
      })
  })
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message) return false

  if (message.type === 'text-explain/handoff') {
    handleHandoff(message.text).then(sendResponse)
    return true // 异步响应
  }

  if (message.type !== 'text-explain/start') return false
  var tabId = sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null
  if (tabId === null) {
    sendResponse({ ok: false, message: '找不到来源标签页' })
    return false
  }
  runExplain({
    tabId: tabId,
    requestId: message.requestId,
    messages: message.messages,
    text: message.text,
    forceTool: message.forceTool,
    level: message.level
  })
  sendResponse({ ok: true })
  return false
})

// ---- 生命周期 ----

chrome.runtime.onInstalled.addListener(refreshContextMenu)
chrome.runtime.onStartup.addListener(refreshContextMenu)
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes.triggerMode) refreshContextMenu()
})
// service worker 冷启动时也保证菜单在位
refreshContextMenu()

// 点扩展图标 → 打开设置页
chrome.action.onClicked.addListener(function () {
  chrome.runtime.openOptionsPage()
})
