#!/bin/zsh
set -euo pipefail

SERVICE_LABEL='com.minipop.agent-workbench'
SERVICE_DOMAIN="gui/$(id -u)"
PLIST_FILE='/Users/minipop2025/Library/LaunchAgents/com.minipop.agent-workbench.plist'

if launchctl print "$SERVICE_DOMAIN/$SERVICE_LABEL" >/dev/null 2>&1; then
  launchctl bootout "$SERVICE_DOMAIN/$SERVICE_LABEL"
  echo "Agent Workbench 已停止。"
else
  echo "Agent Workbench 当前未运行。"
fi

rm -f "$PLIST_FILE"
