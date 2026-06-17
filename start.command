#!/bin/zsh
set -e

cd "$(dirname "$0")"

printf '\033]0;VideoBatchGenerator 一键启动\007'

echo "========================================"
echo "VideoBatchGenerator macOS 一键启动"
echo "项目目录: $(pwd)"
echo "========================================"
echo ""

# Load common shell profiles so Node installed by nvm/fnm/asdf/Homebrew can be found.
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"
[ -f "$HOME/.bash_profile" ] && source "$HOME/.bash_profile"

export PATH="$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -n 1)/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js。"
  echo "请先安装 Node.js LTS: https://nodejs.org/"
  echo "如果已安装，请重新打开终端或检查 PATH。"
  echo ""
  read "?按回车键退出..."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[错误] 未检测到 npm。"
  echo "请确认 Node.js 已正确安装。"
  echo ""
  read "?按回车键退出..."
  exit 1
fi

if [ ! -f "package.json" ]; then
  echo "[错误] 当前目录未找到 package.json。"
  echo "请把本文件放在项目根目录后再运行。"
  echo ""
  read "?按回车键退出..."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[信息] 首次运行，正在安装前端依赖..."
  npm install
  echo ""
fi

if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
  echo "[提示] 未检测到 Python。开发模式后端可能无法启动。"
  echo "如果启动后后端不可用，请安装 Python 并配置环境变量。"
  echo ""
fi

echo "[信息] 正在启动应用..."
echo "关闭此窗口会同时停止开发服务。"
echo ""

npm run electron:dev

echo ""
echo "[信息] 应用已退出。"
read "?按回车键关闭窗口..."
