#!/usr/bin/env node
/**
 * browse.cjs —— 零依赖 CDP 浏览器驱动器（Edge/Chrome 通用）。
 *
 * 不点坐标、不靠截图：直接读 DOM、抓媒体直链、点击、输入、翻页、下载。
 * 前提：浏览器带 --remote-debugging-port=9222 启动。
 *
 * 示例：
 *   node browse.cjs open https://news.cn/
 *   node browse.cjs text
 *   node browse.cjs links ".news-list a" -n 10
 *   node browse.cjs imgs --min-w 600 -n 8
 *   node browse.cjs download <url> "out/新闻" --name 01.jpg
 *   node browse.cjs eval "document.title"
 *   node browse.cjs click "a.more" && node browse.cjs text
 */
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// ---------------------------------------------------------------- 代理自举
// Node 的 fetch 只在「启动前」设置 NODE_USE_ENV_PROXY 才走代理。
// download / capture 下载海外 CDN（pbs.twimg.com、googlevideo 等）必须走代理，
// 所以这里自举一次：探测到本地代理就用它重启自身。MEDIA_NO_PROXY=1 可强制直连。
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

if (!process.env.BROWSE_PROXY_READY && !process.env.MEDIA_NO_PROXY) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || probeProxy()
  if (proxy) {
    const res = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: {
        ...process.env,
        BROWSE_PROXY_READY: '1',
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        NODE_USE_ENV_PROXY: '1',
      },
    })
    process.exit(res.status ?? 1)
  }
}

const PORT = Number(process.env.CDP_PORT || 9222)
const BASE = `http://127.0.0.1:${PORT}`

// ------------------------------------------------------- 记住上次操作的标签页
// 多标签页时 /json 的顺序不可靠，可能连到 Edge 推广页或别的 tab。
// open 时把 targetId 落到临时文件，后续命令优先复用同一个标签页。
const TARGET_STATE = path.join(os.tmpdir(), `browse-target-${PORT}.txt`)

function readTargetId() {
  try {
    return fs.readFileSync(TARGET_STATE, 'utf8').trim() || null
  } catch {
    return null
  }
}

function writeTargetId(id) {
  try {
    fs.writeFileSync(TARGET_STATE, String(id || ''), 'utf8')
  } catch {}
}

// ---------------------------------------------------------------- CDP 会话
class Page {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    this.hooks = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result)
      } else if (msg.method) {
        this.events.push(msg)
        for (const hook of this.hooks) {
          if (hook.method === msg.method) {
            try {
              hook.cb(msg.params)
            } catch {}
          }
        }
      }
    })
  }

  on(method, cb) {
    this.hooks.push({ method, cb })
  }

  static async connect() {
    const targets = (await (await fetch(`${BASE}/json`)).json()).filter((t) => t.type === 'page')
    // 优先沿用上一次 open 的那个标签页，避免多标签时连到 Edge 推广页/别的 tab
    let page = null
    const remembered = readTargetId()
    if (remembered) page = targets.find((t) => t.id === remembered) || null
    if (!page) {
      // 排除浏览器内部页（edge:// chrome://），优先真实网页
      const web = targets.filter((t) => !/^(edge|chrome|about|devtools):/i.test(t.url || ''))
      page = web[web.length - 1] || targets[targets.length - 1]
    }
    if (!page) page = await (await fetch(`${BASE}/json/new?about:blank`, { method: 'PUT' })).json()
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('无法连接 CDP')), { once: true })
    })
    const p = new Page(ws)
    p.targetId = page.id
    await p.send('Page.enable')
    await p.send('Runtime.enable')
    return p
  }

  send(method, params = {}) {
    const id = ++this.id
    const payload = JSON.stringify({ id, method, params })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(payload)
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 超时`))
      }, 45000)
    })
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text)
    }
    return res.result.value
  }

  async waitLoad(timeout = 30000) {
    const start = Date.now()
    // 已有 readyState 完成则直接返回
    for (;;) {
      try {
        const state = await this.evaluate('document.readyState')
        if (state === 'complete') return true
      } catch {}
      if (Date.now() - start > timeout) return false
      await new Promise((r) => setTimeout(r, 400))
    }
  }

  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

// ---------------------------------------------------------------- 工具
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (value) => console.log(JSON.stringify(value, null, 2))

function argAfter(argv, flag, fallback = undefined) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

async function downloadFile(url, destDir, name) {
  const fs = require('node:fs')
  const path = require('node:path')
  fs.mkdirSync(destDir, { recursive: true })
  const safe = name || decodeURIComponent(new URL(url).pathname.split('/').pop() || 'asset')
  const target = path.join(destDir, safe.replace(/[\\/:*?"<>|]+/g, '_'))

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0',
    Referer: new URL(url).origin + '/',
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  }
  const res = await fetch(url, { headers, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(target, buf)
  return { path: target, bytes: buf.length }
}

// ---------------------------------------------------------------- 命令
async function main() {
  const [, , cmd, ...rest] = process.argv
  if (!cmd || cmd === '-h' || cmd === '--help') {
    console.log(
      [
        '用法: node browse.cjs <命令> [参数]',
        '',
        '  open <url>                打开网址并等加载',
        '  text [selector] [--limit] 取可见文本',
        '  links [selector] [-n N]   列出链接（文本 + href）',
        '  imgs [--min-w N] [-n N]   列出图片（src + 原始尺寸）',
        '  media                     列出 video/source',
        '  title                     当前标题 + URL',
        '  eval "<js>"               在页面执行 JS 并返回结果',
        '  click "<css>"             点击元素',
        '  type "<css>" "<text>"     向输入框写入',
        '  key <Enter|ArrowDown|...> 发送按键',
        '  scroll <px>               滚动页面',
        '  wait <ms>                 等待',
        '  shot [path]               截图',
        '  download <url> <dir> [--name N]',
        '  capture <url> [--seconds 15] [--download DIR]   拦截网络媒体（图片/视频/HLS）',
        '  cookies [--filter 域名]    cookie 元数据（不含值）',
        '  evalfile <脚本>           从文件执行 JS（避免 shell 引号问题）',
        '  tabs                      列出标签页',
        '',
        '环境变量: CDP_PORT（默认 9222）',
      ].join('\n')
    )
    return
  }

  const page = await Page.connect()
  try {
    switch (cmd) {
      case 'open': {
        const url = rest[0]
        if (!url) throw new Error('缺少 url')
        if (page.targetId) writeTargetId(page.targetId)
        await page.send('Page.navigate', { url })
        const ok = await page.waitLoad(45000)
        // SPA 常先给域名、后设标题：轮询到标题不再是裸域名为止
        let info = await page.evaluate('({title: document.title, url: location.href})')
        const hostOf = (u) => {
          try {
            return new URL(u).hostname.replace(/^www\./, '')
          } catch {
            return ''
          }
        }
        for (let i = 0; i < 20; i++) {
          const bare = !info.title || info.title === hostOf(info.url) || info.title === new URL(info.url).hostname
          if (!bare) break
          await sleep(400)
          info = await page.evaluate('({title: document.title, url: location.href})')
        }
        json({ loaded: ok, ...info })
        break
      }
      case 'capture': {
        // 拦截网络层媒体请求（图片/视频/音频/HLS/DASH），这是 blob: 播放页的唯一出路
        const url = rest[0]
        if (!url) throw new Error('缺少 url')
        const seconds = Number(argAfter(rest, '--seconds', '15'))
        const dir = argAfter(rest, '--download', '')
        const found = new Map()
        const MEDIA_EXT = /\.(mp4|webm|m4v|mov|m3u8|mpd|ts|flv|mkv|m4s|jpg|jpeg|png|webp|gif|avif)(\?|$)/i
        const STREAM = /\.(m3u8|mpd|m4s|ts)(\?|$)/i

        await page.send('Network.enable')
        page.on('Network.responseReceived', ({ response, type }) => {
          const mime = response.mimeType || ''
          const u = response.url || ''
          if (!u || u.startsWith('data:') || u.startsWith('blob:')) return
          const isMedia =
            mime.startsWith('video/') ||
            mime.startsWith('audio/') ||
            /mpegurl|dash\+xml/.test(mime) ||
            MEDIA_EXT.test(u) ||
            type === 'Media'
          if (!isMedia) return
          const key = u.split('#')[0]
          if (!found.has(key)) {
            found.set(key, {
              url: key,
              mime,
              status: response.status,
              stream: STREAM.test(u),
              kb: Math.round((response.encodedDataLength || 0) / 1024),
            })
          }
        })

        await page.send('Page.navigate', { url })
        await page.waitLoad(45000)
        await page
          .evaluate(
            `(() => { const v = document.querySelector('video'); if (v) { v.muted = true; v.play && v.play().catch(() => {}); return true } return false })()`
          )
          .catch(() => {})
        await sleep(seconds * 1000)

        const rows = [...found.values()].sort((a, b) => Number(b.stream) - Number(a.stream))
        json({ page: url, seconds, count: rows.length, media: rows })

        if (dir && rows.length) {
          const db = rows.filter((r) => !r.stream)
          const saved = []
          for (const [i, r] of db.entries()) {
            try {
              const ext = (r.url.match(/\.(mp4|webm|m4v|mov|flv|mkv|jpg|jpeg|png|webp|gif|avif)(\?|$)/i) || [])[1] || 'bin'
              saved.push(await downloadFile(r.url, dir, `${String(i + 1).padStart(2, '0')}.${ext}`))
            } catch (err) {
              saved.push({ url: r.url, error: err.message })
            }
          }
          json({ downloaded: saved })
          if (rows.some((r) => r.stream)) {
            console.log(
              '\n[i] 检测到 HLS/DASH 流：用 ffmpeg 合流，例如\n' +
                `    ffmpeg -headers "Referer: ${url}" -i "<m3u8地址>" -c copy -bsf:a aac_adtstoasc "out.mp4"`
            )
          }
        }
        break
      }
      case 'cookies': {
        // 只输出 cookie 的元数据（名称/域/有效期），绝不打印值
        await page.send('Network.enable').catch(() => {})
        const { cookies } = await page.send('Network.getAllCookies')
        const filter = argAfter(rest, '--filter', '').toLowerCase()
        const rows = cookies
          .filter((c) => !filter || c.domain.toLowerCase().includes(filter) || c.name.toLowerCase().includes(filter))
          .map((c) => ({
            name: c.name,
            domain: c.domain,
            httpOnly: c.httpOnly,
            expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 10) : 'session',
            bytes: (c.value || '').length,
          }))
          .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name))
        json({ count: rows.length, cookies: rows })
        break
      }
      case 'tabs': {
        const targets = await (await fetch(`${BASE}/json`)).json()
        json(targets.filter((t) => t.type === 'page').map((t) => ({ title: t.title, url: t.url, id: t.id })))
        break
      }
      case 'title': {
        json(await page.evaluate('({title: document.title, url: location.href})'))
        break
      }
      case 'text': {
        const selector = rest[0] && !rest[0].startsWith('--') ? rest[0] : 'body'
        const limit = Number(argAfter(rest, '--limit', '20000'))
        const out = await page.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)}) || document.body;
          const t = (el.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
          return t.length > ${limit} ? t.slice(0, ${limit}) : t;
        })()`)
        console.log(out)
        break
      }
      case 'links': {
        const selector = rest[0] && !rest[0].startsWith('--') ? rest[0] : 'a'
        const n = Number(argAfter(rest, '-n', '30'))
        const out = await page.evaluate(`(() => {
          const seen = new Set(); const rows = [];
          for (const a of document.querySelectorAll(${JSON.stringify(selector)})) {
            const text = (a.innerText || a.textContent || '').trim().replace(/\\s+/g, ' ');
            const href = a.href;
            if (!href || !text || seen.has(href)) continue;
            seen.add(href); rows.push({ text: text.slice(0, 90), href });
            if (rows.length >= ${n}) break;
          }
          return rows;
        })()`)
        json(out)
        break
      }
      case 'imgs': {
        const minW = Number(argAfter(rest, '--min-w', '0'))
        const n = Number(argAfter(rest, '-n', '30'))
        const out = await page.evaluate(`(() => {
          const rows = [];
          for (const img of document.images) {
            const w = img.naturalWidth || 0, h = img.naturalHeight || 0;
            if (w < ${minW} || !img.currentSrc) continue;
            rows.push({ w, h, alt: (img.alt || '').slice(0, 60), src: img.currentSrc });
            if (rows.length >= ${n}) break;
          }
          return rows;
        })()`)
        json(out)
        break
      }
      case 'media': {
        const out = await page.evaluate(`(() => {
          const rows = [];
          for (const v of document.querySelectorAll('video')) {
            const src = v.currentSrc || v.src || (v.querySelector('source') || {}).src || '';
            rows.push({ kind: 'video', src, poster: v.poster || '', duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null });
          }
          for (const s of document.querySelectorAll('source[src]')) {
            if (s.parentElement && s.parentElement.tagName === 'VIDEO') continue;
            rows.push({ kind: 'source', src: s.src, duration: null });
          }
          return rows;
        })()`)
        json(out)
        break
      }
      case 'evalfile': {
        // 从文件读取 JS 体（避免命令行引号被 shell 吃掉）；允许 await / return
        const file = rest[0]
        if (!file) throw new Error('缺少脚本路径')
        const body = require('node:fs').readFileSync(file, 'utf8')
        const value = await page.evaluate(`(async () => { ${body} })()`)
        if (typeof value === 'string') console.log(value)
        else json(value)
        break
      }
      case 'eval': {
        const expr = rest.join(' ')
        if (!expr) throw new Error('缺少表达式')
        json(await page.evaluate(expr))
        break
      }
      case 'click': {
        const sel = rest[0]
        if (!sel) throw new Error('缺少选择器')
        const ok = await page.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return false;
          el.scrollIntoView({block:'center'});
          el.click();
          return true;
        })()`)
        await sleep(800)
        json({ clicked: ok, selector: sel })
        break
      }
      case 'type': {
        const [sel, ...words] = rest
        const value = words.join(' ')
        await page.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return false;
          el.focus(); el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
          return true;
        })()`)
        json({ typed: true, selector: sel, value })
        break
      }
      case 'key': {
        const key = rest[0] || 'Enter'
        const map = {
          Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
          ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
          ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
          Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
          PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
        }
        const def = map[key]
        if (!def) throw new Error(`不支持按键 ${key}`)
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...def })
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...def })
        await sleep(500)
        json({ pressed: key })
        break
      }
      case 'scroll': {
        const px = Number(rest[0] || '800')
        await page.evaluate(`window.scrollBy(0, ${px})`)
        await sleep(500)
        json({ scrolled: px, y: await page.evaluate('Math.round(window.scrollY)') })
        break
      }
      case 'wait': {
        const ms = Number(rest[0] || '1000')
        await sleep(ms)
        json({ waited: ms })
        break
      }
      case 'shot': {
        const path = require('node:path')
        const out = rest[0] || path.join(process.cwd(), `shot-${Date.now()}.png`)
        const { data } = await page.send('Page.captureScreenshot', { format: 'png' })
        require('node:fs').writeFileSync(out, Buffer.from(data, 'base64'))
        json({ path: out })
        break
      }
      case 'download': {
        const [url, dir] = rest
        const name = argAfter(rest, '--name', undefined)
        if (!url || !dir) throw new Error('用法: download <url> <dir> [--name N]')
        json(await downloadFile(url, dir, name))
        break
      }
      default:
        throw new Error(`未知命令 ${cmd}`)
    }
  } finally {
    page.close()
  }
}

main()
  .then(() => {
    // WebSocket 关闭后进程仍可能挂住，显式退出
    setTimeout(() => process.exit(0), 50)
  })
  .catch((err) => {
    console.error(`[x] ${err.message}`)
    process.exit(1)
  })