# v0.1 实施与验证记录

日期：2026-11-01。对应当前工作区实现；此前技术方案中的长期目标不代表本版已实现。

本文件保留 v0.1 的交付范围。前端工作台已在后续 v0.2 完成，最新 v0.5 状态见 [语义与工具调用实现](semantic-function-calling.md)。下文的能力与验证状态仅对应 v0.1。

## 已交付

- 可运行的 TypeScript / Node.js CLI：demo、doctor、run、tasks、show、accept、discard。
- 官方 OpenAI SDK / Responses API 适配；严格工具 schema、多轮工具调用及结果续接。
- 单 Agent 工具循环、轮数 / 用量 / 时间预算、取消与真实检查结果判定。
- 7 个工具：列文件、读取、文本搜索、局部替换、新建文件、运行预配置检查、查看差异。
- 独立项目副本、原始内容基线、原子文件替换、接受时的冲突检查。
- 任务记录、完整差异、报告和每次检查的独立日志。
- Docker 检查执行路径、显式 trusted 宿主模式和 disabled 模式。
- 固定购物车演示、示例项目和中文使用说明。

## 实际验证

- `npm run typecheck`：通过。
- `npm test`：24 项通过，0 失败。
- `npm run build`：通过。
- `node dist/cli.js --help`：编译后入口可运行。
- `npm run demo` / 编译后 `demo`：实际出现初始测试失败，修改后两个购物车测试通过，交付差异；原练习项目等待接受。
- 官方 SDK + 本地模拟 HTTP API：验证完整工具参数、call_id 对应、历史响应与加密 reasoning 项回传、实际用量累计及遗漏检查自动补跑。没有请求真实模型。

演示结束后会显示当前任务 ID，可使用 `npm run agent -- show 任务ID` 查看本机保存的差异与证据。

## 当前验证边界

- 用户选择稍后配置凭据；本机尚未配置 API Key / 模型 ID，因此真实 LLM 联调和任务成功率尚未验证。
- 本机未安装 Docker，因此容器执行分支尚未做实机验证；进程与演示在 Windows trusted 模式测试。
- 尚未实现网页 / 桌面界面、依赖自动安装、SQLite、自动上下文压缩、恢复执行、多 Agent 或 MCP。
- 任务完成率没有模型实测数据，不声称达到原设计中的目标。

使用、架构及 LLM 能力说明见 [README](../README.md)。
