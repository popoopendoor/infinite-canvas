# 后端目录结构

> `canvas-agent` 包的当前后端布局。

## 概述

`canvas-agent` 是一个小型 TypeScript Node 包。 其入口点 `canvas-agent/src/index.ts` 会启动本地 Express HTTP 服务器（在 `canvas-agent/src/server/http.ts`）或 MCP 标准 I/O 服务器（在 `canvas-agent/src/server/mcp.ts`）。 领域代码按其拥有的能力进行分组；当前包中没有单独的 `routes/`、`controllers/` 或 `services/` 层。

## 目录结构

```text
canvas-agent/
├── canvas-agent/src/index.ts                 # 处理入口点
├── canvas-agent/src/server/http.ts           # Express 应用，中间件，HTTP 路由
├── canvas-agent/src/server/mcp.ts            # MCP 服务器和工具注册
├── canvas-agent/src/agent/                   # Codex/Claude 客户端，协议，历史
├── canvas-agent/src/canvas/                  # 画布会话，操作，模式
├── canvas-agent/src/skills/                  # 技能存储和技能验证
├── canvas-agent/src/utils/                   # 通用的实用工具，如日志记录
└── canvas-agent/src/*.test.ts                # 除了覆盖的模块之外的单元测试
```

示例包括 `canvas-agent/src/server/http.ts`、`canvas-agent/src/server/mcp.ts`、`canvas-agent/src/canvas/operations.ts` 和 `canvas-agent/src/skills/store.ts`。

## 模块组织
- 将进程启动放在 `canvas-agent/src/index.ts` 中。 它仅根据命令行参数选择 `startMcpServer()` 或 `startHttpServer()`。
- 直接在 `canvas-agent/src/server/http.ts` 中定义 Express 中间件和 HTTP 端点。 此文件目前包含 CORS、令牌授权、响应封装以及终端错误处理程序。
- 在 `canvas-agent/src/server/mcp.ts` 中定义 MCP 工具注册和 HTTP 转发适配器。 工具名称和 Zod 输入模式属于 `canvas-agent/src/canvas/schemas.ts`。
- 使用其领域保持能力特定的行为：Codex 的行为在 `canvas-agent/src/agent/` 中，画布的转换在 `canvas-agent/src/canvas/` 中，技能持久化/验证在 `canvas-agent/src/skills/` 中。
- 仅当代码确实被共享时，才将可重用的跨越性代码放在 `canvas-agent/src/utils/` 中。 `canvas-agent/src/utils/logger.ts` 中的日志记录器是当前示例。
- 使用与要测试的模块相同的名称（例如 `canvas-agent/src/config.test.ts`、`canvas-agent/src/canvas/operations.test.ts` 和 `canvas-agent/src/skills/store.test.ts`），添加测试，如所示。

不要为了将一个小的函数从其所属的模块中移动而创建通用的服务或控制器目录；当前的 HTTP 边界仍然在 `canvas-agent/src/server/http.ts` 中。

## 命名
使用 kebab-case 文件名，例如 `canvas-agent/src/agent/codex-client.ts`、`canvas-agent/src/agent/message-metadata.ts` 和 `canvas-agent/src/utils/agent-runtime.test.ts`。 使用 PascalCase 表示类（如 `canvas-agent/src/utils/logger.ts` 中的 `Logger` 和 `canvas-agent/src/skills/store.ts` 中的 `SkillStore`），使用 camelCase 表示函数和值，并明确指定导出的 TypeScript 类型。

## 路由示例
```ts
app.get("/agent/codex/models", route(async (_req, res) =>
    res.json({ ok: true, ...(await listCodexModels(emit)) }),
));
```
该路由在 `canvas-agent/src/server/http.ts` 中声明，其领域操作仍然在 `src/agent/codex.ts` 中。
