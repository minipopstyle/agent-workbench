#!/bin/zsh
set -euo pipefail

APP_ROOT='/Users/minipop2025/Documents/ChatGPT/agent 轨迹可视化/Agent-Workbench'
STATE_DIR='/Users/minipop2025/.agent-workbench'
PLIST_SOURCE="$APP_ROOT/com.minipop.agent-workbench.plist"
PLIST_FILE='/Users/minipop2025/Library/LaunchAgents/com.minipop.agent-workbench.plist'
SERVICE_LABEL='com.minipop.agent-workbench'
SERVICE_DOMAIN="gui/$(id -u)"
SERVICE_URL='http://127.0.0.1:47832'

mkdir -p "$STATE_DIR" '/Users/minipop2025/Library/LaunchAgents'
cd "$APP_ROOT"
npm run build

launchctl bootout "$SERVICE_DOMAIN/$SERVICE_LABEL" >/dev/null 2>&1 || true
listener_pid="$(lsof -tiTCP:47832 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$listener_pid" ]]; then
  if ! curl -fsS "$SERVICE_URL/api/health" | grep -q '"sources"'; then
    echo "端口 47832 正被其他程序占用；未停止该程序。" >&2
    exit 1
  fi
  if [[ ! "$listener_pid" =~ '^[0-9]+$' ]]; then
    echo "无法安全识别占用端口 47832 的进程。" >&2
    exit 1
  fi
  kill -TERM "$listener_pid"
  for _ in {1..20}; do
    kill -0 "$listener_pid" >/dev/null 2>&1 || break
    sleep 0.1
  done
  if kill -0 "$listener_pid" >/dev/null 2>&1; then
    echo "无法停止旧的 Agent Workbench 进程（PID $listener_pid）。" >&2
    exit 1
  fi
fi
cp "$PLIST_SOURCE" "$PLIST_FILE"
launchctl bootstrap "$SERVICE_DOMAIN" "$PLIST_FILE"
launchctl kickstart -k "$SERVICE_DOMAIN/$SERVICE_LABEL"

for _ in {1..40}; do
  if curl -fsS "$SERVICE_URL/api/health" >/dev/null 2>&1; then
    echo "Agent Workbench 已启动：$SERVICE_URL"
    echo "关闭 Terminal 窗口不会停止服务。"
    exit 0
  fi
  sleep 0.25
done

echo "启动失败，请查看：$STATE_DIR/workbench.log" >&2
exit 1
