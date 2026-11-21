@echo off
rem ============================================================
rem  yt.cmd - yt-dlp wrapper
rem
rem  Adds the three flags media-research needs, only when relevant:
rem    --proxy        only when MEDIA_PROXY is set (e.g. a local Clash)
rem    --js-runtimes  lets yt-dlp solve YouTube's nsig (needs Node on PATH)
rem    --impersonate  TikTok / Instagram TLS fingerprint (needs curl_cffi)
rem
rem  Env vars (all optional):
rem    MEDIA_PROXY   http://127.0.0.1:7897      proxy for overseas sites
rem    MEDIA_NODE    node                       JS runtime binary
rem    YTDLP         yt-dlp                     yt-dlp binary
rem
rem  Usage:
rem    yt -F <url>                                  list formats
rem    yt <url>                                     best quality
rem    yt -f "h264_720p" <url>                      TikTok: force H.264
rem    yt -f "bv*[vcodec^=avc][height<=1080]+ba" <url>   Bilibili: force H.264
rem    yt --download-sections "*0-30" <url>         first 30 seconds
rem    yt -x --audio-format mp3 <url>               audio only -> mp3
rem    yt --write-thumbnail --skip-download <url>   thumbnail only
rem    yt -o "out\%%(title)s.%%(ext)s" <url>        custom output
rem ============================================================

setlocal

if "%YTDLP%"==""      set "YTDLP=yt-dlp"
if "%MEDIA_NODE%"=="" set "MEDIA_NODE=node"

set "PROXY_ARG="
if not "%MEDIA_PROXY%"=="" set "PROXY_ARG=--proxy %MEDIA_PROXY%"

"%YTDLP%" %PROXY_ARG% --js-runtimes "node:%MEDIA_NODE%" --impersonate chrome %*
exit /b %ERRORLEVEL%