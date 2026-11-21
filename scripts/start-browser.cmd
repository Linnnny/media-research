@echo off
rem ============================================================
rem  start-browser.cmd - launch an automation browser with CDP
rem
rem  Why a separate profile: Chromium 127+ refuses
rem  --remote-debugging-port on the default profile, and its
rem  cookies are bound to the original process (App-Bound
rem  Encryption), so logins have to happen in this profile once.
rem
rem  Env vars (all optional):
rem    MEDIA_EDGE_PROFILE   %LOCALAPPDATA%\media-research\edge-profile
rem    MEDIA_PROXY          leave empty for no proxy
rem    CDP_PORT             9222
rem ============================================================

setlocal

set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%EDGE%" (
  echo [x] No Edge or Chrome found. Set the browser path manually.
  exit /b 1
)

if "%MEDIA_EDGE_PROFILE%"=="" set "MEDIA_EDGE_PROFILE=%LOCALAPPDATA%\media-research\edge-profile"
if "%CDP_PORT%"=="" set "CDP_PORT=9222"

set "PROXY_ARG="
if not "%MEDIA_PROXY%"=="" set "PROXY_ARG=--proxy-server=%MEDIA_PROXY% --proxy-bypass-list=<-loopback>"

if not exist "%MEDIA_EDGE_PROFILE%" (
  echo [i] First run: creating profile at %MEDIA_EDGE_PROFILE%
  echo [i] Log in to each site once; the session persists across restarts.
)

start "" "%EDGE%" ^
  --user-data-dir="%MEDIA_EDGE_PROFILE%" ^
  --remote-debugging-port=%CDP_PORT% ^
  %PROXY_ARG% ^
  --no-first-run --no-default-browser-check about:blank

echo Launched: profile=%MEDIA_EDGE_PROFILE%  cdp=%CDP_PORT%
echo Verify:   curl http://127.0.0.1:%CDP_PORT%/json/version
exit /b 0