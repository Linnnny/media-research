// [!] 注入式片段，不是独立脚本 —— 用 evalfile 跑：
//     node scripts/browse.cjs evalfile scripts/<name>.js

// Instagram 媒体抽取器 —— 用 evalfile 注入到已打开的 IG 帖子/Reel 页面
//
// 为什么不能用 capture：IG 的 <video> 是 blob(MSE)，网络层只有 27 个分片请求，
// 单独下载任何一个都只有 128 字节（签名分片，不能当完整文件用）。
//
// 可行路径：页面内调官方 API
//   1) 从 HTML 里挖数字 media_id（形如 "id":"<mediaId>_<userId>"）
//   2) GET /api/v1/media/<mediaId>/info/  带 x-ig-app-id 头 + credentials
//   3) 取 items[0].video_versions[0].url —— 这才是完整可下的 mp4
//
// 返回：videoUrl / 尺寸 / 作者 / 轮播内各项媒体 / 封面

const html = document.documentElement.innerHTML
const shortcode = (location.pathname.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/) || [])[1] || ''

const ids = [...new Set([...html.matchAll(/"id":"(\d{15,})_\d+"/g)].map((m) => m[1]))]
const out = {
  shortcode,
  mediaId: ids[0] || null,
  videoUrl: null,
  videoSize: null,
  user: null,
  isVideo: false,
  carousel: [],
  imageUrls: [],
  cover: null,
}

const coverEl = document.querySelector('meta[property="og:image"]')
if (coverEl) out.cover = coverEl.content

if (out.mediaId) {
  try {
    const r = await fetch(`/api/v1/media/${out.mediaId}/info/`, {
      credentials: 'include',
      headers: { 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' },
    })
    if (r.ok) {
      const j = await r.json()
      const item = (j.items || [])[0] || {}
      out.user = item.user ? item.user.username : null
      const versions = item.video_versions || []
      if (versions.length) {
        out.isVideo = true
        out.videoUrl = versions[0].url
        out.videoSize = { w: versions[0].width, h: versions[0].height }
      }
      const candidates = (item.image_versions2 && item.image_versions2.candidates) || []
      out.imageUrls = candidates.slice(0, 3).map((c) => c.url)
      out.carousel = (item.carousel_media || []).map((c) => ({
        type: c.media_type,
        video: (c.video_versions || [])[0]?.url || null,
        image: (c.image_versions2?.candidates || [])[0]?.url || null,
      }))
    } else {
      out.error = `API ${r.status}`
    }
  } catch (e) {
    out.error = e.message
  }
} else {
  out.error = '页面里没找到 media_id（可能需要滚动或刷新）'
}

return JSON.stringify(out, null, 1)