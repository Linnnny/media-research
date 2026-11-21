# 平台差异手册

每个站点的**图片尺寸参数、视频协议、登录要求、推荐工具、专属坑**。
「验证」列：✅ 本机实测过 / ⚠️ 通用经验，未在本机实测。

---

## 一页速查

| 平台 | 图片域名 / 参数 | 视频协议 | 需要登录 | 首选工具 | 验证 |
|---|---|---|---|---|---|
| X (Twitter) | `pbs.twimg.com/media/<id>?name=orig` | HLS，**音视频分离** | 时间线/搜索要，单条公开帖不用 | `extract-x.js` + `hls-merge.cjs` | ✅ |
| 抖音 | `p3-pc-sign.douyinpic.com`（**签名，有时效**） | 直链 mp4（`v26-web.douyinvod.com`） | 搜索要 | `extract-list.js` + `capture` | ✅ |
| 小红书 | `sns-webpic-qc.xhscdn.com` 等（带签名） | 直链 mp4 | 搜索要 | `extract-list.js` | ✅ |
| YouTube | `i.ytimg.com/vi/<id>/maxresdefault.jpg` | DASH / HLS | 高码率/会员要 | `yt.cmd`（**必须带 JS 运行时**） | ✅ |
| 新闻站（CCTV/澎湃等） | 自有 CDN，一般无鉴权 | HLS（`res.cctvnews.cctv.com`） | 不要 | `capture` + `hls-merge.cjs` | ✅ |
| B 站 | `i0.hdslb.com/bfs/...` | **DASH 音视频分离**（`.m4s`） | 高清晰度要 cookie（SESSDATA） | `yt.cmd` | ✅ |
| 微博 | `wx*.sinaimg.cn/(large\|mw690)/…`（头像 `tvax*`、UI `h5.sinaimg.cn` 需排除） | `<video>` 是空壳 → 用 `capture` 拦真实请求 | 帖子/视频要 | `capture` + `download` | ✅ |
| TikTok | `*.tiktokcdn.com` | mp4 多码率（`h264_720p`、`bytevc1_1080p`、含水印 `download`） | 不需要，但有 bot 挑战 | `yt.cmd`（**必须 `--impersonate`**） | ✅ |
| Instagram | `scontent*.cdninstagram.com`（签名） | mp4 **progressive**（API 取 `video_versions[0].url`） | **要登录** | `extract-ig.js` + `download` | ✅ |

---

## X（Twitter）

**已验证**

- **DOM 无 `<article>`**，`data-testid` 也变过 → 用 `extract-x.js`（从 `pbs.twimg.com/media` 图片回溯 `/status/` 链接）
- **图片**：`?name=` 控制尺寸，`small` / `360x360` / `orig`。取原图必须换成 `name=orig`
- **视频**：`video.twimg.com/amplify_video/<id>/pl/<hash>.m3u8` 是**主列表**，其下 `avc1/...`（纯视频）和 `mp4a/...`（纯音频）分开 → 必须两条流 `-map` 合并
- **搜索过滤**：`?q=<kw>%20filter%3Amedia&f=media` 只出图；`filter%3Anative_video&f=video` 只出视频
- **登录**：`auth_token`（httpOnly）+ `ct0` + `twid`，约 1 年
- 实测产出：图片 414×681 / 117 KB；视频 720×1280 / 865kbps / 2.30 MB

**坑**：手写 ffmpeg 直连 `video.twimg.com` 会 `-10054`（没走代理）；`-c copy` 单流会 `moov atom not found`。

---

## 抖音

**已验证**

- 搜索页 `https://www.douyin.com/search/<关键词>`，结果**不是 `<a>` 标签**，且 `document.body.innerText` 取不到 → 必须 `textContent` + 结构推断（`extract-list.js`）
- **视频 ID 藏在卡片元素 id**：`id="waterfall_item_7680..."` → 拼 `https://www.douyin.com/video/<id>`
- 卡片文本无分隔符，形如 `<时长><点赞><标题> <#标签> @作者 · <日期>`，需按正则拆
- 视频：`capture` 能抓到 `v26-web.douyinvod.com/.../video/tos/...` 的 **mp4 直链**（两个码率变体）
- 封面：`p3-pc-sign.douyinpic.com/image-cut-tos-priv/...`，URL 里 `x-expires` 是**过期时间戳**
- 登录：`sessionid` / `sessionid_ss` / `sid_guard` / `uid_tt`，约 1 年

**坑**：签名直链**几小时～几天失效**，隔天要重抓；`相关搜索` 块会被误判成卡片（脚本已过滤）。

---

## 小红书

**已验证**

- 搜索页 `https://www.xiaohongshu.com/search_result?keyword=<kw>&source=web_search_result_notes`
- 未登录会弹「登录后查看搜索结果」，`web_session` 有效才会出结果
- 卡片同样是 `div` 而非 `<a>`；笔记 ID 在 `/explore/<24位>` 里
- 页面里有 `window.__INITIAL_STATE__` 大 JSON，**必须排除 `<script>` 叶子**否则抓到它就是它
- 「大家都在搜」推荐块要过滤
- 登录：`web_session`（httpOnly）+ `a1` + `webId`

**坑**：卡片文本无分隔符，标题/作者会粘连；`文本原文` 字段保留原文便于二次清洗。

---

## YouTube

**已验证**

- **必须 `--js-runtimes node:<path>`**，否则只给音频和 HLS（nsig 解不出来）
- 本机实测（`aqz-KE-bpKQ`）：最高 `2160p60` VP9 17Mbps、`1440p60`、`1080p60` H.264
- 封面：`https://i.ytimg.com/vi/<id>/maxresdefault.jpg`（还有 `sd` / `hq` / `mq`）
- 分段下载：`--download-sections "*0-20" --force-keyframes-at-cuts`（实测 20 秒 720p = 4.57 MB）
- 未登录会降码；会员/年龄限制需要 cookie

**坑**：`yt-dlp` 缺 JS 运行时**不报错**，只是格式列表少一半——最容易误判成"这视频只有 144p"。

---

## 新闻站（CCTV / 澎湃 / 新华 等）

**已验证**

- 澎湃文章常把视频源指向 CCTV：`res.cctvnews.cctv.com/video/.../<hash>-4.m3u8`
- 一个页面能抓到 **11 条 HLS 流**（不同清晰度 + 相关推荐），`_3000K_MP4` 那档是 1080p
- 落地实测：`1920×1080 H.264 + AAC`，20 秒 10.87 MB
- 国内站**不需要代理也不需登录**；`capture` 加 `hls-merge.cjs` 就能全拿

**坑**：`capture` 返回的流里混着推荐位的视频，要按 URL 里的清晰度标记（`3000K`/`1000K`）挑。

---

## B 站

**已验证（实测 BV1xFs36uEvE）**

- 首页 `a[href*="/video/BV"]` 一次能取 20 条 BV 号
- `yt-dlp -F` 列出 **DASH 分离**格式，分三族编码：

  | 族 | 示例 ID | 清晰度 | 说明 |
  |---|---|---|---|
  | AVC (h264) | `30016/30032/30064/30080` | 360p→1080p | **剪辑首选**，兼容性最好 |
  | HEVC (h265) | `30011/30033/30066/30077` | 360p→1080p | 同画质体积更小 |
  | AV1 | `100022…100026` | 360p→1080p | 最新、体积最小，但**剪映/PR 常不支持** |
  | 音频 | `30216/30232/30280` | 66k/116k/178k | m4a，与视频分开 |

- `capture` 在播放页能抓到 **`video/mp4` 的 `.m4s` 分片**，来源两个域名：
  `upos-sz-mirror*.bilivideo.com`（官方 CDN）与 `*.edge.mountaintoys.cn:4483`（**B 站 P2P 加速节点**）
- 实测下载（`--download-sections "*0-15"`）：`AV1 1280×720 + AAC`，15s / 1.06 MB

**坑**：

- `bv*` 默认可能选到 **AV1**，剪辑软件打不开 → 强制 H.264：`-f "bv*[vcodec^=avc]+ba"`
- 1080P+ / 大会员清晰度要 `SESSDATA` cookie
- 请求需要正常 `Referer: https://www.bilibili.com`（`yt.cmd` 已带）

```bash
# 兼容性优先（H.264）
yt -f "bv*[vcodec^=avc][height<=1080]+ba" "https://www.bilibili.com/video/BV..."
# 体积优先（AV1，注意剪辑软件支持）
yt -f "bv*[vcodec^=av01][height<=1080]+ba" "https://www.bilibili.com/video/BV..."
```

---

## 微博

**已验证（登录后）**

- 登录凭证：`SUB` + `SUBP`（httpOnly，约 1 年），另有短期的 `WBPSESS`
- 帖子 URL 格式是 **`https://weibo.com/<uid>/<mid>`**（不是 `/status/`，别用 Twitter 的规则套）
- 首页 feed 一次能取到 7 条 `weibo.com/\d+/\w+` 链接；页面通常只有 1 个 `<video>` 元素
- **图片分三类，必须过滤**：

  | 类型 | 域名 | 处理 |
  |---|---|---|
  | 真实配图 | `wx1~4.sinaimg.cn/(large\|mw690\|bmiddle\|orj360\|thumbnail)/…` | 取 `large`，实测 1.01 MB |
  | 头像 | `tvax1~2.sinaimg.cn/crop.*` | 丢弃 |
  | UI 资源 | `h5.sinaimg.cn/upload/…` | 丢弃 |

- **视频**：`<video>` 的 `src` 是空的（MSE 喂流），DOM 里拿不到 → 必须 `capture` 拦网络请求
- 未登录时：`s.weibo.com/top/summary` 能看热搜榜，但帖子页会跳 `Sina Visitor System`

**未验证**：微博视频的实际直链形态（手头这条帖子没有视频，只有图）。

---

## TikTok

**已验证（实测视频 7710348513128828191）**

- **浏览器走不通**：`tiktok.com/explore` 只给分类、`@tiktok` 主页卡在 `Please wait...`（bot 挑战）
- **必须用 yt-dlp**，且要 `--impersonate chrome`（依赖 `curl_cffi`）
- 可用格式（实测）：

  | ID | 编码 | 分辨率 | 大小 | 说明 |
  |---|---|---|---|---|
  | `download` | h264 | unknown | — | **带水印**，别用 |
  | `h264_720p_*` | h264 | 720×1280 | 12.29 MB | **剪辑首选** |
  | `bytevc1_540p_*` | h265 | 576×1024 | 5.54 MB | 小体积 |
  | `bytevc1_720p_*` | h265 | 720×1280 | 6.25 MB | |
  | `bytevc1_1080p_*` | h265 | 1080×1920 | 12.87 MB | 最高画质 |
  | `audio` | mp3 | — | — | 纯音轨 |

- **`bv*[height<=720]+ba` 这类选择器会失败**（TikTok 的格式 ID 不是标准 bv/best 体系）→ 用 `-f best` 或指定 `-f h264_720p`
- 实测 `-f best`：`hevc 1080×1920`，95.87 秒，12.87 MB
- 账号主页可以列视频：`--flat-playlist --playlist-end 3 --print "%(id)s"` 直接拿 ID

```bash
yt -f "h264_720p" "https://www.tiktok.com/@user/video/123..."     # 兼容性优先
yt -f best "https://www.tiktok.com/@user/video/123..."            # 最高画质（多为 h265）
```

---

## Instagram

**已验证（登录后，实测 reel Db6ZbnVByQ5）**

- **yt-dlp 走不通**：该站提取器已标记 `broken`，`--impersonate chrome` 也救不回来
- **`capture` 也拿不到**：`<video>` 是 `blob:`（MSE），网络层只有 27 个分片请求，
  逐个下载都只有 **128 字节**（签名分片，不是完整文件）
- **正确路径：页面内调官方 API**

  1. 从页面 HTML 挖数字 `media_id`：正则 `"id":"(\d{15,})_\d+"`（**shortcode 不行**，API 会报 `Invalid media_id`）
  2. `GET /api/v1/media/<media_id>/info/`
     带 `credentials: include` + `x-ig-app-id: 936619743392459`
  3. 取 `items[0].video_versions[0].url` —— 完整 progressive mp4，直接 GET 就能下

- 实测：`h264 720×1280 + AAC`，38.1 秒，**7.14 MB**；作者 `disunofficial`
- 封装好的是 `scripts/extract-ig.js`
- 封面：`meta[property="og:image"]`
- 轮播（carousel）：`carousel_media[]` 里逐项取 `video_versions` / `image_versions2`
- 登录凭证：`sessionid`（httpOnly）+ `ds_user_id` + `csrftoken` + `mid`

```bash
node scripts/browse.cjs open "https://www.instagram.com/p/<shortcode>/"
node scripts/browse.cjs wait 5000
node scripts/browse.cjs evalfile scripts/extract-ig.js      # 拿 videoUrl / imageUrls / carousel
node scripts/browse.cjs download "<videoUrl>" "out/IG" --name reel.mp4
```

**注意**：`videoUrl` 是签名地址，**有时效**（`oe=` 是过期时间戳），拿到就下。

---

## 通用规则（跨平台）

1. **图片尺寸不是"原图"**：几乎所有站都用 URL 参数或路径段控制尺寸（`name=`、`/large`、`/orj1080`、`?x-oss-process=`），先找参数再下载
2. **签名 URL 有时效**：抖音/快手/X 的 CDN 带 `x-expires`、`x-signature`，抓完立刻下，别存着明天用
3. **Referer 是常见校验**：`capture`/`download` 会带同源 Referer；跨域 CDN 常要**页面地址**作 Referer（`hls-merge.cjs --referer`）
4. **HLS 优先用 `hls-merge.cjs`**：它选最高档、处理音视频分离、带代理，比手写 ffmpeg 稳
5. **有 yt-dlp 提取器就先试 yt-dlp**（1755 站），失败再上 CDP 拦截；前者省事，后者兜底
6. **登录态统一存在浏览器 profile**（`%LOCALAPPDATA%\media-research\edge-profile`），一次登录平台通吃，重启不掉
7. **TikTok / Instagram 需要 TLS 指纹伪装**：`--impersonate chrome`（依赖 `curl_cffi`）。缺了会报
   `no impersonate target is available`，或直接 JSON 解析失败
8. **TikTok 的格式 ID 不遵循标准 bv/ba 体系**：别用 `bv*[height<=720]+ba`，用 `-f best` 或 `-f h264_720p`
9. **H.264 优先于 H.265/AV1**：B 站会给你 AV1、TikTok 会给你 HEVC，剪映/PR 常常打不开 →
   显式指定 `vcodec` 或格式 ID

---

## 工具选择决策树

```
要下视频？
├─ 是 yt-dlp 支持的站（YouTube/B站/微博/X/TikTok…）→ 先试 yt.cmd
│    └─ 失败（签名/DRM/新改版）→ browse.cjs capture 抓真实请求 → hls-merge.cjs
└─ 不支持的站 / 页面内嵌播放器
     └─ browse.cjs capture → 看 stream 字段
          ├─ stream=false（直链 mp4）→ capture --download
          └─ stream=true（m3u8/mpd）→ hls-merge.cjs

只要图片？
└─ browse.cjs imgs --min-w 600 → 拿 currentSrc → 替换尺寸参数取原图 → download
   （大图/懒加载漏了 → capture 网络层补）
```