#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo '请先安装 Node.js 22 或更新版本，然后重新打开。'
  read -r '?按回车关闭…'
  exit 1
fi
if [[ ! -d node_modules/@redis/client ]]; then
  npm ci || exit 1
fi
npm start
read -r '?服务已停止，按回车关闭…'
