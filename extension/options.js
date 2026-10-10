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
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'moonshot', label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'ollama', label: 'Ollama（本机）', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
  { id: 'lmstudio', label: 'LM Studio（本机）', baseUrl: 'http://localhost:1234/v1', model: 'local-model' }
]

var $ = function (id) { return document.getElementById(id) }
var presetInput = $('preset')
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
  return $('backend-custom').checked ? 'custom' : 'dsh'
}

/** 按当前模式决定要去连哪个地址（「测试连接」用）。 */
function activeEndpoint() {
  if (currentBackend() === 'custom') return normalizeEndpoint(baseUrlInput.value)
  return DSH_ENDPOINT
}

function syncBackendVisibility() {
  var isCustom = currentBackend() === 'custom'
  $('custom-card').className = isCustom ? 'card' : 'card hidden'
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
      customNoStream: false
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
      syncBackendVisibility()
    }
  )
  $('extid').textContent = 'chrome-extension://' + chrome.runtime.id
}

$('backend-dsh').addEventListener('change', syncBackendVisibility)
$('backend-custom').addEventListener('change', syncBackendVisibility)

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

$('test').addEventListener('click', function () {
  var base = activeEndpoint()
  if (base.length === 0) {
    setResult('请先填 API 地址', 'bad')
    return
  }
  setResult('正在测试…', '')
  var isCustom = currentBackend() === 'custom'
  var url = isCustom ? base + '/models' : base + '/models'

  function go() {
    fetch(url, {
      headers: isCustom && apiKeyInput.value.trim().length > 0
        ? { Authorization: 'Bearer ' + apiKeyInput.value.trim() }
        : {}
    })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
      .then(function (data) {
        var ids = (data && data.data ? data.data : []).map(function (item) { return item.id })
        if (ids.length === 0) {
          setResult('连上了 ✓（该服务没有返回模型清单，属正常）', 'ok')
          return
        }
        setResult('通了 ✓  可用模型：' + ids.slice(0, 8).join('、') + (ids.length > 8 ? ' …' : ''), 'ok')
      })
      .catch(function (error) {
        setResult(
          '连不上：' + (error && error.message ? error.message : String(error)) +
            (isCustom
              ? '\n检查地址是否填到 /v1、Key 是否正确、以及该服务是否允许浏览器直连。'
              : '\n请确认 DSH 正在运行（且 dsh-text-explain 插件已启用）。'),
          'bad'
        )
      })
  }

  if (isCustom) {
    ensureOriginPermission(base).then(function (outcome) {
      if (outcome.ok) go()
      else setResult(outcome.message || '没有该域名的权限', 'bad')
    })
    return
  }
  go()
})

fillPresets()
load()
