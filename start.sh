#!/usr/bin/env bash
# infohub 一键启动：只负责启动，不装依赖（依赖用 pnpm install 自行准备）
# Electron 单进程（main 起 renderer），单窗格跑 dev。见 docs/start-sh-convention 约定。
set -euo pipefail
cd "$(dirname "$0")"
SELF="$PWD/start.sh"
SESSION="infohub"
TMUX_CONF="$PWD/.tmux.conf"
tm() { tmux -f "$TMUX_CONF" "$@"; }
has_session() { tmux has-session -t "$SESSION" 2>/dev/null; }
pane_command() { tm list-panes -t "$SESSION":app -F '#{pane_current_command}' 2>/dev/null | head -1; }
is_running() {
  has_session || return 1
  case "$(pane_command)" in
    zsh|bash|sh|fish|'') return 1 ;;
    *) return 0 ;;
  esac
}

start() {
  is_running && { echo "已在运行，用 '$SELF attach' 查看"; exit 0; }
  if has_session; then
    echo "检测到已退出的旧会话，正在清理…"
    tm kill-session -t "$SESSION"
  fi
  tm new-session -d -s "$SESSION" -n app -c "$PWD"
  pane=$(tm list-panes -t "$SESSION":app -F '#{pane_id}' | head -1)
  tm select-pane -t "$pane" -T "electron dev"
  tm send-keys -t "$pane" "pnpm dev" C-m
  echo "已启动 tmux session '$SESSION'。'$SELF attach' 看日志，'$SELF stop' 停止。"
}
stop() { has_session && tm kill-session -t "$SESSION" && echo "已停止" || echo "未运行"; }
status() {
  if is_running; then
    tm list-panes -t "$SESSION":app -F "  #{pane_index} #{pane_title} command=#{pane_current_command} pid=#{pane_pid}"
  elif has_session; then
    echo "进程已退出，但 tmux 会话仍存在；再次执行 '$SELF' 会自动清理并重启"
  else
    echo "未运行"
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop || true; sleep 1; start ;;
  status) status ;;
  attach) tm attach -t "$SESSION" ;;
  *) echo "用法: $0 [start|stop|restart|status|attach]"; exit 1 ;;
esac
