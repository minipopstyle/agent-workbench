import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const jobs = [
  { name: '本地 API', args: ['run', 'server'] },
  { name: 'Web 界面', args: ['run', 'dev', '--', '--host', '127.0.0.1', '--strictPort'] },
]
let stopping = false
const children = jobs.map(({ name, args }) => {
  const child = spawn(npm, args, { cwd: root, stdio: 'inherit' })
  child.once('error', error => { console.error(`${name} 无法启动：${error.message}`); stop(1) })
  child.once('exit', code => { if (!stopping) { console.error(`${name} 已退出${code == null ? '' : `（${code}）`}`); stop(code || 1) } })
  return child
})

function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) if (child.exitCode == null) child.kill('SIGTERM')
  setTimeout(() => process.exit(code), 1_000).unref()
}

console.log('已启动本地 API（127.0.0.1:47832）和 Web 界面（http://localhost:5173）。按 Ctrl+C 停止两者。')
process.once('SIGINT', () => stop())
process.once('SIGTERM', () => stop())
