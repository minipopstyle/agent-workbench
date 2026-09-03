#!/bin/zsh
set -euo pipefail

DOMAIN="gui/$(id -u)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"

for label in com.agent-workbench.api com.agent-workbench.web; do
  launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
  rm -f "$LAUNCH_DIR/$label.plist"
done

echo 'Agent Workbench 前后端服务已停止。'
