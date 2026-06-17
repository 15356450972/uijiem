@echo off
chcp 65001 >nul
setlocal

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

title VideoBatchGenerator 一键启动

echo ========================================
echo VideoBatchGenerator 一键启动
echo 项目目录: %CD%
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js。
  echo 请先安装 Node.js LTS: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 npm。
  echo 请确认 Node.js 已正确安装，并重新打开此脚本。
  echo.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo [错误] 当前目录未找到 package.json。
  echo 请把本文件放在项目根目录后再运行。
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [信息] 首次运行，正在安装前端依赖...
  call npm install
  if errorlevel 1 (
    echo.
    echo [错误] npm install 执行失败。
    pause
    exit /b 1
  )
  echo.
)

where python >nul 2>nul
if errorlevel 1 (
  where py >nul 2>nul
  if errorlevel 1 (
    echo [提示] 未检测到 Python。开发模式后端可能无法启动。
    echo 如果启动后后端不可用，请安装 Python 并配置环境变量。
    echo.
  )
)

echo [信息] 正在启动应用...
echo 关闭此窗口会同时停止开发服务。
echo.

call npm run electron:dev

echo.
echo [信息] 应用已退出。
pause
