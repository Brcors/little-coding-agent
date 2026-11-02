# 工具层 · v0.4

v0.5 的语义交接、本轮可用工具校验与最新验证状态见 [语义到工具调用](semantic-function-calling.md)。下文的 55 项测试是 v0.4 当时的记录。

日期：2026-11-02。基于原型已有 7 个基础工具重构，不改变“先修改任务副本、用户审阅后写回”的流程。

## 使用

打开 `http://127.0.0.1:4317/#tools`，查看工具目录，点击“运行工具演示”。它会在新建的购物车练习项目中实际调用全部 10 个工具，生成 11 条调用记录：读取工具使用两次，其他各一次。

任务右侧的“工具记录”可以查看每次调用的名称、来源、耗时、输入和输出。记录只供查看，没有从网页任意调用工具或 shell 的接口。演示不调用 LLM；真实文件修改与 Node 检查会执行。

## 架构

```text
需求解析 → 用户确认 → Coding Agent
                        ↓ Function Calling
工具注册表 → 参数校验 → 权限判断 → 调用去重 → 同任务串行执行
                        ↓
         文件工具 / 批次编辑 / 检查执行器 / 证据工具
                        ↓
        脱敏结果 + 调用 ID + 耗时 + 错误码 + 记录引用
                        ↓
           回传模型；完整记录供工作台审阅和分段补读
```

模型负责选择已声明的工具和参数，程序负责执行。JSON Schema 与后端 Zod 校验来自同一份工具定义；工作台目录也由该注册表生成。无需训练新模型或新增 Agent 框架。

## 工具清单

- list_files：列出允许的任务文件。
- read_file：带行号读取 UTF-8 文件，返回完整内容版本 hash；每次最多 200 行。
- search_text：字面关键词搜索，最多 40 条匹配，截断后可缩小查询范围。
- replace_text：凭当前 hash 替换唯一匹配的片段。
- create_file：新建文本文件，不覆盖已有内容。
- apply_patch：结构化多文件新建、更新、删除；一批最多 20 个文件。
- restore_files：凭当前 hash 恢复指定副本文件至任务基线。
- run_check：执行预配置检查，返回真实状态、退出码和日志。
- inspect_diff：生成包含新增与删除文件的差异，并保存 diff.patch。
- read_tool_output：按调用 ID 补读当前任务中已完成调用的 JSON 结果。

apply_patch 是自有结构化工具，不是直接提交 unified diff。每条 change 使用 path、expected_sha256、content：新文件 hash 为 null；已有文件使用 read_file 返回的 hash；content=null 表示删除。

示例参数（在任务副本内新建两个文件）：

```json
{
  "changes": [
    { "path": "src/a.ts", "expected_sha256": null, "content": "export const a = 1;\n" },
    { "path": "src/b.ts", "expected_sha256": null, "content": "export const b = 2;\n" }
  ]
}
```

## 权限和文件边界

workspace 为默认权限，允许读取、修改任务副本、执行用户配置检查；read_only 只允许读取和查看证据。读取与调用审计会写系统记录文件，不修改项目代码。

只读权限可以来自项目配置或 CLI 的 --read-only。模型拿到的声明会过滤掉无权工具，执行端再次校验；未知权限值不会获得工具访问权。模型参数不能切换 task_id 或 workspace。

原有路径边界继续生效：相对路径、真实路径、symlink / Windows junction、敏感文件过滤、UTF-8 文本和大小限制。新增批次会检查操作后是否超过 500 个文件、10 MiB 总量及单文件 256 KiB 的限制。配置文件和 Git 元数据不能通过编辑工具修改。

run_check 仍只接受检查名称，使用已有 Docker / trusted / disabled 执行器。默认真实项目使用 Docker；trusted 是显式宿主执行，不能称为沙箱。单条检查超时和任务取消继续生效。

## 批次与并发语义

先准备并检查全部路径、内容、hash、重复文件和大小限制，任一前置条件失败则不写入。应用时每个文件使用临时文件替换，替换前再次检查版本。同一任务的工具调用在本进程内排队执行。

中途失败或取消时，逆序恢复本批次已写入的文件；如果文件已出现其他编辑，保留新内容并报告 ROLLBACK_CONFLICT。恢复也有版本检查，不会无条件覆盖。成功变更增加 revision 并使旧验证失效。

Windows 短暂文件锁会触发有限的替换重试。文本替换在每次重试前核对目标内容，记录文件使用唯一临时文件。重试文件替换不会重新执行检查或模型动作。

这些是进程内的批次语义，不是数据库式跨文件事务；系统崩溃、多个进程同时改同一任务时，不承诺完整原子性或自动恢复。未知结果不会自动重放。

## 返回与调用记录

保留原有 ok / data / error 协议，增加：

- meta.call_id：本机生成的记录 ID，工具结果补读使用它。
- meta.provider_call_id：模型原来的调用 ID，用于对应和去重。
- meta.duration_ms、revision：执行耗时和副本版本。
- error.code、message、retryable：结构化错误；过期内容要求先重新读取，不能盲目重复写入。
- truncated、artifact_ref：返回是否限长以及本任务记录引用。

每次调用先保存执行意图，再执行并保存结果，成功、失败、无效参数和拒绝调用都留有记录。记录位于任务目录 tool-calls/<id>.json；模型调用 ID 的标记跨 Tools 实例保留，防止同一调用再次产生副作用。这不是崩溃后自动续跑功能。

原始内容中的常见密钥模式、秘密字段和检查输出会脱敏，但不声称能检测所有秘密。默认返回在超过 16000 个序列化字符时改成短预览；完整已脱敏数据保留在调用记录。read_tool_output 每段最多 6000 个 UTF-16 字符位置，返回下一位置；不允许读取其他任务。

进程执行器自身只保留最后 24000 个字符的输出，并标记 truncated。补读工具可以补齐工具层记录的完整 JSON，不能恢复上游已经截掉的进程输出。

调用成功与检查通过是两个概念：run_check 正常返回 failed 时，工具调用本身可以成功，检查仍然失败。工作台分别显示这些状态。

## 源码与接口

- src/tools.ts：统一调度与模型结果封装。
- src/toolkit/contracts.ts、registry.ts：协议、注册、目录与模型声明。
- file-tools.ts、edit-tools.ts、check-tools.ts、evidence-tools.ts：各类工具。
- patches.ts：批次编辑与恢复。
- audit.ts：记录、脱敏与读取。
- demo.ts：固定工具演示驱动。
- web/tool-panels.tsx：工具目录与调用详情。

```text
GET /api/tools
GET /api/tasks/:id/tool-calls/:call_id?offset=0
POST /api/tasks  { "mode": "tools_demo" }
```

接口沿用工作台会话、CSRF 和 Origin / Host 校验；任务详情包含调用元数据，不在每次实时更新中传回完整大结果。

## 验证

55 项自动测试通过，前后端类型检查和生产构建通过。新增覆盖整批前置校验、新建更新删除与恢复、注入的中途写入失败、取消、保留并发编辑、只读及未知权限、重复调用 ID、串行过期修改、长结果分段读取与跨任务拒绝、脱敏、字节限制，以及工作台接口。

Chrome 浏览器已验证工具目录、固定工具演示、逐调用输入输出、任务丢弃和 390px 窄屏布局；没有页面运行错误。真实 LLM 的新工具选择效果和 Docker 实机执行仍待本地配置后验证。
