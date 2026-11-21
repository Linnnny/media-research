---
name: media-research
tags: media, assets, news, source-tracing, browser-automation, cdp, download, hls, douyin, xiaohongshu, youtube, bilibili, stock-footage
requirements:
  - node (>= 20; uses global WebSocket, no npm install)
  - ffmpeg / ffprobe (stream muxing, clipping, probing)
  - yt-dlp (1000+ sites; needs a JS runtime for YouTube)
  - a local HTTP proxy (Clash on 127.0.0.1:7897 by default)
  - an Edge/Chrome started with --remote-debugging-port=9222
description: >
  Find and download media assets, and trace news to its original publisher.
  Four jobs: (A) news original-source tracing with an "originality score",
  (B) grab every image/video/HLS stream from a web page,
  (C) harvest posts from Douyin / Xiaohongshu search (logged-in browser),
  (D) download videos from YouTube / Bilibili / X / 1000+ sites via yt-dlp.
  Drives a real browser over CDP — no API keys, no headless browser install.
  Auto-detects the local proxy and routes domestic-direct / overseas-through-proxy.
  Triggers on: 找素材, 素材收集, 新闻原稿, 原稿溯源, 新闻溯源, 抓图, 抓图片, 抓视频,
  下载素材, 视频下载, 图片下载, B-roll, 空镜, stock footage,
  抖音搜索, 小红书搜索, 选题, YouTube 下载, B站下载, X 抓取,
  "find the original source of this news", "download this video",
  "grab the images from this page", "who published this first".
---

# media-research

四件事：**新闻找原稿**、**网页抓媒体**、**社交平台抓帖子**、**视频下载**。
全部走本机浏览器 + 命令行工具，不依赖任何 API key。

## 0. 先确认环境

```bash
node -v && ffmpeg -version | head -1 && yt-dlp --version
# 浏览器调试端口是否就绪
curl -s http://127.0.0.1:9222/json/version
```

端口没开就先起浏览器（独立 profile，不影响日常 Edge，登录态长期保存在里面）：

```bash
scripts/start-browser.cmd
```

**代理是可选配置**：设了 `MEDIA_PROXY`（如 `http://127.0.0.1:7897`）就走代理，
没设就走直连。`browse.cjs` / `news-find.cjs` / `hls-merge.cjs` 还会自动探测
7897/7890/10809/1080/2080，**分流规则交给代理软件**（国内直连、国外走节点）。

**可配置的环境变量**

| 变量 | 默认 | 作用 |
|---|---|---|
| `MEDIA_PROXY` | 自动探测 | HTTP 代理地址 |
| `CDP_PORT` | `9222` | 浏览器调试端口 |
| `MEDIA_EDGE_PROFILE` | `%LOCALAPPDATA%\media-research\edge-profile` | 自动化 profile 目录 |
| `MEDIA_NODE` | `node` | JS 运行时（YouTube nsig 需要） |
| `YTDLP` | `yt-dlp` | yt-dlp 可执行文件 |
| `MEDIA_NO_PROXY` | — | 设为 1 强制直连 |

---

## A. 新闻原稿溯源

```bash
node scripts/news-find.cjs search "Anthropic 上市" --top 8 --vertical
node scripts/news-find.cjs search "Fed rate decision" --top 6        # 海外，自动走代理
node scripts/news-find.cjs search "某事件" --open 1                  # 直接在浏览器打开最早那篇
node scripts/news-find.cjs meta "<url>"                              # 单页打分
```

输出按**发布时间升序**（最早 ≈ 原稿），同时间按原稿分排序，并给出每条的依据。
原稿分依据：权威域名 +25 / 聚合站 -25；meta 时间 +12（URL 推断 +6）/ 无 -12；
署名 +10 / 无 -6；**官方公告路径 +15**；声明非本站来源 -12；强转载特征 -10/条（上限 -20）。

判读规则：

- `★原稿`（≥75）：可直接引用
- `·可能原稿`（55–74）：多为媒体首发稿，需结合署名判断
- `×转载/二手`（<55）：回溯它标注的原始出处，别当一手引用

`--vertical` 会追加 Bing 新闻（按时间排序）+ 百度资讯，中文突发新闻命中率更高。

---

## B. 网页抓图片 / 视频

```bash
# 1) DOM 层：图片（带原始尺寸）、视频、链接
node scripts/browse.cjs open "https://example.com/article"
node scripts/browse.cjs imgs --min-w 600 -n 20
node scripts/browse.cjs media

# 2) 下载单张（指定名字）
node scripts/browse.cjs download "<图片URL>" "out/主题" --name 01.jpg

# 3) 网络层：连播/懒加载/`blob:` 播放页只能用这招
node scripts/browse.cjs capture "<页面URL>" --seconds 15 --download "out/主题"
```

`capture` 会列出该页所有媒体请求（`mime`、是否流、大小）。看到 `stream: true`（m3u8/mpd）就交给
`hls-merge.cjs`——自动选最高画质、处理音视频分离、带代理与 Referer：

```bash
node scripts/hls-merge.cjs "<m3u8 地址>" "out/主题/video.mp4" --referer "<页面URL>"
node scripts/hls-merge.cjs "<m3u8>" out.mp4 --probe-only     # 只看会选到哪一档
```

> ⚠️ ffmpeg **不走系统代理**。海外 CDN（twimg / googlevideo）必须传
> `-http_proxy http://127.0.0.1:7897`；`hls-merge.cjs` 已自动带上。

---

## B2. X（Twitter）图片 / 视频

X 的 DOM 现在**没有 `<article>` 容器**，`data-testid` 也改过，别用通用选择器。
用 `extract-x.js`（从 `pbs.twimg.com/media` 图片回溯所属推文）：

```bash
node scripts/browse.cjs open "https://x.com/search?q=关键词%20filter%3Amedia&f=media"
node scripts/browse.cjs wait 6000
node scripts/browse.cjs evalfile scripts/extract-x.js      # 推文 + 原图(name=orig) + 是否带视频

node scripts/browse.cjs open "https://x.com/search?q=关键词%20filter%3Anative_video&f=video"
node scripts/browse.cjs evalfile scripts/extract-x.js
node scripts/browse.cjs capture "<推文URL>" --seconds 12   # 找 video.twimg.com 的 m3u8
node scripts/hls-merge.cjs "<m3u8>" "out/X/v.mp4" --referer "https://x.com/"
```

- 图片：`?name=orig` 取原图（`small`/`360x360` 是缩略图）
- 视频：HLS **音视频分离**，必须两条流 map 合并 —— `hls-merge.cjs` 已处理
- 登录态：`auth_token` 存在 profile 里，约 1 年有效；`cookies --filter x.com` 可查

---

## B3. Instagram

**yt-dlp 的 IG 提取器是 broken，`capture` 也只能拿到 128 字节的分片** —— 必须走官方 API：

```bash
node scripts/browse.cjs open "https://www.instagram.com/p/<shortcode>/"
node scripts/browse.cjs wait 5000
node scripts/browse.cjs evalfile scripts/extract-ig.js     # 拿 videoUrl / imageUrls / carousel
node scripts/browse.cjs download "<videoUrl>" "out/IG" --name reel.mp4
```

原理：从页面 HTML 挖**数字 media_id**（`"id":"(\d{15,})_\d+"`，shortcode 不能当 id 用），
再在页面内调 `/api/v1/media/<id>/info/`（带 `x-ig-app-id: 936619743392459`），
取 `items[0].video_versions[0].url` —— 那是完整 progressive mp4。

- 需要登录（`sessionid` + `ds_user_id`）
- `videoUrl` 带 `oe=` 过期戳，**拿到就下**
- 轮播内容在 `carousel_media[]` 里逐项取

---

## C. 抖音 / 小红书（需登录态）

登录态存在浏览器 profile 里，一次扫码长期有效（有效期通常 1 年）。
查登录状态：

```bash
node scripts/browse.cjs cookies --filter douyin      | findstr sessionid
node scripts/browse.cjs cookies --filter xiaohongshu | findstr web_session
```

抓搜索结果（关键词从 URL 自动读取）：

```bash
# 抖音
node scripts/browse.cjs open "https://www.douyin.com/search/关键词"
node scripts/browse.cjs evalfile scripts/extract-list.js

# 小红书
node scripts/browse.cjs open "https://www.xiaohongshu.com/search_result?keyword=关键词&source=web_search_result_notes"
node scripts/browse.cjs evalfile scripts/extract-list.js
```

返回 JSON：标题 / 作者 / 点赞 / 日期 / 标签 / 视频ID或笔记ID / 链接 / 封面直链 / 原文。
保存惯例：`<主题>.json` 与素材同目录，作为**溯源证据**保留。

---

## D. 视频下载（yt-dlp 包装器）

```bash
scripts/yt.cmd -F "<url>"                                    # 列格式
scripts/yt.cmd "<url>"                                       # 最佳画质
scripts/yt.cmd -f "bv*[height<=1080]+ba/b[height<=1080]" "<url>"
scripts/yt.cmd --download-sections "*0-30" "<url>"           # 只下前 30 秒
scripts/yt.cmd -x --audio-format mp3 "<url>"                 # 只要音频
scripts/yt.cmd --write-thumbnail --skip-download "<url>"     # 只要封面
scripts/yt.cmd -o "out/%%(title)s.%%(ext)s" "<url>"
```

`yt.cmd` 已内置两件必需参数：`--proxy <Clash>` 和 `--js-runtimes node:<path>`。
**缺 JS 运行时时 YouTube 只会给音频和 HLS**，这是最容易踩的坑。

---

## 输出约定

```
out/<主题>/
  01-<slug>.jpg / .mp4 ...
  manifest.json        # 标题、作者、来源页、授权、字节数、抓取时间
  <平台>-<关键词>.json  # 搜索结果（抖音/小红书）
```

先建目录再下载；素材与清单放一起，方便日后署名与溯源。

---

## 常见坑（都实际踩过）

| 现象 | 原因 | 解法 |
|---|---|---|
| `CDP 未就绪` / `fetch failed` | 浏览器没带调试端口，或已退出 | `scripts/start-browser.cmd` |
| 默认 profile 开不了调试端口 | Chromium 127+ 禁止默认目录监听调试 | 必须用独立 `--user-data-dir` |
| 复制 cookie 后仍未登录 | App-Bound 加密，密钥绑原进程 | 在新 profile 里**重新登录一次** |
| 抖音结果是 0 条 | 卡片不是 `<a>`，`innerText` 取不到 | 用 `extract-list.js`（关键词簇 + `textContent`） |
| 小红书抓到 `<script>` | 初始状态 JSON 混入 | 脚本已排除 SCRIPT/STYLE |
| 视频 ID 抓不到 | ID 在元素 `id="waterfall_item_..."` | 脚本已按此提取 |
| YouTube 只有音频格式 | 缺 JS 运行时 | `yt.cmd` 已内置 `--js-runtimes` |
| 抓到的图是缩略图 | 用了页面 `src` | 改 `imgs` 的 `currentSrc`；X 图加 `?name=orig` |
| ffmpeg 报 `tls IO error -10054` | ffmpeg 不走系统代理 | 加 `-http_proxy`，或用 `hls-merge.cjs` |
| ffmpeg 输出 0 字节 / `moov atom not found` | 主列表音视频分离，`-c copy` 直接合会坏 | 两条流分别 `-i`，`-map 0:v:0 -map 1:a:0` |
| X 抽取返回 0 条 | X 已无 `<article>`，`data-testid` 变更 | 用 `extract-x.js`（图片回溯） |
| `download` 报 `fetch failed`（海外域名） | Node fetch 未启用代理 | 已修（`browse.cjs` 自举；`MEDIA_NO_PROXY=1` 可关） |
| `evalfile`/`capture` 跑到了别的页面 | 多标签时 CDP 连错 tab（如 Edge 推广页） | 已修（`open` 记忆 targetId，后续命令复用同一标签页） |
| TikTok 报 `no impersonate target` | 缺 `curl_cffi`，无 TLS 指纹伪装 | `pip install curl_cffi`；`yt.cmd` 已内置 `--impersonate chrome` |
| TikTok 格式选择器不匹配 | 它的格式 ID 不走标准 bv/ba | 用 `-f best` 或 `-f h264_720p` |
| Instagram 提取器报 broken | yt-dlp 里该站已标记损坏 | 改用 `extract-ig.js`（官方 API 路线） |
| IG `capture` 只下到 128 字节 | `<video>` 是 `blob:`，网络层是签名分片 | 别下分片，用 API 取 `video_versions[0].url` |

更多命令细节与参数见 `references/commands.md`；
各站点的图片参数、视频协议、登录要求与专属坑见 `references/platforms.md`（含工具决策树）。

---

## 使用权（不是技术问题，但决定能不能用）

- **新闻评论 / 解说 / 行业分析**：属"适当引用"，标注来源（媒体名 + 原链接）、引用短、不替代原作
- **商业广告 / 带货 / 商单**：不要用抓取的版权内容，改用 Pexels / Pixabay / CC0 + 正版音乐
- **抖音/小红书二创**：纯搬运会被判侵权并限流，需重组改写 + 标注
- **DRM 加密内容**（Netflix / Disney+ 会员片）：技术上无法处理
- 保留 `manifest.json` 与来源 URL，是日后证明"合理使用"的证据