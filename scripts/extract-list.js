// [!] 注入式片段，不是独立脚本 —— 用 evalfile 跑：
//     node scripts/browse.cjs evalfile scripts/<name>.js

// 通用列表抽取 v2：按"关键词叶子聚集度"选容器，避免命中导航/侧栏
const km =
  location.href.match(/\/search(?:_result)?\/([^?#]+)/) || location.href.match(/[?&]keyword=([^&#]+)/)
const keyword = km ? decodeURIComponent(km[1].replace(/\+/g, ' ')).trim() : ''
const terms = keyword.split(/[\s,，]+/).filter((t) => t.length >= 2)
const test = (t) => (terms.length ? terms.some((k) => t.includes(k)) : t.length > 20)

// 1) 收集含关键词的叶子节点（排除 script/style，避免抓到内嵌 JSON）
const SKIP_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|META|LINK)$/
const leaves = [...document.querySelectorAll('*')].filter(
  (el) => el.children.length === 0 && !SKIP_TAGS.test(el.tagName) && test(el.textContent || '')
)

// 2) 统计每个候选容器里落了多少叶子
const tally = new Map()
for (const leaf of leaves) {
  let node = leaf
  for (let depth = 0; depth < 8 && node.parentElement; depth++) {
    node = node.parentElement
    const kids = node.children.length
    if (kids >= 3 && kids <= 200) tally.set(node, (tally.get(node) || 0) + 1)
  }
}

// 3) 选叶子最多、子节点不过度膨胀的容器
let list = null
let bestScore = -1
for (const [el, count] of tally) {
  const score = count - el.children.length * 0.12
  if (score > bestScore) {
    bestScore = score
    list = el
  }
}

const cards = list ? [...list.children] : []
const rows = []
const seenTitles = new Set()
for (const card of cards) {
  const text = (card.textContent || '').replace(/\s+/g, ' ').trim()
  if (text.length < 20) continue
  // 过滤非结果块（相关搜索 / 筛选条 / 广告提示 / 平台 AI 摘要块）
  if (/相关搜索|大家都在搜|综合排序|筛选|条评论|猜你喜欢|生成回答|AI\s*生成/.test(text)) continue

  const duration = (text.match(/^(\d{2}:\d{2})/) || [])[1] || ''
  const likes = (text.match(/^\d{2}:\d{2}\s*([\d.]+[万wW]?)/) || [])[1] || ''
  const author = (text.match(/@([^\s·]+)/) || [])[1] || ''
  const date =
    (text.match(
      /((?:20\d{2}-)?\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}日|\d+\s*(?:天|小时|分钟)前|\d{1,2}-\d{1,2})/
    ) || [])[1] || ''
  const tags = [...text.matchAll(/#([^\s#]+)/g)].map((m) => m[1]).slice(0, 6)

  let title = text
    .replace(/^\d{2}:\d{2}/, '')
    .replace(/^[\d.]+[万wW]?/, '')
    .replace(/#[^\s#]+/g, '')
    .replace(/@[^\s·]+/g, '')
    .replace(/·\s*[^·]{0,14}$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  // 小红书卡片里标题常被点赞/日期包裹，兜底取最长的一段非数字文本
  if (title.length < 6) {
    const segments = text
      .split(/[\d.]+[万wW]?|\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 6 && !/^\d+$/.test(s))
      .sort((a, b) => b.length - a.length)
    title = segments[0] || text
  }

  const img = card.querySelector('img')
  const html = card.innerHTML || ''
  const outer = card.outerHTML || ''
  const vid =
    (card.id && (card.id.match(/waterfall_item_(\d{10,})/) || [])[1]) ||
    (html.match(/\/video\/(\d{6,})/) || [])[1] ||
    (outer.match(/aweme_id\\?"\s*:\s*\\?"(\d{10,})/) || [])[1] ||
    (outer.match(/data-(?:vid|id)="(\d{10,})"/) || [])[1] ||
    ''
  const noteId = (html.match(/\/(?:explore|discovery\/item)\/([0-9a-z]{20,})/) || [])[1] || ''
  const hrefRaw = (html.match(/href="([^"]*(?:\/video\/|\/explore\/)[^"]*)"/) || [])[1] || ''
  const link = hrefRaw
    ? hrefRaw.startsWith('http')
      ? hrefRaw.split('?')[0]
      : new URL(hrefRaw, location.origin).href.split('?')[0]
    : vid
      ? `https://www.douyin.com/video/${vid}`
      : noteId
        ? `https://www.xiaohongshu.com/explore/${noteId}`
        : ''

  const dedupeKey = title.slice(0, 40)
  if (seenTitles.has(dedupeKey)) continue
  seenTitles.add(dedupeKey)

  rows.push({
    标题: title.slice(0, 80),
    时长: duration,
    点赞: likes,
    作者: author,
    日期: date,
    标签: tags,
    视频ID: vid,
    笔记ID: noteId,
    链接: link,
    封面: img ? img.currentSrc || img.src : '',
    文本原文: text.slice(0, 200),
  })
}

return JSON.stringify(
  {
    关键词: keyword,
    页面: location.href,
    命中叶子: leaves.length,
    容器: list ? `${list.tagName}.${String(list.className).slice(0, 30)} (子 ${cards.length})` : 'none',
    有效条数: rows.length,
    结果: rows,
  },
  null,
  1
)