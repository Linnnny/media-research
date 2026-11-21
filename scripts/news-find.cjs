#!/usr/bin/env node
/**
 * news-find.cjs v2 —— 新闻原稿溯源器（无 API key）。
 *
 * 搜索（DuckDuckGo → Bing → Bing 新闻 / 百度资讯 垂直）
 *   → 抓每个结果的元数据 + 正文样本
 *   → 计算「原稿分」（权威域名 / 发布时间 / 署名 / 转载特征）
 *   → 按发布时间升序 + 分数降序输出
 *
 * 代理：自动探测本机 Clash（7897/7890/10809），用 NODE_USE_ENV_PROXY 重启自身；
 *       具体路由交给 Clash 规则（国内直连、国外走代理）。
 *
 * 用法：
 *   node news-find.cjs search "灵晟超算 TOP500" --top 8
 *   node news-find.cjs search "Fed rate decision" --vertical --json
 *   node news-find.cjs search "某事件" --open 1
 *   node news-find.cjs meta <url>
 */
'use strict'

const { spawnSync } = require('node:child_process')

// ---------------------------------------------------------------- 代理自举
function probeProxy() {
  for (const port of [7897, 7890, 10809, 1080, 2080]) {
    const probe = spawnSync(
      process.execPath,
      ['-e', `const n=require('net');const s=n.connect({host:'127.0.0.1',port:${port}});s.setTimeout(400);s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));s.on('timeout',()=>{s.destroy();process.exit(1)})`],
      { timeout: 3000 }
    )
    if (probe.status === 0) return `http://127.0.0.1:${port}`
  }
  return null
}

if (!process.env.FIND_PROXY_READY) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || probeProxy()
  if (proxy) {
    const res = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: {
        ...process.env,
        FIND_PROXY_READY: '1',
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        NODE_USE_ENV_PROXY: '1',
      },
    })
    process.exit(res.status ?? 1)
  }
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0'

const AUTHORITY = [
  'xinhuanet.com', 'news.cn', 'people.com.cn', 'cctv.com', 'chinanews.com.cn', 'thepaper.cn',
  'gov.cn', 'ce.cn', 'gmw.cn', 'china.com.cn', 'youth.cn', 'caixin.com', 'bjnews.com.cn',
  'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com', 'wsj.com', 'ft.com',
  'bloomberg.com', 'cnn.com', 'aljazeera.com', 'scmp.com', 'nikkei.com', 'kyodonews.net',
  'federalreserve.gov', 'whitehouse.gov', 'europa.eu',
]

const AGGREGATOR = [
  'sina.com.cn', 'sohu.com', '163.com', 'qq.com', 'ifeng.com', 'toutiao.com',
  'baijiahao.baidu.com', 'csdn.net', 'zhihu.com', 'jianshu.com', '36kr.com', 'huxiu.com',
]

// 转载 / 二手特征：强特征才大幅扣分
const REPRINT_STRONG = [/本文转自/, /转载自/, /转载请注明/, /原标题[:：]/, /原文链接|原文地址/]
const REPRINT_WEAK = [/综合[^\n]{0,12}报道/, /据[^\n]{0,12}报道/, /援引/, /消息称/]

// ---------------------------------------------------------------- HTTP
async function get(url, { timeout = 20000 } = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  })
  return { status: res.status, url: res.url, html: await res.text() }
}

// ---------------------------------------------------------------- 搜索
function decodeDdg(href) {
  const m = href.match(/[?&]uddg=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : href
}

async function searchDuckDuckGo(query, limit) {
  const { html } = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=wt-wt`)
  const out = []
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  let m
  while ((m = re.exec(html)) && out.length < limit) {
    const url = decodeDdg(m[1])
    if (!/^https?:/i.test(url)) continue
    out.push({ title: clean(m[2]), url, engine: 'ddg' })
  }
  return out
}

async function searchBing(query, limit) {
  const { html } = await get(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&count=30`)
  const out = []
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  let m
  while ((m = re.exec(html)) && out.length < limit) {
    if (!/^https?:/i.test(m[1])) continue
    out.push({ title: clean(m[2]), url: m[1], engine: 'bing' })
  }
  return out
}

/** Bing 新闻垂直：按时间排序，最接近"最新原稿"。 */
async function searchBingNews(query, limit) {
  const url =
    `https://www.bing.com/news/search?q=${encodeURIComponent(query)}` +
    `&qft=sortbydate%3d%221%22&form=YFNR&setlang=zh-CN`
  const { html } = await get(url)
  const out = []
  const re = /<a[^>]+class="title"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  let m
  while ((m = re.exec(html)) && out.length < limit) {
    const href = clean(m[1])
    if (!/^https?:/i.test(href)) continue
    out.push({ title: clean(m[2]), url: href, engine: 'bingnews' })
  }
  // 兜底：抓 data-url
  if (!out.length) {
    const alt = /data-url="(https?:\/\/[^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/g
    while ((m = alt.exec(html)) && out.length < limit) {
      out.push({ title: clean(m[2]), url: m[1], engine: 'bingnews' })
    }
  }
  return out
}

/** 百度资讯：中文新闻原稿命中率高。 */
async function searchBaiduNews(query, limit) {
  const url = `https://www.baidu.com/s?tn=news&rtt=1&word=${encodeURIComponent(query)}`
  const { html } = await get(url)
  const out = []
  const re = /<h3[^>]*class="[^"]*news-title[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  let m
  while ((m = re.exec(html)) && out.length < limit) {
    out.push({ title: clean(m[2]), url: m[1], engine: 'baidunews' })
  }
  return out
}

async function search(query, limit, { vertical = false } = {}) {
  const found = []
  const engines = [searchDuckDuckGo, searchBing]
  if (vertical) engines.push(searchBingNews, searchBaiduNews)
  for (const fn of engines) {
    try {
      const rows = await fn(query, limit)
      if (rows.length) found.push(...rows)
    } catch (err) {
      console.error(`[!] ${fn.name} 失败：${err.message}`)
    }
    if (found.length >= limit * 2) break
  }
  return found
}

// ---------------------------------------------------------------- 解析
function clean(text) {
  return (text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function metaOf(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re)
    if (m && m[1]) return clean(m[1])
  }
  return ''
}

function textOf(html) {
  return clean(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
  )
}

function normaliseTime(raw) {
  if (!raw) return ''
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]} ${iso[4]}:${iso[5]}:${iso[6] || '00'}`
  const cn = raw.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/)
  if (cn) {
    const pad = (n) => String(n).padStart(2, '0')
    return `${cn[1]}-${pad(cn[2])}-${pad(cn[3])} ${pad(cn[4])}:${cn[5]}:${cn[6] || '00'}`
  }
  return ''
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function matches(host, list) {
  return list.some((d) => host === d || host.endsWith(`.${d}`))
}

function normKey(url) {
  try {
    const u = new URL(url)
    u.hash = ''
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|spm|from|share|ref|_)/i.test(key)) u.searchParams.delete(key)
    }
    return `${u.hostname}${u.pathname}`
  } catch {
    return url
  }
}

function dateFromUrl(url) {
  const patterns = [
    /\/(20\d{2})(\d{2})(\d{2})\//,        // /20261121/
    /\/(20\d{2})-(\d{2})\/(\d{2})\//,     // /2026-11/21/
    /\/(20\d{2})\/(\d{2})-(\d{2})\//,     // /2026/11-21/
    /\/(20\d{2})\/(\d{2})\/(\d{2})\//,    // /2026/11/21/
    /t(20\d{2})(\d{2})(\d{2})_/,          // t20261121_
  ]
  for (const re of patterns) {
    const m = url.match(re)
    if (m) return `${m[1]}-${m[2]}-${m[3]} 00:00:00`
  }
  return ''
}

function extract(html, finalUrl) {
  const title =
    metaOf(html, [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
      /<title[^>]*>([\s\S]*?)<\/title>/i,
    ]) || ''

  const published = normaliseTime(
    metaOf(html, [
      /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)/i,
      /<meta[^>]+property=["']og:article:published_time["'][^>]+content=["']([^"']+)/i,
      /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)/i,
      /<meta[^>]+name=["'](?:pubdate|publishdate|publish_date|PubDate|date|weibo:article:create_at)["'][^>]+content=["']([^"']+)/i,
      /"datePublished"\s*:\s*"([^"]+)"/i,
      /(?:pubtime|publishTime|pub_time|publish_date)\s*[:=]\s*["']([^"']{10,30})["']/i,
      /<span[^>]+class=["'][^"']*(?:time|date)[^"']*["'][^>]*>\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}[^<]{0,14})/i,
      /<time[^>]+datetime=["']([^"']+)["']/i,
      /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?\s*\d{1,2}:\d{2}(?::\d{2})?)/,
    ])
  )

  const author = metaOf(html, [
    /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)/i,
    /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)/i,
    /"author"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i,
    /"author"\s*:\s*"([^"]+)"/i,
  ])

  const site = metaOf(html, [/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i])
  const declaredSource = metaOf(html, [
    /<meta[^>]+name=["'](?:source|mediaid|article:source)["'][^>]+content=["']([^"']+)/i,
  ])

  // 时间兜底：正文 meta 缺失时，从 URL 路径取日期（只到日）
  let publishedFinal = published
  let publishedSource = published ? 'meta' : ''
  if (!publishedFinal) {
    publishedFinal = dateFromUrl(finalUrl)
    publishedSource = publishedFinal ? 'url' : ''
  }

  return {
    title,
    published: publishedFinal,
    publishedSource,
    author,
    site: site || hostOf(finalUrl),
    declaredSource,
    bodySample: textOf(html).slice(0, 4000),
    finalUrl,
  }
}

/** 原稿分：0-100，并给出扣分/加分依据。 */
function scoreOriginal(info, host) {
  let score = 50
  const reasons = []

  if (matches(host, AUTHORITY)) {
    score += 25
    reasons.push('权威源域名 +25')
  }
  if (matches(host, AGGREGATOR)) {
    score -= 25
    reasons.push('聚合站/自媒体 -25')
  }
  if (info.published) {
    if (info.publishedSource === 'url') {
      score += 6
      reasons.push('日期取自 URL 路径 +6')
    } else {
      score += 12
      reasons.push('有明确发布时间 +12')
    }
  } else {
    score -= 12
    reasons.push('无发布时间（多为转录） -12')
  }
  if (info.author) {
    score += 10
    reasons.push(`有署名：${info.author} +10`)
  } else {
    score -= 6
    reasons.push('无署名 -6')
  }

  // 页面声明的来源若就是本站（如新华网页面写「来源：新华网」），不算二手
  const declared = (info.declaredSource || '').trim()
  if (declared) {
    const selfSourced =
      declared === info.site ||
      host.includes(declared.replace(/网$|社$|\.com.*$/g, '')) ||
      declared.includes(info.site.replace(/网$|\.com.*$/g, '')) ||
      matches(host, AUTHORITY) && declared.length <= 6
    if (selfSourced) {
      reasons.push(`来源标注为本站「${declared}」（不计二手）`)
    } else {
      score -= 12
      reasons.push(`页面声明来源「${declared}」 -12`)
    }
  }

  const body = info.bodySample || ''
  // 官方公告/新闻中心路径：一手信源（企业官网 press release 等）
  let path = ''
  try {
    path = new URL(info.finalUrl || '').pathname
  } catch {}
  if (
    /\/(news|press|press-release|pressroom|newsroom|investor|investors|ir|announcements?|media)\//i.test(path) &&
    !matches(host, AGGREGATOR)
  ) {
    score += 15
    reasons.push('官方公告/新闻中心路径 +15')
  }

  const strong = REPRINT_STRONG.filter((re) => re.test(body)).length
  if (strong) {
    score -= Math.min(20, strong * 10)
    reasons.push(`强转载特征 ×${strong} -${Math.min(20, strong * 10)}`)
  }
  const weak = REPRINT_WEAK.filter((re) => re.test(body)).length
  if (weak) {
    score -= Math.min(10, weak * 5)
    reasons.push(`引用措辞 ×${weak} -${Math.min(10, weak * 5)}`)
  }

  score = Math.max(0, Math.min(100, score))
  return { score, reasons }
}

/** 相关性闸门：标题或正文开头必须命中查询词中的实义词。 */
function relevant(info, query) {
  const terms = query
    .split(/[\s,，、]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^(的|了|和|与|the|and|for|with)$/i.test(t))
  if (!terms.length) return true
  const haystack = `${info.title || ''} ${(info.bodySample || '').slice(0, 1200)}`.toLowerCase()
  return terms.some((term) => haystack.includes(term.toLowerCase()))
}

// ---------------------------------------------------------------- 输出
async function pool(items, size, worker) {
  const results = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        try {
          results[index] = await worker(items[index])
        } catch (err) {
          results[index] = { error: err.message }
        }
      }
    })
  )
  return results
}

async function cmdSearch(argv) {
  const positional = []
  const valueFlags = new Set(['--top', '--open'])
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (valueFlags.has(token)) {
      i++
      continue
    }
    if (token.startsWith('--')) continue
    positional.push(token)
  }
  const query = positional.join(' ')
  if (!query) throw new Error('缺少搜索词')
  const topIndex = argv.indexOf('--top')
  const openIndex = argv.includes('--open') ? Number(argv[argv.indexOf('--open') + 1]) || 1 : 0
  const top = topIndex >= 0 ? Number(argv[topIndex + 1]) || 10 : 10
  const vertical = argv.includes('--vertical')
  const asJson = argv.includes('--json')

  const hits = await search(query, Math.max(top * 2, 12), { vertical })
  if (!hits.length) {
    console.log('没有搜到结果')
    return
  }

  const seen = new Set()
  const unique = []
  for (const hit of hits) {
    const key = normKey(hit.url)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(hit)
  }

  const enriched = await pool(unique.slice(0, top + 8), 6, async (hit) => {
    try {
      const { html, url } = await get(hit.url, { timeout: 15000 })
      const info = extract(html, url)
      const host = hostOf(info.finalUrl || hit.url)
      if (!relevant(info, query)) {
        return { ...hit, host, skipped: '与查询无关', score: 0, reasons: [] }
      }
      return { ...hit, ...info, host, ...scoreOriginal(info, host) }
    } catch (err) {
      const host = hostOf(hit.url)
      return { ...hit, host, error: err.message, score: 0, reasons: [`抓取失败：${err.message}`] }
    }
  })

  const rows = enriched
    .filter((r) => r && !r.error && !r.skipped)
    .sort((a, b) => {
      if (a.published && b.published && a.published !== b.published) {
        return a.published < b.published ? -1 : 1
      }
      if (a.published && !b.published) return -1
      if (!a.published && b.published) return 1
      return b.score - a.score
    })

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }

  const engines = [...new Set(hits.map((h) => h.engine))].join('/')
  console.log(`\n搜索「${query}」 引擎 ${engines}${vertical ? '（含新闻垂直）' : ''}`)
  console.log(`命中 ${unique.length} 条，解析成功 ${rows.length} 条 · 按时间升序，同时间按原稿分排序\n`)

  rows.forEach((row, i) => {
    const tag = row.score >= 75 ? '★原稿' : row.score >= 55 ? '·可能原稿' : '×转载/二手'
    console.log(`${String(i + 1).padStart(2)}. ${row.published || '时间未知'}  [${row.host}]  原稿分 ${row.score}  ${tag}`)
    console.log(`    ${row.title || '(无标题)'}`)
    if (row.author) console.log(`    署名：${row.author}`)
    console.log(`    ${row.reasons.join(' · ')}`)
    console.log(`    ${row.finalUrl}`)
  })
  console.log('\n提示：★ 建议作为原文引用；× 多为聚合转载，需回溯其标注的原始出处。')

  if (openIndex && rows[openIndex - 1]) {
    const target = rows[openIndex - 1].finalUrl
    console.log(`\n[i] 浏览器打开第 ${openIndex} 条：${target}`)
    spawnSync(process.execPath, [require('node:path').join(__dirname, 'browse.cjs'), 'open', target], {
      stdio: 'inherit',
    })
  }
}

async function cmdMeta(argv) {
  const url = argv[0]
  if (!url) throw new Error('缺少 url')
  const { html, url: finalUrl } = await get(url)
  const info = extract(html, finalUrl)
  const host = hostOf(finalUrl)
  console.log(JSON.stringify({ ...info, host, ...scoreOriginal(info, host) }, null, 2))
}

async function main() {
  const [, , cmd, ...rest] = process.argv
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(
      [
        '用法: node news-find.cjs <命令>',
        '',
        '  search "<关键词>" [--top N] [--vertical] [--json] [--open N]',
        '  meta <url>',
        '',
        '  --vertical  追加 Bing 新闻 + 百度资讯 垂直搜索',
        '  代理：自动探测 Clash 端口，路由由 Clash 规则决定。',
      ].join('\n')
    )
    return
  }
  if (cmd === 'search') return cmdSearch(rest)
  if (cmd === 'meta') return cmdMeta(rest)
  throw new Error(`未知命令 ${cmd}`)
}

main()
  .then(() => setTimeout(() => process.exit(0), 50))
  .catch((err) => {
    console.error(`[x] ${err.message}`)
    process.exit(1)
  })