#!/usr/bin/env bash
# infohub 一键启动：只负责启动，不装依赖（依赖用 pnpm install 自行准备）
# Electron 单进程（main 起 renderer），单窗格跑 dev。见 docs/start-sh-convention 约定。
set -euo pipefail
cd "$(dirname "$0")"
SESSION="infohub"
TMUX_CONF="$PWD/.tmux.conf"
tm() { tmux -f "$TMUX_CONF" "$@"; }
is_running() { tmux has-session -t "$SESSION" 2>/dev/null; }

start() {
  is_running && { echo "已在运行，用 './start.sh attach' 查看"; exit 0; }
  tm new-session -d -s "$SESSION" -n app -c "$PWD"
  pane=$(tm list-panes -t "$SESSION":app -F '#{pane_id}' | head -1)
  tm select-pane -t "$pane" -T "electron dev"
  tm send-keys -t "$pane" "pnpm dev" C-m
  echo "已启动 tmux session '$SESSION'。'./start.sh attach' 看日志，'./start.sh stop' 停止。"
}
stop() { is_running && tmux kill-session -t "$SESSION" && echo "已停止" || echo "未运行"; }

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop || true; sleep 1; start ;;
  status) is_running && tmux list-panes -t "$SESSION":app -F "  #{pane_index} #{pane_title} pid=#{pane_pid}" || echo "未运行" ;;
  attach) tm attach -t "$SESSION" ;;
  *) echo "用法: $0 [start|stop|restart|status|attach]"; exit 1 ;;
esac
