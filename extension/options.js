/**
 * 设置页逻辑：读写 chrome.storage.local，并能当场测一次连接。
 *
 * 为什么要有「测试连接」：这个扩展的价值全押在「本机后端活着」这一件事上。
 * 与其让用户在网页上划词试错，不如在这里一眼看出通不通。
 */
var DEFAULT_ENDPOINT = 'http://127.0.0.1:3080/api/text-explain/v1'
var LEVELS = ['plain', 'general', 'pro']
var TRIGGER_MODES = ['context-menu', 'selection-button', 'both']

var endpointInput = document.getElementById('endpoint')
var levelInput = document.getElementById('level')
var triggerInput = document.getElementById('trigger')
var resultEl = document.getElementById('result')

function setResult(text, kind) {
  resultEl.textContent = text
  resultEl.className = kind || ''
}

function normalizeEndpoint(value) {
  var text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) return DEFAULT_ENDPOINT
  return text.replace(/\/+$/, '')
}

function load() {
  chrome.storage.local.get(
    { endpoint: DEFAULT_ENDPOINT, level: 'plain', triggerMode: 'context-menu' },
    function (stored) {
      endpointInput.value = normalizeEndpoint(stored.endpoint)
      levelInput.value = LEVELS.indexOf(stored.level) >= 0 ? stored.level : 'plain'
      triggerInput.value =
        TRIGGER_MODES.indexOf(stored.triggerMode) >= 0 ? stored.triggerMode : 'context-menu'
    }
  )
  document.getElementById('extid').textContent = 'chrome-extension://' + chrome.runtime.id
}

document.getElementById('save').addEventListener('click', function () {
  chrome.storage.local.set(
    {
      endpoint: normalizeEndpoint(endpointInput.value),
      level: LEVELS.indexOf(levelInput.value) >= 0 ? levelInput.value : 'plain',
      triggerMode:
        TRIGGER_MODES.indexOf(triggerInput.value) >= 0 ? triggerInput.value : 'context-menu'
    },
    function () {
      endpointInput.value = normalizeEndpoint(endpointInput.value)
      setResult('已保存 ✓', 'ok')
    }
  )
})

document.getElementById('test').addEventListener('click', function () {
  var base = normalizeEndpoint(endpointInput.value)
  setResult('正在测试…', '')
  fetch(base + '/models')
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json()
    })
    .then(function (data) {
      var ids = (data && data.data ? data.data : []).map(function (item) {
        return item.id
      })
      setResult('通了 ✓  可用模型：' + ids.join('、'), 'ok')
    })
    .catch(function (error) {
      setResult(
        '连不上：' +
          (error && error.message ? error.message : String(error)) +
          '\n请确认 DSH 正在运行（且 dsh-text-explain 插件已启用）。',
        'bad'
      )
    })
})

load()
