#!/bin/zsh
set -euo pipefail

APP_ROOT="${0:A:h}"
DOMAIN="gui/$(id -u)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/.agent-workbench"
API_LABEL='com.agent-workbench.api'
WEB_LABEL='com.agent-workbench.web'
API_PLIST="$LAUNCH_DIR/$API_LABEL.plist"
WEB_PLIST="$LAUNCH_DIR/$WEB_LABEL.plist"
NODE_BIN="$(command -v node || true)"

if [[ -z "$NODE_BIN" || ! -d "$APP_ROOT/node_modules" ]]; then
  echo '未找到 Node.js 或 node_modules。请先在项目目录运行 npm ci。' >&2
  exit 1
fi

mkdir -p "$LAUNCH_DIR" "$LOG_DIR"
launchctl bootout "$DOMAIN/$API_LABEL" >/dev/null 2>&1 || true
launchctl bootout "$DOMAIN/$WEB_LABEL" >/dev/null 2>&1 || true

for port in 47832 5173; do
  if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "端口 $port 已被占用。请先关闭旧版服务或正在运行的 npm run start。" >&2
    exit 1
  fi
done

xml() { print -r -- "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"; }
write_plist() {
  local plist="$1" label="$2" log="$3"; shift 3
  {
    print '<?xml version="1.0" encoding="UTF-8"?>'
    print '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    print '<plist version="1.0"><dict>'
    print "<key>Label</key><string>$(xml "$label")</string>"
    print '<key>ProgramArguments</key><array>'
    for arg in "$@"; do print "<string>$(xml "$arg")</string>"; done
    print '</array>'
    print "<key>WorkingDirectory</key><string>$(xml "$APP_ROOT")</string>"
    print '<key>KeepAlive</key><true/><key>RunAtLoad</key><true/><key>ThrottleInterval</key><integer>5</integer>'
    print "<key>StandardOutPath</key><string>$(xml "$log")</string>"
    print "<key>StandardErrorPath</key><string>$(xml "$log")</string>"
    print '</dict></plist>'
  } > "$plist"
}

write_plist "$API_PLIST" "$API_LABEL" "$LOG_DIR/api.log" "$NODE_BIN" '--import' 'tsx' 'server/index.ts'
write_plist "$WEB_PLIST" "$WEB_LABEL" "$LOG_DIR/web.log" "$NODE_BIN" "$APP_ROOT/node_modules/vite/bin/vite.js" '--host' '127.0.0.1' '--port' '5173' '--strictPort'
launchctl bootstrap "$DOMAIN" "$API_PLIST"
launchctl bootstrap "$DOMAIN" "$WEB_PLIST"

for _ in {1..40}; do
  curl -fsS http://127.0.0.1:47832/api/health >/dev/null 2>&1 && curl -fsS http://127.0.0.1:5173/ >/dev/null 2>&1 && {
    echo 'Agent Workbench 已启动： http://localhost:5173'
    echo '服务由 macOS 常驻管理；关闭此窗口不会停止服务。'
    exit 0
  }
  sleep 0.25
done

echo "启动失败，请查看 $LOG_DIR/api.log 和 $LOG_DIR/web.log" >&2
exit 1
