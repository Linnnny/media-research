# media-research

**不用任何 API key 的素材检索工具链** —— 驱动真实浏览器 + 命令行工具，把「找原稿、抓图、抓视频、抓社交平台选题」四件事串成可复现的流程。

> A no-API-key media research toolchain: drive a real browser over CDP, trace news to its original publisher, and download images/videos/HLS streams from 9 platforms — all scriptable, no keys.

---

## 为什么做这个

大多数「素材检索」工具要么依赖付费 API（拿不到国内平台），要么只能给你一堆链接。

这套东西的前提是：**你浏览器里已经登录的账号，才是最强的凭证**。于是它不调 API、不逆接口，而是：

- 用 **CDP** 驱动一个独立的浏览器实例（你自己的登录态长期存在里面）
- 用 **Node 原生 WebSocket** 直连 DevTools，零 npm 依赖
- 用 **yt-dlp / ffmpeg** 兜住 1000+ 站点的视频
- 用**打分器**判断一条新闻是不是「原稿」，而不是靠感觉

---

## 四项能力

| 能力 | 命令 | 说明 |
|---|---|---|
| **新闻原稿溯源** | `news-find.cjs` | 多引擎检索 → 抓元数据 → 打分（权威域名/时间/署名/官方公告路径/转载特征）→ 按时间排序 |
| **网页抓媒体** | `browse.cjs` | DOM 层取图（`currentSrc` + 原始尺寸）+ 网络层拦截（懒加载 / `blob:` 播放页 / HLS） |
| **社交平台选题** | `extract-list.js` | 抖音 / 小红书搜索结果 → 结构化 JSON（标题/作者/点赞/日期/ID/链接/封面） |
| **视频下载** | `yt.cmd` + `hls-merge.cjs` | yt-dlp 包装 + HLS 选档合流（自动处理音视频分离） |

---

## 实测平台（2026-11）

| 平台 | 状态 | 关键手段 |
|---|---|---|
| X (Twitter) | ✅ | `extract-x.js` 图片回溯 + `hls-merge.cjs` 双流合并 |
| 抖音 | ✅ | `extract-list.js` 结构推断（卡片不是 `<a>`） |
| 小红书 | ✅ | 同上，需排除 `<script>` 里的初始 JSON |
| YouTube | ✅ | `yt.cmd`（**必须有 JS 运行时**，否则只给音频） |
| B 站 | ✅ | DASH 音视频分离，`-f "bv*[vcodec^=avc]"` 取 H.264 |
| 微博 | ✅ | `<video>` 是空壳，必须走网络层拦截 |
| TikTok | ✅ | `--impersonate chrome` + `curl_cffi` |
| Instagram | ✅ | 官方 API（**capture 只能拿到 128 字节分片**，见 `references/platforms.md`） |
| 新闻站（CCTV/澎湃/新华…） | ✅ | HLS + `hls-merge.cjs` |

每家的图片尺寸参数、视频协议、登录要求、专属坑都写在 [`references/platforms.md`](references/platforms.md)。

---

## 快速开始

### 1. 环境

```bash
node -v            # >= 20（用原生 WebSocket）
ffmpeg -version    # 视频合流
ffprobe -version
yt-dlp --version   # 视频下载（可选）
python -m pip install curl_cffi   # TikTok / Instagram 需要
```

Windows 用户注意：`.cmd` 包装器假定 Edge/Chrome 装在默认位置。

### 2. 起一个带调试端口的浏览器

```bash
scripts/start-browser.cmd
# 或手动：
# msedge --user-data-dir=%LOCALAPPDATA%\media-research\edge-profile --remote-debugging-port=9222 about:blank
```

验证：

```bash
curl http://127.0.0.1:9222/json/version
```

> **为什么必须用独立 profile**：Chromium 127+ 不允许默认 profile 开远程调试端口；
> 而且 cookie 受 App-Bound Encryption 保护，复制出来解不开 —— 所以每个站**登录一次**就行，
> 之后登录态长期留在 profile 里。

### 3. 跑起来

```bash
# 找一条新闻的原稿
node scripts/news-find.cjs search "Anthropic 上市" --top 8 --vertical

# 抓某个页面的所有图片
node scripts/browse.cjs open "https://example.com/article"
node scripts/browse.cjs imgs --min-w 600 -n 20

# 抓 HLS 视频（自动选最高档 + 合流音视频）
node scripts/hls-merge.cjs "<m3u8>" out/video.mp4 --referer "https://example.com/"

# 抖音搜索结果
node scripts/browse.cjs open "https://www.douyin.com/search/关键词"
node scripts/browse.cjs evalfile scripts/extract-list.js

# YouTube / B站 / X
scripts/yt.cmd -F "<url>"
scripts/yt.cmd -f "bv*[height<=1080]+ba/b[height<=1080]" "<url>"
```

完整命令见 [`references/commands.md`](references/commands.md)。

---

## 配置

全部通过环境变量，无配置文件：

| 变量 | 默认 | 作用 |
|---|---|---|
| `MEDIA_PROXY` | 自动探测 7897/7890/10809/1080/2080 | HTTP 代理 |
| `CDP_PORT` | `9222` | 浏览器调试端口 |
| `MEDIA_EDGE_PROFILE` | `%LOCALAPPDATA%\media-research\edge-profile` | 自动化 profile |
| `MEDIA_NODE` | `node` | JS 运行时（YouTube nsig） |
| `YTDLP` | `yt-dlp` | yt-dlp 可执行文件 |
| `MEDIA_NO_PROXY` | — | 设为 1 强制直连 |

---

## 设计取舍

**为什么不用 API？** 国内平台基本没有可用的开放接口，海外图库 API 覆盖不到新闻现场。浏览器登录态 + 网络层拦截是唯一通用的路。

**为什么要打分器？** 搜索引擎给的「最新」不等于「原稿」。`news-find.cjs` 用 9 条规则打分（官方公告路径 +15、聚合站 -25、强转载特征 -10/条…），把「谁先发的」这件事量化。

**为什么踩了这么多平台坑还留着记录？** 因为每个坑都会重复出现。`references/platforms.md` 里每条都写了「现象 → 原因 → 解法」，比如「Instagram 的 capture 只有 128 字节」这种，不看文档会再花一小时。

---

## 已知限制

- **DRM 加密内容**（Netflix / Disney+ / 会员片）：技术上无法处理
- **签名 URL 有时效**：抖音/快手/X 的 CDN 几小时～几天过期，抓完立刻下
- **B 站高码率**需要 `SESSDATA` cookie；默认可能选到 AV1（剪映/PR 打不开），要显式指定 H.264
- **Instagram** 的 yt-dlp 提取器当前标记为 broken，只能走官方 API 路线
- 这套工具**只负责获取**；素材能不能用取决于用途与授权，见 `SKILL.md` 末节

---

## 目录

```
SKILL.md                 技能主指令（触发词 / 四类流程 / 坑表）
references/
  commands.md            全命令手册 + ffmpeg 配方 + 故障矩阵
  platforms.md           9 个平台的差异手册 + 工具决策树
scripts/
  browse.cjs             CDP 浏览器驱动器（17 条命令，零依赖）
  news-find.cjs          新闻原稿溯源 + 打分
  hls-merge.cjs          HLS 选档 / 音视频分离合流
  extract-list.js        通用列表抽取（抖音 / 小红书）
  extract-x.js           X 专用（图片回溯推文）
  extract-ig.js          Instagram 专用（官方 API）
  yt.cmd                 yt-dlp 包装器
  start-browser.cmd      一键起带调试端口的浏览器
```

---

## 许可

MIT，见 [LICENSE](LICENSE)。脚本里的第三方工具（yt-dlp、ffmpeg）各自遵循其原许可。

使用素材时请自行确认授权：评论/引用需标注来源，商业用途请改用可商用素材库。