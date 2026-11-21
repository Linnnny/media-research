# media-research — 命令参考

所有脚本位于 `<skill>/scripts/`。以下假定当前目录为 skill 根目录。
工具链：`node`（≥20，用原生 WebSocket）、`ffmpeg`/`ffprobe`、`yt-dlp` 均需在 PATH 上。

---

## browse.cjs —— CDP 浏览器驱动器

前提：浏览器带 `--remote-debugging-port=9222` 启动（见 `scripts/start-browser.cmd`）。

| 命令 | 说明 |
|---|---|
| `open <url>` | 导航并等加载完成；会轮询到标题不再是裸域名（SPA 常见） |
| `title` | 当前标题 + URL |
| `text [选择器] [--limit N]` | 可见文本（默认 `body`，上限 20000 字符） |
| `links [选择器] [-n N]` | 链接（文字 + href），默认 `a` |
| `imgs [--min-w N] [-n N]` | 图片（`currentSrc` + 原始宽高） |
| `media` | `<video>` / `<source>` 列表（src、poster、duration） |
| `eval "<js>"` | 执行表达式并返回结果（`awaitPromise` 开启） |
| `evalfile <脚本>` | 从文件执行 JS 体，允许 `await` / `return`（**复杂脚本必须用这个**） |
| `click "<css>"` | 滚动到元素并 `click()` |
| `type "<css>" "<文本>"` | 写值并派发 `input`/`change` |
| `key <Enter\|ArrowDown\|Escape\|PageDown>` | 发送按键 |
| `scroll <px>` | 滚动页面 |
| `wait <ms>` | 等待 |
| `shot [path]` | 截图（PNG） |
| `download <url> <dir> [--name N]` | 下载单文件（自动带 UA + Referer） |
| `capture <url> [--seconds N] [--download DIR]` | **网络层拦截媒体**（图片/视频/HLS/DASH） |
| `cookies [--filter 域名]` | cookie 元数据（名称/域/httpOnly/有效期，**不打印值**） |
| `tabs` | 标签页列表 |

环境变量：`CDP_PORT`（默认 9222）。

**标签页记忆**：`open` 会把目标页 id 记到系统临时目录（`browse-target-<port>.txt`），
后续命令优先复用同一标签页。多标签时不会再莫名连到 `edge://` 推广页或别的 tab。
要强制切到另一个标签页，重新 `open` 一次即可。

### 用法要点

- **不要用 `eval` 传带引号的复杂 JS**：PowerShell 会吃掉双引号。写进 `.js` 文件用 `evalfile`。
- `capture` 的 `--download` 只自动下载**非流**文件；`stream: true` 的交 ffmpeg。
- `cookies` 是判断登录态的可靠手段（`document.cookie` 拿不到 httpOnly 的 session）。

```bash
node scripts/browse.cjs open "https://x.com/user/status/123"
node scripts/browse.cjs capture "https://example.com/video-page" --seconds 15 --download "out/x"
node scripts/browse.cjs cookies --filter xiaohongshu
```

---

## news-find.cjs —— 新闻原稿溯源

| 命令 | 说明 |
|---|---|
| `search "<关键词>" [--top N] [--vertical] [--json] [--open N]` | 搜索并按时间升序 + 原稿分排序 |
| `meta <url>` | 单页元数据 + 评分 |
| `--providers` | （旧版）查看数据源状态 |

- `--vertical`：追加 **Bing 新闻**（按时间排序）+ **百度资讯**
- `--open N`：在浏览器里打开第 N 条
- `--json`：机器可读输出

### 原稿分算法（0–100，基线 50）

```
权威源域名            +25      聚合站/自媒体        -25
meta 发布时间         +12      无时间              -12
  └ URL 路径推断日期   +6
有署名                +10      无署名               -6
官方公告路径          +15      声明来源≠本站        -12
  (/news/ /press/ /investor/ /newsroom/ ...)
强转载特征            -10/条（本文转自|转载自|原标题|原文链接，上限 -20）
引用措辞              -5/条（据…报道|综合…报道|援引|消息称，上限 -10）
```

判定：`≥75 ★原稿` / `55–74 ·可能原稿` / `<55 ×转载二手`

### 相关性闸门

正文前 1200 字或标题必须命中查询实义词（≥2 字），否则丢弃——用于过滤垂直搜索带来的无关结果。

### 代理

启动时自动探测 `7897/7890/10809/1080/2080`，用 `NODE_USE_ENV_PROXY=1` 重启自身。
分流由 Clash 规则决定；要强制直连就手动设 `HTTPS_PROXY=""`。

---

## extract-list.js —— 通用列表抽取

通过 `evalfile` 注入到已打开的**搜索结果页**。关键词从 URL 自动读取
（`/search/<kw>` 或 `?keyword=<kw>`）。

返回字段：

| 字段 | 说明 |
|---|---|
| `标题` | 去掉时长/点赞/标签/作者后的主干 |
| `时长` | 抖音 `mm:ss` |
| `点赞` | 含 `万`/`w` 单位 |
| `作者` | `@xxx` 或卡片作者名 |
| `日期` | `MM-DD` / `YYYY-MM-DD` / `N天前` |
| `标签` | `#话题` 数组 |
| `视频ID` | 抖音 `waterfall_item_<id>` |
| `笔记ID` | 小红书 `/explore/<id>` |
| `链接` | 归一化后的详情页地址 |
| `封面` | 图片直链（签名 URL） |
| `文本原文` | 原始卡片文本，便于二次清洗 |

算法：取含关键词的**叶子节点**（排除 SCRIPT/STYLE）→ 统计每个祖先容器里落了多少叶子
→ 选「叶子数 − 子节点数×0.12」最高的容器 → 其子节点即卡片。抖音/小红书同一套可用。

---

## extract-x.js —— X（Twitter）专用抽取

X 现在**没有 `<article>` 容器**，`data-testid` 也已变更，通用抽取器会返回 0 条。
本脚本从 `pbs.twimg.com/media` 图片向上回溯，找到包含 `/status/` 链接的祖先，把媒体归到推文。

```bash
node scripts/browse.cjs open "https://x.com/search?q=关键词%20filter%3Amedia&f=media"
node scripts/browse.cjs wait 6000
node scripts/browse.cjs evalfile scripts/extract-x.js
```

返回：`tweet`（去掉了 `/photo/1` 的干净链接）、`hasVideo`、`images`（已替换成 `name=orig` 原图）、`summary`。

要点：

- 图片尺寸参数：`name=small|360x360|orig`，取原图用 **`?name=orig`**
- 视频走 `video.twimg.com`，HLS 且**音视频分离** → 交给 `hls-merge.cjs`
- `filter:media` 只出图；`filter:native_video` 出视频

---

## hls-merge.cjs —— HLS 下载 + 合流

```bash
node scripts/hls-merge.cjs "<m3u8>" "out/x.mp4" --referer "https://x.com/"
node scripts/hls-merge.cjs "<m3u8>" out.mp4 --probe-only          # 只探测选档
node scripts/hls-merge.cjs "<m3u8>" out.mp4 --max-height 1080     # 限制分辨率
```

它替你处理四件事：

1. **解析主播放列表**，在 `--max-height` 内按「高度 → 带宽」选最优点，而不是拿最低档
2. **音视频分离**时自动找 `EXT-X-MEDIA` 的音轨，用 `-map 0:v:0 -map 1:a:0` 合并
3. **代理**：自动探测并在 ffmpeg 上带 `-http_proxy`（ffmpeg 本身不读系统代理）
4. **Referer**：`--referer` 透传到请求头

实测（X 一条 22 秒视频）：主列表 3 个变体 → 自动选 `720x1280 865kbps` + 单独音轨 →
输出 `2.30 MB / h264 720x1280 / 22.4s`。

---

## yt.cmd —— yt-dlp 包装器

已内置 `--js-runtimes`（YouTube 必需）与 `--impersonate chrome`（TikTok/IG 必需）；
`--proxy` 只在设置了 `MEDIA_PROXY` 时自动加上，没设就直连。

```bash
yt -F "<url>"                                        # 列格式
yt "<url>"                                           # 最佳画质
yt -f "bv*[height<=1080]+ba/b[height<=1080]" "<url>"
yt --download-sections "*0-30" --force-keyframes-at-cuts "<url>"
yt -x --audio-format mp3 "<url>"
yt --write-thumbnail --skip-download "<url>"
yt --write-subs --sub-langs "zh-Hans,en" "<url>"
yt --playlist-items 1-10 "<playlist>"
yt -o "out/%%(title)s.%%(ext)s" "<url>"
```

环境变量可覆盖：`MEDIA_PROXY`、`MEDIA_NODE`、`YTDLP`。

> **PowerShell 调用注意**：`.cmd` 传入含 `[` `]` `*` `<` `>` 的参数时容易被 cmd 重新解析，
> 报 `The system cannot find the file specified`。两种可靠写法：
>
> 1. 用 `cmd /c` 包一层：`cmd /c "scripts\yt.cmd -F ""https://..."""`
> 2. 直接调 yt-dlp（等价参数）：
>    ```powershell
>    $yt = "yt-dlp.exe"
>    $node = "node.exe"
>    & $yt --proxy "http://127.0.0.1:7897" --js-runtimes "node:$node" -f "bv*[height<=720]+ba/b[height<=720]" "<url>"
>    ```

---

## ffmpeg 常用配方

> **ffmpeg 不读系统代理。** 海外 CDN（`video.twimg.com`、`*.googlevideo.com` 等）必须显式
> 加 `-http_proxy http://127.0.0.1:7897`，否则报 `tls ... Error number -10054`。
> `hls-merge.cjs` 已自动处理，手写命令时别忘。

```bash
# HLS 合流（推荐直接用 hls-merge.cjs，这里是不带音轨分离的简单站）
ffmpeg -hide_banner -y -http_proxy http://127.0.0.1:7897 \
  -headers "Referer: <页面URL>" -i "<m3u8>" -c copy out.mp4

# 音视频分离的主列表：两条流分别取再 map
ffmpeg -y -http_proxy http://127.0.0.1:7897 -i "<video.m3u8>" \
       -http_proxy http://127.0.0.1:7897 -i "<audio.m3u8>" \
       -c copy -map 0:v:0 -map 1:a:0 out.mp4

# 只切前 20 秒（素材预览，体积小）
ffmpeg -y -i "<m3u8|mp4>" -t 20 -c copy clip.mp4

# 音轨抽成 mp3
ffmpeg -y -i in.mp4 -vn -c:a libmp3lame -q:a 2 out.mp3

# 封面出图
ffmpeg -y -i in.mp4 -frames:v 1 -q:v 2 poster.jpg

# 探测（分辨率/编码/时长）
ffprobe -v error -show_entries "format=duration,size:stream=codec_name,width,height" -of json in.mp4
```

---

## 输出目录约定

```
out/<主题>/
  01-<slug>.jpg | .mp4          # 序号前缀保证排序
  manifest.json                 # 标题/作者/来源页/授权/字节数/抓取时间
  <平台>-<关键词>.json           # 搜索结果快照
```

---

## 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| `fetch failed` / `CDP 未就绪` | 浏览器没开或没带调试端口 | `scripts/start-browser.cmd` |
| `AMBIGUOUS_TARGET`（agent-desktop 相关） | 同名控件/多窗口 | 用 `--window-id` |
| 默认 profile 开不了 9222 | Chromium 127+ 安全限制 | 必须独立 `--user-data-dir` |
| 复制 profile 后仍未登录 | App-Bound 加密（密钥绑进程） | 在新 profile 里重新登录 |
| 抖音抽取 0 条 | 卡片非 `<a>`、`innerText` 为空 | 用 `extract-list.js` |
| 小红书抓到 `__INITIAL_STATE__` | `<script>` 叶子被误判 | 脚本已排除 SCRIPT/STYLE |
| YouTube 只列音频 | 缺 JS 运行时 | 用 `yt.cmd`（已内置） |
| 下载到 0 字节 | 站点要 Referer/Cookie | `browse download` 自带 Referer；必要时用 `capture` |
| 图片是缩略图 | 用的是 `src` | `imgs` 用 `currentSrc`；X 图加 `?name=orig` |
| m3u8 下载后不能播 | 直接下载了播放列表 | 必须 ffmpeg 合流 |

---

## 边界

- **DRM 加密**（Widevine：Netflix / Disney+ / 会员片）：无法处理
- **签名 URL 有时效**（抖音/快手数小时～数天）：过期需重抓
- **付费墙**：取决于账号权限
- **B 站高码率**：音视频分离的 DASH，两条流都要下再合