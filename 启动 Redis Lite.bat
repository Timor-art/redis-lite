@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Redis Lite 需要 Node.js 22 或更新版本。
  echo 请先安装 Node.js：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\@redis\client" (
  echo 首次启动，正在安装依赖...
  call npm ci
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

start "Redis Lite 服务" cmd /k "cd /d ""%~dp0"" && npm start"
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:6380
echo Redis Lite 已启动，服务窗口保持打开即可。
echo 关闭“Redis Lite 服务”窗口即可停止服务。
endlocal
