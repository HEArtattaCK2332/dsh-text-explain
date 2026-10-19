/**
 * 设置页逻辑：读写 chrome.storage.local、按模式申请域名权限，并能当场测一次连接。
 *
 * 「测试连接」为什么重要：这个扩展的价值全押在「后端活着」这一件事上。
 * 与其让用户在网页上划词试错，不如在这里一眼看出通不通。
 */
var DSH_ENDPOINT = 'http://127.0.0.1:3080/api/text-explain/v1'
var LEVELS = ['plain', 'general', 'pro']
var TRIGGER_MODES = ['context-menu', 'selection-button', 'both']

/**
 * 常用服务预设。全部是 **OpenAI 兼容端点**——这正是「一份代码兼容各家」的底气：
 * DeepSeek、OpenAI、Gemini、智谱、Kimi 与本机的 Ollama / LM Studio 都讲这套协议。
 */
var PRESETS = [
  { id: '', label: '—— 选择后自动填下方两项 ——', baseUrl: '', model: '' },

  // —— 免费优先（服务商自己提供的免费层，不花钱）——
  // 注：这些是服务商对外的免费额度，与我们无关；别把它和「某个翻译扩展替你付钱」混为一谈，
  //     后者只对那个扩展自己开放，第三方拿不到。
  { id: 'zhipu-flash', label: '⭐ 智谱 GLM-4.7-Flash（免费 · 国内直连）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash' },
  { id: 'qwen', label: '通义千问（每模型 100 万 token · 90 天）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'gemini', label: 'Google Gemini（免费层每日重置 · 需代理）', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  { id: 'groq', label: 'Groq（免费层 30 次/分 · 需代理）', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' },
  { id: 'openrouter', label: 'OpenRouter（选带 :free 后缀的模型）', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemma-4-31b-it:free' },
  { id: 'ollama', label: 'Ollama（本机运行 · 完全免费）', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
  { id: 'lmstudio', label: 'LM Studio（本机运行 · 完全免费）', baseUrl: 'http://localhost:1234/v1', model: 'local-model' },

  // —— 付费（便宜、稳、额度大）——
  { id: 'deepseek', label: 'DeepSeek（便宜）', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI（付费）', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'moonshot', label: '月之暗面 Kimi（实名送券）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' }
]

var $ = function (id) { return document.getElementById(id) }

/**
 * 「免费模型」模式下可选的免费服务。
 *
 * 只收**服务商自己对外提供的免费层**（注册就能拿 Key）。
 * 注意区分：某些翻译扩展的「免费」是它自己买额度搭中转，那只对它自己开放，我们拿不到——
 * 所以我们这里**不代付、不中转**，只把地址与模型名配好，Key 由用户自己申请。
 *
 * 数据来源：free-llm-intel（每日对照官方页自动更新）2026-10-11 快照。
 */
var FREE_SERVICES = [
  {
    id: 'zhipu-flash',
    label: '⭐ 智谱 GLM-4.7-Flash（推荐：长期 0 元 · 国内直连）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.7-flash',
    applyUrl: 'https://bigmodel.cn/',
    note: '国内直连、不需要代理；20 万上下文，长期 0 元。' +
      '申请：打开官网 → 右上角「登录 / 注册」（手机号，需实名）→ 再点右上角「控制台」→ ' +
      '在控制台里找「API Keys」新建一个。注意：首页大力推的 GLM-5.3 系列是**付费**的，' +
      '免费的是 4.x 代 Flash，别点错。'
  },
  {
    id: 'qwen',
    label: '通义千问（每个模型 100 万 token · 90 天）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    applyUrl: 'https://bailian.console.aliyun.com/',
    note: '国内直连。申请：阿里云账号登录 → 百炼控制台 → 右上角「API-KEY」新建。' +
      '注意这是**一次性**额度（每个模型 100 万 token、90 天有效），不是长期免费。'
  },
  {
    id: 'ollama',
    label: 'Ollama（跑在自己电脑上 · 完全免费 · 数据不出本机）',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1',
    applyUrl: 'https://ollama.com/download',
    note: '不用申请 Key（这一栏留空即可）。申请：去官网下载安装，然后拉一个模型' +
      '（如 ollama pull llama3.1）。数据不出本机。'
  },
  {
    id: 'gemini',
    label: 'Google Gemini（免费层每日重置 · 需要代理）',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-2.5-flash',
    applyUrl: 'https://aistudio.google.com/',
    note: '能力较强，但国内访问需要代理。申请：Google 账号登录 AI Studio → ' +
      '左侧「Get API key」→ 新建。免费层每日重置。'
  },
  {
    id: 'groq',
    label: 'Groq（免费层 30 次/分 · 需要代理）',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    applyUrl: 'https://console.groq.com/',
    note: '出词极快，适合追求速度；国内访问需要代理。申请：注册登录 → 左侧「API Keys」→ 新建。'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter（选带 :free 后缀的模型 · 需要代理）',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemma-4-31b-it:free',
    applyUrl: 'https://openrouter.ai/',
    note: '一个账号能用多家免费模型；申请：登录 → 右上角头像 →「Keys」→ 新建。' +
      '务必确认模型名带 :free，否则会按量扣费。'
  }
]

function findFreeService(id) {
  for (var i = 0; i < FREE_SERVICES.length; i += 1) {
    if (FREE_SERVICES[i].id === id) return FREE_SERVICES[i]
  }
  return FREE_SERVICES[0]
}

function currentFreeService() {
  return findFreeService(freePickInput ? freePickInput.value : FREE_SERVICES[0].id)
}
var presetInput = $('preset')
var freePickInput = $('free-pick')
var freeKeyInput = $('free-key')
var freeNoteEl = $('free-note')
var freeStatusEl = $('free-status')
var baseUrlInput = $('customBaseUrl')
var modelInput = $('customModel')
var apiKeyInput = $('customApiKey')
var triggerInput = $('trigger')
var handoffInput = $('handoff')
var levelInput = $('level')
var resultEl = $('result')

function setResult(text, kind) {
  resultEl.textContent = text
  resultEl.className = kind || ''
}

function normalizeEndpoint(value) {
  var text = typeof value === 'string' ? value.trim() : ''
  return text.replace(/\/+$/, '')
}

function currentBackend() {
  if ($('backend-free').checked) return 'free'
  return $('backend-custom').checked ? 'custom' : 'dsh'
}

/** 按当前模式决定要去连哪个地址（「测试连接」用）。 */
function activeEndpoint() {
  var backend = currentBackend()
  if (backend === 'custom') return normalizeEndpoint(baseUrlInput.value)
  if (backend === 'free') return normalizeEndpoint(currentFreeService().baseUrl)
  return DSH_ENDPOINT
}

function syncBackendVisibility() {
  var backend = currentBackend()
  $('custom-card').className = backend === 'custom' ? 'card' : 'card hidden'
  $('free-card').className = backend === 'free' ? 'card' : 'card hidden'
}

/**
 * 申请访问某个域名的权限。
 *
 * MV3 的规矩：扩展不能预先拿到全网权限，只能**按用户填的地址逐个申请**。
 * 所以这里用 optional_host_permissions ＋ 运行时 request，而不是在 manifest 里要「所有网站」。
 */
function ensureOriginPermission(baseUrl) {
  return new Promise(function (resolve) {
    var origin
    try {
      origin = new URL(baseUrl).origin + '/*'
    } catch (_error) {
      resolve({ ok: false, message: '地址填得不对（要形如 https://api.deepseek.com/v1）' })
      return
    }
    chrome.permissions.contains({ origins: [origin] }, function (already) {
      if (already) {
        resolve({ ok: true })
        return
      }
      chrome.permissions.request({ origins: [origin] }, function (granted) {
        resolve(
          granted === true
            ? { ok: true }
            : { ok: false, message: '没有授权访问 ' + origin + '，这个地址就连不上了' }
        )
      })
    })
  })
}

/** 把免费服务填进下拉，并把当前选中的那个反映到提示与按钮上。 */
function syncFreePick() {
  var service = currentFreeService()
  if (freeNoteEl) freeNoteEl.textContent = service.note
  if (freePickInput) freePickInput.setAttribute('data-apply-url', service.applyUrl)
}

function fillFreeServices() {
  FREE_SERVICES.forEach(function (service) {
    var option = document.createElement('option')
    option.value = service.id
    option.textContent = service.label
    freePickInput.appendChild(option)
  })
  freePickInput.addEventListener('change', syncFreePick)
  syncFreePick()
}

function fillPresets() {
  PRESETS.forEach(function (preset) {
    var option = document.createElement('option')
    option.value = preset.id
    option.textContent = preset.label
    presetInput.appendChild(option)
  })
}

function load() {
  chrome.storage.local.get(
    {
      endpoint: DSH_ENDPOINT,
      level: 'plain',
      triggerMode: 'context-menu',
      handoffMode: 'session',
      backend: 'dsh',
      customBaseUrl: '',
      customApiKey: '',
      customModel: '',
      customSystemMerged: false,
      customNoStream: false,
      unlockSelection: true
    },
    function (stored) {
      $('backend-dsh').checked = stored.backend !== 'custom'
      $('backend-custom').checked = stored.backend === 'custom'
      baseUrlInput.value = stored.customBaseUrl || ''
      modelInput.value = stored.customModel || ''
      apiKeyInput.value = stored.customApiKey || ''
      $('customSystemMerged').checked = stored.customSystemMerged === true
      $('customNoStream').checked = stored.customNoStream === true
      levelInput.value = LEVELS.indexOf(stored.level) >= 0 ? stored.level : 'plain'
      triggerInput.value =
        TRIGGER_MODES.indexOf(stored.triggerMode) >= 0 ? stored.triggerMode : 'context-menu'
      handoffInput.value = stored.handoffMode === 'clipboard' ? 'clipboard' : 'session'
      // 默认开：老设置里没这个键时也要勾上（否则用户一进设置页会以为它被关了）
      $('unlockSelection').checked = stored.unlockSelection !== false
      $('backend-free').checked = stored.backend === 'free'
      if (stored.freeServiceId) freePickInput.value = stored.freeServiceId
      freeKeyInput.value = stored.freeApiKey || ''
      syncFreePick()
      syncBackendVisibility()
    }
  )
  $('extid').textContent = 'chrome-extension://' + chrome.runtime.id
}

// 三个后端选项都要绑：这里用循环而不是逐个写死——
// 之前就是漏了「免费模型」那个，导致点它时下面的卡片不出现，刷新才出。
;['backend-dsh', 'backend-free', 'backend-custom'].forEach(function (id) {
  $(id).addEventListener('change', syncBackendVisibility)
})

presetInput.addEventListener('change', function () {
  var picked = PRESETS.filter(function (item) { return item.id === presetInput.value })[0]
  if (!picked || picked.id === '') return
  baseUrlInput.value = picked.baseUrl
  modelInput.value = picked.model
})

$('save').addEventListener('click', function () {
  var backend = currentBackend()
  var baseUrl = normalizeEndpoint(baseUrlInput.value)

  function persist() {
    chrome.storage.local.set(
      {
        endpoint: DSH_ENDPOINT,
        backend: backend,
        customBaseUrl: baseUrl,
        customApiKey: apiKeyInput.value.trim(),
        customModel: modelInput.value.trim(),
        customSystemMerged: $('customSystemMerged').checked,
        customNoStream: $('customNoStream').checked,
        unlockSelection: $('unlockSelection').checked,
        level: LEVELS.indexOf(levelInput.value) >= 0 ? levelInput.value : 'plain',
        triggerMode:
          TRIGGER_MODES.indexOf(triggerInput.value) >= 0 ? triggerInput.value : 'context-menu',
        handoffMode: handoffInput.value === 'clipboard' ? 'clipboard' : 'session'
      },
      function () {
        setResult('已保存 ✓', 'ok')
      }
    )
  }

  if (backend === 'free') {
    var freeService = currentFreeService()
    // 免费服务里只有本机 Ollama 不需要 Key，其余都要——但 Key 是否填对，
    // 交给「测试连接」去判，不在保存时拦人（有人可能先存设置再去申请）。
    chrome.storage.local.set(
      {
        endpoint: DSH_ENDPOINT,
        backend: 'free',
        freeServiceId: freeService.id,
        freeApiKey: freeKeyInput.value.trim(),
        // 同时把地址与模型名落到 custom* 字段：内容脚本与后台读它们即可，
        // 不必为免费模式再加一套取值分支。
        customBaseUrl: freeService.baseUrl,
        customModel: freeService.model,
        unlockSelection: $('unlockSelection').checked,
        level: LEVELS.indexOf(levelInput.value) >= 0 ? levelInput.value : 'plain',
        triggerMode:
          TRIGGER_MODES.indexOf(triggerInput.value) >= 0 ? triggerInput.value : 'context-menu',
        handoffMode: handoffInput.value === 'clipboard' ? 'clipboard' : 'session'
      },
      function () {
        setResult('已保存 ✓ 现在按「测试连接」看看通不通', 'ok')
      }
    )
    return
  }

  if (backend !== 'custom') {
    persist()
    return
  }
  if (baseUrl.length === 0) {
    setResult('选了「我自己的 API」，请先填 API 地址', 'bad')
    return
  }
  if (modelInput.value.trim().length === 0) {
    setResult('请填模型名（例如 deepseek-chat）', 'bad')
    return
  }
  setResult('正在申请访问该域名的权限…', '')
  ensureOriginPermission(baseUrl).then(function (outcome) {
    if (!outcome.ok) {
      setResult(outcome.message || '授权失败', 'bad')
      return
    }
    persist()
  })
})

/** 按当前后端给出「该填什么、去哪填」的提示，而不是一律说 DSH。 */
function backendAdvice(backend) {
  if (backend === 'dsh') {
    return '\n请确认 DSH 正在运行（且 dsh-text-explain 插件已启用）。'
  }
  if (backend === 'free') {
    return '\n常见原因：① Key 没填或填错；② 拿错了平台的 Key（例如智谱有「清言」与「开放平台」两套，' +
      'Key 不通用，本插件要的是开放平台那个）；③ 该账号还没完成实名。'
  }
  return '\n检查地址是否填到 /v1、Key 是否正确、以及该服务是否允许浏览器直连。'
}

/**
 * 探活：真发一次最小的对话请求。
 *
 * 为什么不再用 /models：那个接口**不是所有服务都实现**——有的返回 401、有的 404，
 * 于是「明明能用却报连不上」。发一次 chat 请求才是真的验证，而且顺带确认模型名对得上。
 */
function probeOnce(baseUrl, apiKey, model) {
  var headers = { 'Content-Type': 'application/json' }
  if (apiKey && apiKey.length > 0) headers.Authorization = 'Bearer ' + apiKey
  return fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: '请回复两个字：可以' }],
      max_tokens: 16,
      stream: false
    })
  }).then(function (response) {
    return response.text().then(function (text) {
      return { status: response.status, text: text }
    })
  })
}

$('test').addEventListener('click', function () {
  var backend = currentBackend()
  var base = activeEndpoint()
  if (base.length === 0) {
    setResult('请先填 API 地址', 'bad')
    return
  }
  setResult('正在测试…', '')
  var isDsh = backend === 'dsh'

  function go() {
    if (isDsh) {
      // DSH 那边是自家端点，取模型清单最直接
      fetch(base + '/models')
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        })
        .then(function (data) {
          var ids = (data && data.data ? data.data : []).map(function (item) { return item.id })
          setResult('通了 ✓  DSH 在线，可用讲法：' + ids.slice(0, 8).join('、'), 'ok')
        })
        .catch(function (error) {
          setResult('连不上：' + (error && error.message ? error.message : String(error)) + backendAdvice(backend), 'bad')
        })
      return
    }

    var service = backend === 'free' ? currentFreeService() : null
    var apiKey = backend === 'free' ? freeKeyInput.value.trim() : apiKeyInput.value.trim()
    var model = backend === 'free' ? service.model : modelInput.value.trim()
    if (model.length === 0) {
      setResult('请先填模型名', 'bad')
      return
    }
    probeOnce(base, apiKey, model)
      .then(function (result) {
        if (result.status === 200) {
          setResult('通了 ✓  ' + model + ' 已经能正常回话', 'ok')
          return
        }
        var hint = ''
        if (result.status === 401 || result.status === 403) {
          hint = '（对方不认这个 Key）'
        } else if (result.status === 404) {
          hint = '（地址或模型名不对）'
        } else if (result.status === 429) {
          hint = '（请求太频繁，撞上限速了）'
        }
        setResult(
          '连不上：HTTP ' + result.status + ' ' + hint + '\n' +
            String(result.text || '').slice(0, 200) + backendAdvice(backend),
          'bad'
        )
      })
      .catch(function (error) {
        setResult(
          '连不上：' + (error && error.message ? error.message : String(error)) + backendAdvice(backend),
          'bad'
        )
      })
  }

  if (backend === 'dsh') {
    go()
    return
  }
  ensureOriginPermission(base).then(function (outcome) {
    if (outcome.ok) go()
    else setResult(outcome.message || '没有该域名的权限', 'bad')
  })
})

fillPresets()
fillFreeServices()

// 「去申请免费 Key →」：直接打开对应服务商的申请页
$('free-apply').addEventListener('click', function () {
  var url = currentFreeService().applyUrl
  if (url) window.open(url, '_blank', 'noopener')
})

load()
