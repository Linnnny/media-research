// [!] 注入式片段，不是独立脚本 —— 用 evalfile 跑：
//     node scripts/browse.cjs evalfile scripts/<name>.js

// X（Twitter）媒体抽取器 —— 必须用 evalfile 注入到已打开的 X 页面
//
// 为什么单独写一个：X 现在没有 <article> 容器，data-testid 也变了，
// 唯一稳定的锚点是 pbs.twimg.com/media 的图片和 /status/ 链接。
// 做法：从图片元素向上回溯，找到包含 status 链接的祖先，从而把图片归到对应推文。
//
// 返回：每条推文的 URL、图片列表（含 name=orig 原图地址）、是否带视频、文本摘要。

const imgs = [...document.querySelectorAll('img')].filter((i) =>
  (i.currentSrc || i.src || '').includes('pbs.twimg.com/media/')
)

const found = new Map()
for (const img of imgs) {
  const src = img.currentSrc || img.src
  let node = img
  let link = ''
  let contextText = ''
  for (let depth = 0; depth < 14 && node; depth++) {
    if (node.querySelector) {
      const a = node.querySelector('a[href*="/status/"]')
      if (a) {
        link = a.href.split('?')[0].replace(/\/photo\/\d+$/, '')
        contextText = (node.innerText || '').replace(/\s+/g, ' ').slice(0, 80)
        break
      }
    }
    node = node.parentElement
  }
  if (!link) continue
  if (!found.has(link)) found.set(link, { tweet: link, images: [], video: false, text: contextText })
  const rec = found.get(link)
  if (!rec.images.includes(src)) rec.images.push(src)
}

// 视频：找 video 元素并回溯所属推文
for (const v of document.querySelectorAll('video')) {
  let node = v
  let link = ''
  for (let depth = 0; depth < 14 && node; depth++) {
    if (node.querySelector) {
      const a = node.querySelector('a[href*="/status/"]')
      if (a) {
        link = a.href.split('?')[0].replace(/\/photo\/\d+$/, '')
        break
      }
    }
    node = node.parentElement
  }
  if (!link) continue
  if (!found.has(link)) found.set(link, { tweet: link, images: [], video: true, text: '' })
  else found.get(link).video = true
}

const list = [...found.values()].slice(0, 10).map((r) => ({
  tweet: r.tweet,
  hasVideo: r.video,
  imageCount: r.images.length,
  images: r.images.map((s) => s.replace(/([?&])name=[^&]*/, '$1name=orig')),
  summary: r.text,
}))

return JSON.stringify({ count: list.length, items: list }, null, 1)