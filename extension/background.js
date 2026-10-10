/**
 * 扩展的后台（MV3 service worker）。
 *
 * 为什么请求要在这里发、而不是在内容脚本里发：
 * 内容脚本跑在**网页自己的来源**下，它发的 fetch 会带上那个网站的 Origin，
 * 于是被浏览器的跨源策略拦住（我们没有、也不该把全网都加进后端白名单）。
 * service worker 的 fetch 带的是**扩展自己的来源**，配合 manifest 里的
 * host_permissions，可以直接访问本机后端，不受跨源限制。
 *
 * 流式回传：message 通道本身不支持流，所以这里读 SSE，再逐片用
 * chrome.tabs.sendMessage 推回来源标签页。
 */

var DEFAULT_ENDPOINT = 'http://127.0.0.1:3080/api/text-explain/v1'
var LEVELS = ['plain', 'general', 'pro']

function readSettings() {
  return chrome.storage.local
    .get({ endpoint: DEFAULT_ENDPOINT, level: 'plain' })
    .then(function (stored) {
      return {
        endpoint:
          typeof stored.endpoint === 'string' && stored.endpoint.length > 0
            ? stored.endpoint
            : DEFAULT_ENDPOINT,
        level: LEVELS.indexOf(stored.level) >= 0 ? stored.level : 'plain'
      }
    })
}

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

    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'text-explain-' + level,
        messages: [{ role: 'user', content: job.text }],
        stream: true
      })
    })
      .then(function (response) {
        if (!response.ok) {
          return response.text().then(function (detail) {
            throw new Error(
              'HTTP ' + response.status + (detail ? '：' + detail.slice(0, 200) : '')
            )
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
                  send({ type: 'text-explain/error', message: String(parsed.error.message || '后端报错') })
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

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== 'text-explain/start') return false
  var tabId = sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null
  if (tabId === null) {
    sendResponse({ ok: false, message: '找不到来源标签页' })
    return false
  }
  runExplain({
    tabId: tabId,
    requestId: message.requestId,
    text: message.text,
    level: message.level
  })
  sendResponse({ ok: true })
  return false
})

// Clicking the toolbar icon opens the options page.
chrome.action.onClicked.addListener(function () {
  chrome.runtime.openOptionsPage()
})
