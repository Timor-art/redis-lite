#!/bin/zsh
PID_FILE="${TMPDIR:-/tmp}/redis-lite-${USER}.pid"
if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$pid" == <-> ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "Redis Lite 已停止。"
  else
    echo "Redis Lite 当前没有运行。"
  fi
  rm -f "$PID_FILE"
else
  echo "Redis Lite 当前没有运行。"
fi
sleep 1
