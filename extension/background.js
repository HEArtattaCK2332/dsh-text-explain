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
    .get({
      endpoint: DEFAULT_ENDPOINT,
      level: 'plain',
      triggerMode: 'context-menu',
      backend: 'dsh',
      customBaseUrl: '',
      customApiKey: '',
      customModel: '',
      customSystemMerged: false,
      customNoStream: false,
      freeServiceId: 'zhipu-flash',
      freeApiKey: ''
    })
    .then(function (stored) {
      return {
        endpoint:
          typeof stored.endpoint === 'string' && stored.endpoint.length > 0
            ? stored.endpoint
            : DEFAULT_ENDPOINT,
        level: LEVELS.indexOf(stored.level) >= 0 ? stored.level : 'plain',
        triggerMode:
          TRIGGER_MODES.indexOf(stored.triggerMode) >= 0 ? stored.triggerMode : 'context-menu',
        // 「dsh」＝接本机 DSH 插件；「custom」＝接用户自己的 OpenAI 兼容接口
        // dsh（本机）/ custom（自己的 API）/ free（服务商的免费层，地址与模型名在设置里已配好）
        backend: stored.backend === 'custom' || stored.backend === 'free' ? stored.backend : 'dsh',
        customBaseUrl: typeof stored.customBaseUrl === 'string' ? stored.customBaseUrl.trim() : '',
        customApiKey: typeof stored.customApiKey === 'string' ? stored.customApiKey.trim() : '',
        customModel: typeof stored.customModel === 'string' ? stored.customModel.trim() : '',
        customSystemMerged: stored.customSystemMerged === true,
        customNoStream: stored.customNoStream === true,
        freeServiceId: typeof stored.freeServiceId === 'string' ? stored.freeServiceId : 'zhipu-flash',
        freeApiKey: typeof stored.freeApiKey === 'string' ? stored.freeApiKey : ''
      }
    })
}

/**
 * 三档讲法的**内置版**，只给「自带 API」模式用。
 *
 * 为什么要有这一份：接本机 DSH 时，讲法由插件那一侧给；而自带 API 模式没有
 * 我们自己的后端，只能由扩展把风格一起发过去。两边措辞**尽量一致**，
 * 改动时记得同步（lib/index.js 的 LEVELS）。
 */
var LEVEL_PROMPTS = {
  plain:
    '把读者当成完全没接触过这方面知识的人——不一定是技术，也可能是医学、法律、游戏、生活事务。' +
    '用大白话解释下面的文字：' +
    '第一句先讲清「这段话在说什么事」，这一句里不要出现任何术语；碰到术语就当场解释它是干嘛的，' +
    '能用生活里的例子打比方就一定打；先讲是什么，再讲有什么用。宁可啰嗦，也不要漏掉读者不懂的地方。',
  general:
    '把读者当成会用电脑、有常识、但没学过这一行的人。解释下面的文字：第一句先讲清「这段话在说什么事」，' +
    '能不用术语就不用；术语第一次出现时顺手用一句话或括号解释，点到即止；先给结论，再交代为什么；' +
    '关键处给一个短例子帮读者建立直觉。',
  pro:
    '把读者当成同行：熟悉技术，只是没看过这一段的具体语境。解释下面的文字：术语直接用，基础概念不必解释；' +
    '讲机制与取舍——它怎么做、代价是什么、什么情况下不适用；涉及代码或接口时点明关键字段与数据流向；' +
    '写清结论成立的前提与已知的反例或例外。不打比方、不铺垫，直给结论与要点。'
}

/**
 * 按设置决定：这次请求打哪里、带什么头、发什么体。
 *
 * - dsh    ：本机 DSH 插件的 OpenAI 兼容层。三档讲法由它提供，还能强制联网。
 * - custom ：任意 OpenAI 兼容接口（DeepSeek / OpenAI / Gemini / 本机 Ollama…）。
 *            讲法改由扩展自己拼系统提示词；没有联网工具（那是 DSH 的能力）。
 */
function resolveTarget(settings, level, job) {
  var outgoing = Array.isArray(job.messages) && job.messages.length > 0
    ? job.messages.slice()
    : [{ role: 'user', content: String(job.text || '') }]

  // 免费模式与「自己的 API」走同一套拼装：设置里已把地址与模型名落进 custom* 字段。
  // 唯一的区别是没有联网工具（那不是第三方接口的能力），所以不发 forceTool。
  if (settings.backend === 'custom' || settings.backend === 'free') {
    var forceTool = job.forceTool === 'web' || job.forceTool === 'file' ? job.forceTool : null
    var dshBody = {
      model: 'text-explain-' + level,
      messages: outgoing,
      stream: true
    }
    if (forceTool !== null) dshBody.forceTool = forceTool
    // 这一轮是「解释」还是「追问」由前端声明；后端优先听它（点联网搜索属于「重讲」）
    if (job.turn === 'explain' || job.turn === 'followup') dshBody.turn = job.turn
    return {
      url: settings.endpoint.replace(/\/+$/, '') + '/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: dshBody,
      stream: true
    }
  }

  var base = String(settings.customBaseUrl || '').replace(/\/+$/, '')
  if (base.length === 0) throw new Error('还没有填 API 地址')
  var model = String(settings.customModel || '').trim()
  if (model.length === 0) throw new Error('还没有填模型名')

  var style = LEVEL_PROMPTS[level] || LEVEL_PROMPTS.plain
  if (settings.customSystemMerged === true && outgoing.length > 0 && outgoing[0].role === 'user') {
    // 有些本地模型不认 system 角色：并进第一条 user 消息
    outgoing[0] = { role: 'user', content: style + '\n\n---\n\n' + outgoing[0].content }
  } else {
    outgoing.unshift({ role: 'system', content: style })
  }

  var headers = { 'Content-Type': 'application/json' }
  // 免费模式优先用 freeApiKey（设置页那一栏），否则回落到 customApiKey
  var apiKey = settings.backend === 'free' && settings.freeApiKey
    ? settings.freeApiKey
    : settings.customApiKey
  if (apiKey && apiKey.length > 0) headers.Authorization = 'Bearer ' + apiKey

  return {
    url: base + '/chat/completions',
    headers: headers,
    body: {
      model: model,
      messages: outgoing,
      stream: settings.customNoStream !== true
    },
    stream: settings.customNoStream !== true
  }
}

// ---- 右键菜单 ----

/**
 * 按设置建/撤右键项。「划词即出按钮」模式下不建，免得两处都被打扰。
 *
 * ⚠️ 必须**串行**，而且 create 之后要读 lastError。
 * 原因：service worker 冷启动时，顶层代码会调一次，onInstalled / onStartup 又各调一次；
 * 几次并发就会在 removeAll 与 create 之间交错，于是同一个 id 被建两遍，
 * Chrome 便报 "Cannot create item with duplicate id"（扩展页上就是这么一条红字）。
 */
var menuChain = Promise.resolve()

function syncContextMenu(mode) {
  menuChain = menuChain.then(function () {
    return new Promise(function (resolve) {
      chrome.contextMenus.removeAll(function () {
        if (mode === 'selection-button') {
          resolve()
          return
        }
        chrome.contextMenus.create(
          { id: MENU_ID, title: '用大白话解释「%s」', contexts: ['selection'] },
          function () {
            if (chrome.runtime.lastError) {
              /* 极端情况下仍可能撞上；忽略即可，下一次同步会重建 */
            }
            resolve()
          }
        )
      })
    })
  })
  return menuChain
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
    chrome.tabs.sendMessage(
      tab.id,
      {
        type: 'text-explain/open',
        text: String(info.selectionText || '')
      },
      function () {
        // 同上：必须读 lastError，否则 Chrome 会记一条未检查的错误
        if (chrome.runtime.lastError) {
          /* 该页没有内容脚本（例如 chrome:// 页），忽略 */
        }
      }
    )
  } catch (_error) {
    /* 该标签页不允许注入，忽略 */
  }
})

// ---- 请求 ----

function runExplain(job) {
  return readSettings().then(function (settings) {
    var level = LEVELS.indexOf(job.level) >= 0 ? job.level : settings.level

    function send(payload) {
      try {
        // 回调里必须读一下 lastError：目标页可能没有内容脚本（chrome:// 页、
        // 刚装扩展还没刷新的页、PDF 阅读器…），那时 sendMessage 会失败。
        // 不读它，Chrome 就会在扩展页上标一条「未检查的错误」（background.js:0）。
        chrome.tabs.sendMessage(
          job.tabId,
          Object.assign({ requestId: job.requestId }, payload),
          function () {
            if (chrome.runtime.lastError) {
              /* 收不到就算了，不必打扰用户 */
            }
          }
        )
      } catch (_error) {
        /* 标签页可能已经关了，忽略 */
      }
    }

    var target
    try {
      target = resolveTarget(settings, level, job)
    } catch (error) {
      send({ type: 'text-explain/error', message: error && error.message ? error.message : String(error) })
      return
    }
    var url = target.url

    return fetch(url, {
      method: 'POST',
      headers: target.headers,
      body: JSON.stringify(target.body)
    })
      .then(function (response) {
        if (!response.ok) {
          return response.text().then(function (detail) {
            throw new Error('HTTP ' + response.status + (detail ? '：' + detail.slice(0, 200) : ''))
          })
        }
        // 自定义后端可能被设成「不用流式」（少数服务不支持 SSE），
        // 那时响应是一份普通 JSON，一次性取出来即可。
        if (target.stream === false) {
          return response.json().then(function (data) {
            var choice = data && data.choices && data.choices[0]
            var text =
              choice && choice.message && typeof choice.message.content === 'string'
                ? choice.message.content
                : ''
            if (text.length === 0) {
              send({ type: 'text-explain/error', message: '接口没有返回内容（检查模型名与地址）' })
              return
            }
            send({ type: 'text-explain/chunk', text: text })
            send({ type: 'text-explain/done' })
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
    turn: message.turn,
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
