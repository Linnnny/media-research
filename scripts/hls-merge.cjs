#!/usr/bin/env node
/**
 * hls-merge.cjs —— HLS(m3u8) 下载并合流为 mp4。
 *
 * 解决三件麻烦事：
 *   1) 主播放列表里音视频分离（X / 抖音 / 部分新闻站）→ 自动取最高画质 + 对应音轨再 map 合并
 *   2) 海外 CDN 必须走代理 → 自动探测本地代理并传给 ffmpeg 的 -http_proxy
 *   3) 站点校验 Referer → 透传 --referer
 *
 * 用法：
 *   node hls-merge.cjs <m3u8-url> <out.mp4> [--referer <页面URL>] [--proxy <url>] [--max-height 1080]
 *
 * 依赖：ffmpeg / ffprobe 在 PATH 上。
 */
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2)
if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
  console.log(
    [
      '用法: node hls-merge.cjs <m3u8-url> <out.mp4> [选项]',
      '',
      '  --referer <url>      透传 Referer（很多 CDN 校验）',
      '  --proxy <url>        代理；缺省自动探测 7897/7890/10809/1080/2080',
      '  --max-height <N>     分辨率上限（默认 2160）',
      '  --probe-only         只打印选中的变体，不下载',
    ].join('\n')
  )
  process.exit(0)
}

function flag(name, fallback = undefined) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const url = argv[0]
const out = argv[1] || path.join(process.cwd(), 'out.mp4')
const referer = flag('--referer')
const maxHeight = Number(flag('--max-height', '2160')) || 2160
const probeOnly = argv.includes('--probe-only')

function probeProxy() {
  for (const port of [7897, 7890, 10809, 1080, 2080]) {
    const r = spawnSync(
      process.execPath,
      ['-e', `const n=require('net');const s=n.connect({host:'127.0.0.1',port:${port}});s.setTimeout(400);s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));s.on('timeout',()=>{s.destroy();process.exit(1)})`],
      { timeout: 3000 }
    )
    if (r.status === 0) return `http://127.0.0.1:${port}`
  }
  return null
}

const proxy = flag('--proxy') || process.env.HTTPS_PROXY || probeProxy()

// ---------------------------------------------------------------- 拉取播放列表
async function fetchText(u) {
  const res = await fetch(u, {
    signal: AbortSignal.timeout(20000),
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
      ...(referer ? { Referer: referer } : {}),
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${u}`)
  return res.text()
}

function resolve(base, rel) {
  return new URL(rel, base).href
}

function parseMaster(text, base) {
  const lines = text.split(/\r?\n/)
  const variants = []
  const audios = []
  let pending = null
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('#EXT-X-STREAM-INF')) {
      const bandwidth = Number((t.match(/BANDWIDTH=(\d+)/) || [])[1] || 0)
      const resolution = (t.match(/RESOLUTION=(\d+)x(\d+)/) || []).slice(1)
      const audioGroup = (t.match(/AUDIO="([^"]+)"/) || [])[1]
      pending = {
        bandwidth,
        width: Number(resolution[0] || 0),
        height: Number(resolution[1] || 0),
        audioGroup,
      }
      continue
    }
    if (t.startsWith('#EXT-X-MEDIA')) {
      const type = (t.match(/TYPE=([A-Z]+)/) || [])[1]
      const group = (t.match(/GROUP-ID="([^"]+)"/) || [])[1]
      const uri = (t.match(/URI="([^"]+)"/) || [])[1]
      if (type === 'AUDIO' && uri) audios.push({ group, url: resolve(base, uri) })
      continue
    }
    if (t && !t.startsWith('#') && pending) {
      variants.push({ ...pending, url: resolve(base, t) })
      pending = null
    }
  }
  return { variants, audios }
}

// ---------------------------------------------------------------- 主流程
async function main() {
  // 自举：Node fetch 需要启动前设置 NODE_USE_ENV_PROXY
  if (proxy && !process.env.NODE_USE_ENV_PROXY) {
    const res = spawnSync(process.execPath, [__filename, ...argv], {
      stdio: 'inherit',
      env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxy, HTTP_PROXY: proxy, HLS_PROXY_READY: '1' },
    })
    process.exit(res.status ?? 1)
  }

  if (proxy) console.log(`[i] 代理 ${proxy}`)

  const text = await fetchText(url)
  let videoUrl = url
  let audioUrl = null

  if (text.includes('#EXT-X-STREAM-INF')) {
    const { variants, audios } = parseMaster(text, url)
    const usable = variants.filter((v) => !v.height || v.height <= maxHeight)
    usable.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth)
    const best = usable[0]
    if (!best) throw new Error('主列表里没有可用变体')
    videoUrl = best.url
    const group = best.audioGroup
    const audio = group ? audios.find((a) => a.group === group) || audios[0] : audios[0]
    audioUrl = audio ? audio.url : null
    console.log(
      `[i] 变体 ${usable.length} 个 → 选 ${best.width}x${best.height} (${Math.round(best.bandwidth / 1000)}kbps)` +
        (audioUrl ? ' + 单独音轨' : '')
    )
  } else {
    console.log('[i] 单码率播放列表')
  }

  if (probeOnly) return

  const headers = referer ? `Referer: ${referer}\r\n` : ''
  const ff = ['-hide_banner', '-loglevel', 'error', '-y']
  if (proxy) ff.push('-http_proxy', proxy)
  if (headers) ff.push('-headers', headers)
  ff.push('-i', videoUrl)

  if (audioUrl) {
    if (proxy) ff.push('-http_proxy', proxy)
    if (headers) ff.push('-headers', headers)
    ff.push('-i', audioUrl, '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0')
  } else {
    ff.push('-c', 'copy')
  }
  ff.push(out)

  fs.mkdirSync(path.dirname(out), { recursive: true })
  const run = spawnSync('ffmpeg', ff, { stdio: 'inherit' })
  if (run.status !== 0) throw new Error(`ffmpeg 退出码 ${run.status}`)
  if (!fs.existsSync(out)) throw new Error('没有生成输出文件')

  const info = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,width,height', '-of', 'json', out],
    { encoding: 'utf8' }
  )
  const stat = fs.statSync(out)
  console.log(`[ok] ${out}  ${(stat.size / 1048576).toFixed(2)} MB`)
  try {
    const parsed = JSON.parse(info.stdout || '{}')
    const v = (parsed.streams || []).find((s) => s.width)
    const dur = parsed.format && parsed.format.duration
    if (v) console.log(`[ok] ${v.codec_name} ${v.width}x${v.height}` + (dur ? `  ${Number(dur).toFixed(1)}s` : ''))
  } catch {}
}

main().catch((err) => {
  console.error(`[x] ${err.message}`)
  process.exit(1)
})