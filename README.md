# Little Coding Agent

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

本地 coding agent 工作台：输入任务 → 搜索与读取项目 → 修改任务副本 → 运行检查 → 查看差异 → 用户决定是否接受。

当前版本为 **v0.5：语义理解 → 动态 Function Calling + 浏览器工作台 + CLI**。需求解析与工具执行已串联，具备真实 OpenAI Responses API 接入、结构化需求交接、统一工具协议和无需密钥的演示；各模式在界面和报告中明确区分。

## 打开前端工作台

```powershell
git clone https://github.com/Brcors/little-coding-agent.git
cd little-coding-agent
npm ci
npm run ui
```

需要 Node.js 24 或更新的兼容版本及 npm。`npm run ui` 会构建前端并启动本地服务。启动后，在浏览器访问 [工作台](http://127.0.0.1:4317)。在终端按 Ctrl+C 停止服务；端口可用 `CODING_AGENT_PORT` 配置。

工作台包含：

- 左侧任务列表、搜索与历史记录。
- 新建任务：选择演示或真实项目，通过文件夹浏览器选择目录，输入目标和检查方式。
- 实际执行记录：通过 SSE 实时更新，支持停止当前任务。
- 差异审阅：查看新增、删除和修改行，接受或丢弃本次改动。
- 检查记录：分别查看失败与通过的每次日志，下载 Markdown 任务报告。
- 连接设置：显示本地模型配置状态；不在网页中收集或存储 API Key。
- 窄屏布局：任务列表折叠，结果区移到任务下方。

没有 API Key 时，点击 **解析演示需求**，审阅后点击 **确认并执行**，即可体验完整流程。处理真实项目时，先配置下文的 `.env` 并重新启动服务。真实项目只开放 Docker 检查或禁用执行；宿主执行仅用于内置演示，CLI 中的 trusted 模式仍需显式选择。

## 用户问题解析 Agent

打开左侧 **问题解析**，或直接访问 [解析页面](http://127.0.0.1:4317/#analysis)。可以独立解析一条需求，暂时不选择项目。

解析结果包含任务类型、目标、处理范围、范围之外、用户约束、验收标准、假设和澄清问题。模糊需求先补充回答，最多三轮；确认后再交给 Coding Agent，原始描述与补充回答不会丢失。解析记录支持历史查看和刷新恢复。

- **LLM 解析**：使用 Responses API 的 Structured Outputs，固定 JSON Schema + Zod 校验，处理自然语言及澄清上下文。需要本地密钥和支持结构化输出的模型。
- **规则解析**：无需密钥，使用简单关键词和歧义规则；界面明确标注未使用 LLM，分类和验收草案需要人工审阅。模型请求失败时不会静默切换为规则模式。
- **演示**：只针对固定购物车需求生成规则解析，再运行已有固定演示。

解析阶段不读取、修改或运行项目代码，不具备文件工具或命令工具。未解决关键问题、解析版本过期或已经创建过任务时，不能通过同一解析再次创建执行任务。修改输入后，需要重新解析再确认。CLI 的 `run` 命令保持原有直接执行方式。

源码与验证细节见 [需求解析 Agent 说明](docs/analysis-agent.md)。

## 理解语义后调用工具

真实工作流程为：**LLM 解析自然语言 → 审阅目标与澄清回答 → 执行模型读取项目 → 动态选择工具 → 观察结果并继续 → 审阅差异**。

这不是把“修复”两个字映射成某个固定函数。解析器输出目标、范围、约束和验收标准，执行模型再结合实际代码决定调用哪个工具以及填什么参数。任务类型只用于收紧权限：解释、审查任务自动只读；修复、新增任务可以修改副本，但不能覆盖项目本身的只读设置。

执行阶段首先只提供读取与证据工具，设置 `tool_choice: required`。取得文件内容或文本匹配后，下一轮才开放允许的修改工具；空项目可以通过根目录为空的证据开始新增。连续两次未取得内容证据就声称完成时，运行程序会停止任务。它不能保证模型理解正确，因此仍保留检查和人工审阅。

工作台增加了“理解后如何执行”预览、“理解语义后的执行”状态卡和“模型选择工具”记录。工具参数、返回值与错误可以在“工具记录”中查看，解析用量与执行用量分别保存。界面不显示隐藏思维链。

本地配置 `.env`、重启 `npm run ui` 后，选择真实项目及 **LLM 解析**，输入具体问题，审阅后点击 **确认并执行**。使用的模型需要同时支持 Structured Outputs 和 Function Calling。没有凭据时可以体验规则解析和固定演示，这两者不会被标记为真实 LLM 语义决策。

实现、验证边界及源码索引见 [语义到工具调用说明](docs/semantic-function-calling.md)。

## 工具层

打开左侧 **工具层**，或访问 [工具目录](http://127.0.0.1:4317/#tools)，可以查看 10 个工具的输入格式、作用和权限。点击 **运行工具演示**，会新建专用练习项目，实际调用全部工具，不需要密钥。进入任务的 **工具记录** 标签，可逐次查看已脱敏的输入、输出、耗时和错误原因。

现有 7 个工具已迁入统一注册表，新增：

- `apply_patch`：结构化多文件批次，支持新建、更新与删除，校验所有文件版本后才开始应用。
- `restore_files`：在任务副本内恢复指定文件到任务基线，新建文件会被移除。
- `read_tool_output`：分段补读本任务已记录的长结果。

执行流程统一为“注册查找 → 参数校验 → 权限判断 → 串行执行 → 结果脱敏与限长 → 记录 → 返回模型”。同一模型调用 ID 不会再次产生工具副作用。多文件操作中途失败或取消时尝试恢复本批次；遇到并发修改会保留新内容并报告恢复冲突，不承诺进程崩溃时的跨文件原子提交。

需要只读任务时，可在目标项目 `.coding-agent.json` 中设置 `"tool_policy": "read_only"`，或使用 CLI：

```powershell
npm run agent -- run --project "examples/cart" --task "解释总价函数的边界条件" --read-only
```

只读任务只得到读取与证据工具，即使模型伪造写入 / 执行调用也会被拒绝。默认 `workspace` 允许修改任务副本与执行预配置检查，仍不能自动接受修改或运行任意 shell。完整设计和验证见 [工具层说明](docs/tool-layer.md)。

本地后端仅监听 `127.0.0.1`，使用 HttpOnly / SameSite 会话 cookie、CSRF token 和 Origin / Host 校验。它提供本机文件操作能力，不作为公网网站部署。

## 现在就可以试

在项目根目录打开 PowerShell：

```powershell
npm ci
npm run demo
```

已经安装过依赖时，可以直接执行 `npm run demo`。

演示会新建一个专用购物车练习项目，实际执行失败测试，应用修复，再运行测试。**演示使用固定脚本代替 LLM**，不需要密钥，不会访问真实模型；只在宿主运行程序自带的练习测试。每次演示生成独立任务，修改仍需接受后才写回该练习项目。

查看运行环境：

```powershell
npm run doctor
```

需要 Node.js 24 或更新的兼容版本。`doctor` 不会消耗模型额度，也不会打印 API Key。

## 接入真实模型

1. 将 `.env.example` 复制为项目根目录的 `.env`。
2. 在编辑器中填入 `OPENAI_API_KEY` 和账户可用、支持 Structured Outputs 与 Function Calling 的 `OPENAI_MODEL`。
3. `.env` 已加入 Git 忽略规则，不要将密钥发送到聊天中。

`.env` 的内容格式：

```dotenv
OPENAI_API_KEY=在本机填入你的密钥
OPENAI_MODEL=在本机填入可用模型ID
```

先用示例运行：

```powershell
# 不运行项目代码，能读取、修改并生成差异，结果标记为未验证：
npm run agent -- run --project "examples/cart" --task "修复空购物车总价错误，保留现有测试" --execution disabled
```

也可以在安装并启动 Docker、准备镜像后运行检查：

```powershell
docker pull node:24-alpine
npm run agent -- run --project "examples/cart" --task "修复空购物车总价错误，保留现有测试"
```

默认 `--execution docker`。代码片段会通过 API 发送给你所配置的模型。镜像只在准备步骤下载，检查期间不联网、不自动拉取镜像。缺少 Docker、镜像或项目依赖时，检查不能视为通过。

## 查看、接受、丢弃

运行结束会输出任务 ID、状态、验证结果、差异和报告路径。将下面的 `任务ID` 替换为实际输出值：

```powershell
npm run agent -- tasks
npm run agent -- show 任务ID
npm run agent -- accept 任务ID
npm run agent -- discard 任务ID
```

- `show`：显示任务副本与基线的差异。
- `accept`：先检查所有待写文件是否仍与原始版本一致，再写回；有冲突时停止，保留原内容供手工合并。请避免同时编辑接受中的文件。
- `discard`：标记丢弃，不覆盖源项目；副本与证据继续保留。已接受的任务不能用它撤销。
- 失败、取消或预算耗尽时，已有差异仍可审阅并选择接受；查看验证状态后再决定。

默认任务记录放在本机应用数据目录 `LittleCodingAgent/tasks/<id>`，位于项目和 OneDrive 之外。可通过 `.env` 中的 `CODING_AGENT_DATA_DIR` 指定其他外部目录。

每个任务包含 `task.json`、`baseline.json`、`events.jsonl`、`diff.patch`、`report.md`、检查日志和 `workspace/` 项目副本。每次检查保存独立日志，事件中保留结果与日志引用，失败证据不会被后续通过结果覆盖。不会递归清理任务记录。

## 为自己的项目配置检查

在目标项目根目录创建 `.coding-agent.json`：

```json
{
  "checks": {
    "test": {
      "command": "node",
      "args": ["--test", "cart.test.mjs"],
      "timeout_ms": 10000
    }
  },
  "docker_image": "node:24-alpine"
}
```

这是用户提供的检查配置，模型不能修改它。首版不安装依赖；运行其他项目时需要预先准备匹配的执行镜像。Docker 模式只读挂载任务源码，写文件的构建、Windows 专属程序和依赖安装暂未适配。未配置检查时结果为 `unverified`。

对你自己编写并完全信任的练习项目，可以显式选择宿主执行：

```powershell
npm run agent -- run --project "examples/cart" --task "修复空购物车" --execution trusted
```

`trusted` **不是沙箱**：项目检查中的代码拥有当前用户的宿主权限，可能访问工作区之外的文件和网络。程序只移除大部分继承环境变量，不能限制这些系统权限。真实项目默认使用 Docker；也可以使用 `disabled` 只生成修改。

## 用到的技术和架构

- **语言与运行时**：TypeScript + Node.js。
- **模型协议**：官方 `openai` SDK + Responses API。
- **参数定义与校验**：Zod 定义严格 schema，生成工具 JSON Schema；执行端再次校验。
- **差异**：`diff` 库生成统一格式 patch，包含新增文件。
- **记录**：本地 JSON / JSONL 文件；本版没有 SQLite 或重启续跑。
- **验证**：Node 内置测试框架 + tsx；TypeScript 做静态检查。
- **执行**：Docker 或显式选择的宿主检查；通过进程接口传递参数，不使用 shell 字符串拼接。

Agent 使用 **串行的需求解析与执行两个阶段 + ReAct 风格的执行工具循环 + 应用端状态管理**：解析器整理目标，执行模型基于已有观察选择动作，应用执行动作，把新观察返回模型。没有展示或记录隐藏思维链。

```text
工作台：需求解析（Structured Outputs）→ 用户确认 → 结构化语义与权限交接
CLI：直接执行任务描述
                         ↓
Agent runtime：状态、预算、取消、内容证据、最终检查
 ├─ Provider：OpenAI Responses API / 固定演示驱动
 ├─ Tools：参数校验、路径边界、代码版本校验
 │   ├─ 文件列表、按行读取、文本搜索
 │   ├─ 局部替换、新建文件、查看差异
 │   └─ 预配置检查 → Docker / trusted 执行器
 └─ Task store：副本、基线、事件、日志、报告

循环：模型 → 工具调用 → 校验与执行 → 工具结果 → 模型
交付：完整差异 + 实际检查证据 → 用户接受
```

对应源码：

- `src/agent.ts`：循环、预算、取消和验证状态。
- `src/provider.ts`：模型 API 适配、历史响应项续接。
- `src/semantic.ts`：结构化语义交接、权限交集与执行输入。
- `src/tools.ts`：统一工具路由、权限、去重、串行执行、审计和返回限长。
- `src/toolkit/`：10 个工具的注册表、schema、实现、批次修改与审计读取。
- `src/files.ts`：文件范围、文本与大小限制。
- `src/workspace.ts`：项目快照、差异、接受冲突检测。
- `src/executor.ts`：进程、超时、取消和容器生命周期。
- `src/demo.ts`：固定演示驱动，明确不使用 LLM。
- `src/cli.ts`：命令行与本地环境配置。

### LLM 的能力具体用在哪里

1. **自然语言理解与 Structured Outputs**：从原始问题和澄清回答提取目标、范围和完成标准，用严格 JSON Schema 输出，再交给执行模型。
2. **代码理解与生成**：理解工具返回的代码，生成局部替换内容或新文件。
3. **Function Calling**：模型输出结构化工具名、参数和调用 ID；应用执行并回传对应 `function_call_output`。
4. **多轮上下文**：保留完整可续接响应项和工具结果，每次请求继续提供任务约束。`store:false`，并请求、原样回传加密 reasoning 项；程序不解密或展示它们。此配置本身不构成服务商 ZDR 保证。
5. **依据反馈迭代**：检查失败后，将真实结果反馈给模型继续修复。

本版没有模型训练、多 Agent、向量检索、MCP、自动上下文压缩或长期语义记忆。当前代码检索是普通文件和文本搜索；上下文超预算时停止。

参考：[OpenAI Docs：Function calling](https://developers.openai.com/api/docs/guides/function-calling)、[Responses API 迁移和状态管理](https://developers.openai.com/api/docs/guides/migrate-to-responses)。

## 验证状态如何判断

- `passed`：所有配置检查在当前代码版本上实际通过。
- `failed`：当前版本至少一项检查失败、超时或取消。
- `unverified`：检查未配置、不可用、禁用或结果对应旧版本。

模型声称完成时，运行程序会为变更补跑遗漏的检查；失败会反馈模型继续修复。检查如果修改了源码，其自身结果不被视为修改后版本的证据。普通单元测试通过只证明所运行的检查通过，不是对全部功能正确性的保证。

## 预算与停止

```powershell
npm run agent -- run --project "examples/cart" --task "修复空购物车" --execution disabled --max-turns 12 --max-tokens 80000 --max-output-tokens 4000 --timeout-seconds 300
```

默认 20 轮、10 分钟、累计输入输出 100000 tokens，每轮输出最多 4000 tokens。请求前用输入字节数加输出上限进行保守预估，请求后记录 API 返回的真实用量。这是应用端限制，不是精确的服务商账单硬上限，也没有按货币计费。SDK 的网络重试可能产生额外请求。

按 Ctrl+C 取消模型请求和检查进程。关闭进程后可以查看历史，但本版不支持自动恢复执行，避免重复写入。

## 验证与构建

```powershell
npm run typecheck
npm test
npm run build
node dist/cli.js --help
```

自动测试覆盖真正的练习测试执行、工具边界、秘密文件排除、中文与空格路径、junction 越界、过期修改、接受冲突、取消、超时、预算、重复调用，以及官方 SDK 的完整“需求解析 → 语义交接 → 工具调用 → 返回结果”本地 HTTP 协议。新增用例验证解释任务只读、先读取后修改、无证据不交付和项目权限不能被放宽。

本地 HTTP 测试使用模拟服务验证协议，**不代表已经测过真实 LLM 的任务成功率**。真实模型联调需要本地配置 API 凭据；Docker 执行也需要在有 Docker 的机器上验证。

首版限制：最多 500 个允许的文本文件、合计 10 MiB，单文件 256 KiB。常见敏感路径和部分密钥模式会被过滤，但不是覆盖所有秘密的检测器。隔离效果取决于正确的容器与宿主配置，不将此原型作为处理恶意代码的安全产品。

前端采用 React、Vite 和 Lucide 图标，后端采用 Node.js 原生 HTTP 服务及 SSE；它直接复用 `src/agent.ts`，没有另外模拟 Agent 逻辑。`web/main.tsx`、`web/styles.css` 是界面，`src/server.ts` 是工作台接口。

后续根据真实任务失败数据优化检索、恢复、对话续接和检查环境。

## 文档与开源

- [当前语义与工具调用实现](docs/semantic-function-calling.md)
- [工具层](docs/tool-layer.md)
- [需求解析 Agent](docs/analysis-agent.md)
- [小白版设计方案](docs/coding-agent-beginner-guide.md)与[完整技术方案](docs/coding-agent-technical-plan.md)：包含尚未实施的规划，以当前实现说明为准。
- [参与开发](CONTRIBUTING.md)

相关项目：[MonoPlanner](https://github.com/plasticmemories-0823/MonoPlanner)。本项目采用独立的 TypeScript 实现，当前功能和验证范围见上文。

本项目源码采用 [MIT 许可证](LICENSE)。依赖项按各自许可证提供。
