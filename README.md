# Agent Workbench

本地优先的 Agent Session 分析工作台：把 Codex、Claude、WorkBuddy 与导入的 JSONL/Zstd 会话整理成可比较的 Turn/Run，并在浏览器中查看执行轨迹、证据和报告。

不会读取 Codex 页面、连接 CDP、开启注入，也不会默认把原始会话日志传到外部服务。

## 功能

- 只读发现本机 Codex、Claude、WorkBuddy 会话；支持导入 JSONL 与 Zstd 压缩日志。
- 按任务与 Turn 分析模型、Token、工具调用、失败恢复、上下文压力和执行耗时。
- 在同任务、可确认变量的前提下比较两次运行，并生成可离线打开的脱敏 HTML 报告。
- 提供确定性证据评分、手动评分，以及必须先预览并确认的 OpenAI 兼容 Judge。
- 本地状态只保存任务绑定和评分记录；导入日志驻留内存，不写回原始会话文件。

## 快速开始

需要 Node.js 22.15 或更高版本（用于原生 Zstd 解压）。

```bash
npm ci
npm run server
# 在另一终端
npm run dev
```

打开 `http://localhost:5173`。本地 API 默认监听 `http://127.0.0.1:47832`，可通过 `AGENT_WORKBENCH_PORT` 修改端口。

## 常用命令

```bash
npm test       # 单元与导入回归测试
npm run build  # TypeScript 检查与生产构建
npm run lint   # 静态检查
```

## 隐私与可选 Judge

所有会话分析默认在本机完成。Judge 仅在界面中显示脱敏预览、并由用户明确确认后才会调用外部 OpenAI 兼容接口。

如需启用 Judge，启动服务前设置：

```bash
export AGENT_WORKBENCH_JUDGE_BASE_URL="https://example.com/v1"
export AGENT_WORKBENCH_JUDGE_API_KEY="..."
export AGENT_WORKBENCH_JUDGE_MODEL="..."
```

预览与报告会移除本机路径、URL、常见凭证字段，以及 OpenAI、GitHub、Slack、AWS、Google、Hugging Face 与 GitLab 等令牌格式。仍请在分享前检查内容是否符合你的数据处理要求。

## 项目结构

- `src/`：React 界面与可视化。
- `server/`：本地 API、会话适配器、比较、评分与报告生成。
- `tests/`：导入、分析、比较、评分与状态持久化回归测试。
- `public/legacy-v2/`：保留的离线 V2 轨迹视图。

## 开发边界

本项目面向本地个人分析，不是托管遥测平台；源日志保持只读，外部 Judge 是可选功能。
