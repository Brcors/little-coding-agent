# 用户问题解析 Agent · v0.3

日期：2026-11-01。当前版本是现有 coding agent 的前置需求模块，不训练新模型。

v0.5 补充：解析结果现在以结构化 `SemanticExecution` 交给执行器，按任务意图收紧权限，并在取得项目内容后动态开放后续 Function Calling 工具。实现与当前验证状态见 [语义到工具调用](semantic-function-calling.md)；下文的 40 项测试是 v0.3 当时的记录。

## 使用流程

访问 `http://127.0.0.1:4317/#analysis`，输入原始问题，点击“解析问题”。只分析需求时可不填项目目录。

模糊描述会产生关键问题；填写后点击“补充并更新解析”，检查目标、范围、约束和验收标准是否符合你的意图。选择项目并确认后，点击“确认并执行”。需要改动输入时重新解析。

从工作台新建任务时，也会先打开这一步。可以通过“解析演示需求 → 确认并执行”体验完整流程，无需密钥。

## 架构与职责

```text
原始问题
  → 需求解析 Agent
     ├─ LLM：Structured Outputs + Zod
     └─ 明确选择的规则模式
  → 结构化结果
     ├─ 存在关键问题 → 收集回答 → 更新解析版本
     └─ 需求已明确 → 用户审阅并确认
  → 运行程序检查版本与状态，生成执行任务说明
  → 现有 Coding Agent 的工具循环
  → 代码差异与实际检查结果 → 用户接受修改
```

这是串行分工的应用架构。解析模块组织需求，执行模块操作代码，后端维护两个阶段的记录和关联，不是并行多 Agent 调度系统。

解析 Agent 不注册文件或命令工具，也不在解析阶段读取项目。输出中的路径、实现判断与检查结果必须由后续执行阶段核对。确认需求不会自动接受代码修改。

## LLM 能力

采用官方 OpenAI SDK 的 `responses.parse` 与 `zodTextFormat`，使用 JSON Schema 约束输出结构。字段仍由后端 Zod 校验；Schema 合法不代表语义一定正确，结果仍需审阅。

该阶段使用自然语言理解、意图识别、信息提取、结构化输出和带澄清回答的再次分析。它不需要工具调用；原有 Coding Agent 继续通过 Function Calling 使用代码工具。每轮把原始问题与已收集回答一起传入，采用 `store:false`。

模型 ID 由 `.env` 的 `OPENAI_MODEL` 或工作台模型设置提供，需有 Structured Outputs 支持。每轮输出最多 4000 tokens，API 超时 60 秒，最多三轮补充，解析用量与执行用量分别记录。拒绝响应、不完整响应和无效结果都会报错，不伪装成功，也不自动降级。

官方参考：[Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs)。

## 结构化结果

- title、intent、goal：任务标题、类型和目标。
- scope、out_of_scope：处理与不处理的范围。
- constraints：用户明确表达的限制。
- acceptance_criteria：可观察、可判断的完成条件草案。
- assumptions：待核对的假设。
- questions：问题、提问原因、是否关键、建议选项。

问题 ID 和解析版本由运行程序分配。状态由是否存在关键问题计算，不接受模型额外声明的“可以执行”字段。用户补充保存在独立的回答记录中。

## 保存和交接

解析记录保存在本机数据目录 `analyses/<id>.json`，含原始问题、回答、版本、来源、模型、用量及关联任务 ID。工作台可以查看最近 30 条解析。

确认执行时，后端检查解析版本、关键问题和重复创建状态，使用服务器保存的内容生成任务说明，并在任务目录保存 `analysis.json`。任务的 `original_goal` 用于显示原始问题，`goal` 包含完整结构化说明。

接口：

```text
POST /api/analyses                  创建解析
GET  /api/analyses                  最近解析
GET  /api/analyses/:id              解析详情
POST /api/analyses/:id/refine       提交当前版本的问题回答
POST /api/tasks                    携带 analysis_id / analysis_revision 确认执行
```

这些接口沿用工作台会话、CSRF 和 Origin / Host 校验。停止解析会取消浏览器请求并向模型调用传递取消信号，旧结果保留。

## 验证与限制

40 项自动测试全部通过，覆盖原有功能和新增的结构化校验、澄清、版本冲突、关键问题阻止执行、重复交接、问题伪造、拒绝响应及官方 SDK 的模拟 HTTP 协议。

实际 Chrome 验证：模糊问题提问、补充回答、解析更新、刷新恢复、演示确认后执行，以及 390px 窄屏布局。浏览器没有页面运行错误，窄屏没有页面横向溢出。

真实模型密钥尚未配置，故未测量真实模型的语义解析准确率。规则模式只用于基础整理与流程体验，不具备与 LLM 相同的理解能力。Docker 实机验证仍需安装 Docker 后进行。

主要代码：`src/analysis.ts`、`src/analysis-types.ts`、`web/analysis-panel.tsx`；接口位于 `src/server.ts`。
