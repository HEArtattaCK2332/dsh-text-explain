/**
 * 极简 Markdown → HTML（够解释文本用）。
 *
 * 为什么不用 marked / markdown-it：扩展要小、要零依赖，而且解释文本的语法
 * 就那么几种，完整规范用不上。
 *
 * 支持：围栏代码块、行内代码、粗体、斜体、三级标题、无序/有序列表、引用、链接、段落。
 *
 * ⚠️ 安全：**先转义 HTML，再套标记**。这一段渲染的内容来自模型，而模型看到的
 * 又是网页上的文字——不转义就等于把任意网页内容当 HTML 执行。这一步绝不能省。
 *
 * 这个文件在 manifest 里排在 content.js 之前，两者共享同一个作用域，
 * 所以这里定义的全局函数，content.js 直接拿来用；Node 侧的自检也能直接 eval 它。
 */
var TextExplainMarkdown = (function () {
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  /** 行内标记：先转义，再替换。 */
  function inline(text) {
    var out = escapeHtml(text)
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
    return out
  }

  function renderMarkdown(source) {
    if (typeof source !== 'string' || source.length === 0) return ''
    var lines = source.replace(/\r\n?/g, '\n').split('\n')
    var html = []
    var paragraph = []
    var listType = null // 'ul' | 'ol'
    var inCode = false
    var codeLines = []

    function flushParagraph() {
      if (paragraph.length === 0) return
      html.push('<p>' + inline(paragraph.join(' ')) + '</p>')
      paragraph = []
    }

    function flushList() {
      if (listType === null) return
      html.push('</' + listType + '>')
      listType = null
    }

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i]

      if (/^\s*```/.test(line)) {
        if (inCode) {
          html.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>')
          codeLines = []
          inCode = false
        } else {
          flushParagraph()
          flushList()
          inCode = true
        }
        continue
      }
      if (inCode) {
        codeLines.push(line)
        continue
      }

      if (/^\s*$/.test(line)) {
        flushParagraph()
        flushList()
        continue
      }

      var heading = line.match(/^\s*(#{1,3})\s+(.*)$/)
      if (heading) {
        flushParagraph()
        flushList()
        var level = heading[1].length
        html.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>')
        continue
      }

      var quote = line.match(/^\s*>\s?(.*)$/)
      if (quote) {
        flushParagraph()
        flushList()
        html.push('<blockquote>' + inline(quote[1]) + '</blockquote>')
        continue
      }

      var bullet = line.match(/^\s*[-*+]\s+(.*)$/)
      if (bullet) {
        flushParagraph()
        if (listType !== 'ul') {
          flushList()
          html.push('<ul>')
          listType = 'ul'
        }
        html.push('<li>' + inline(bullet[1]) + '</li>')
        continue
      }

      var ordered = line.match(/^\s*\d+[.)]\s+(.*)$/)
      if (ordered) {
        flushParagraph()
        if (listType !== 'ol') {
          flushList()
          html.push('<ol>')
          listType = 'ol'
        }
        html.push('<li>' + inline(ordered[1]) + '</li>')
        continue
      }

      flushList()
      paragraph.push(line.trim())
    }

    if (inCode) html.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>')
    flushParagraph()
    flushList()
    return html.join('')
  }

  return renderMarkdown
})()
