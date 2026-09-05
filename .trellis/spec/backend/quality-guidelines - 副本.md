# 后端质量指南

> 基于 `canvas-agent` 包的质量实践。

## TypeScript 和构建

后端使用严格的 TypeScript，并使用 NodeNext 模块。 `canvas-agent/tsconfig.json` 通过 strict 模式启用严格模式、声明和 `noImplicit` 行为；它从生产构建中排除 `src/**/*.test.ts` 文件。 构建命令为 `npm run build` (`tsc -p tsconfig.json`)。 `canvas-agent/package.json` 中没有后端 lint 脚本，因此不要报告不存在的 lint 命令。

## 测试

使用 Node 的内置测试运行器通过 `tsx --test`；不要为了遵循模板而添加测试框架。 包中的测试脚本列出了现有的同位置测试文件。 测试导入 `test` 来自 `node:test`，断言来自 `node:assert/strict`。

```ts
import assert from "node:assert/strict";
import test from "node:test";

test("生成流程仍然为文本提示创建 prompt 节点", () => {
    const ops = opsOf("canvas_generate_image", { prompt: "a cat on a roof", autoRun: true });
    assert.equal(ops.filter((op) => op.type === "add_node" && op.nodeType === "text").length, 1);
});
```

相关的示例包括 `canvas-agent/src/canvas/operations.test.ts`、`canvas-agent/src/config.test.ts`、`canvas-agent/src/skills/store.test.ts` 和 `canvas-agent/src/agent/codex-client.test.ts`。 优先使用确定性的假冒和关于可观察行为、状态和协议消息的断言，而不是对外部或不受信任的 MCP 工具输入的实时验证。

## 审查清单

对于后端更改，请检查以下内容：

- 新的 HTTP 路由保持在 `canvas-agent/src/server/http.ts` 中，并在保护时放置在 CORS 和 token 中间件之后，并使用 `route()` 处理异步错误；
- 在 `canvas-agent/src/server/http.ts` 中的成功和错误响应封装保留 `ok`、状态以及任何已确定的 `code`/`state` 协议；
- 使用 Zod 模式在 `canvas-agent/src/canvas/schemas.ts` 中验证外部或不受信任的 MCP 工具输入，然后再在 `canvas-agent/src/server/mcp.ts` 中注册；
- 日志使用 `canvas-agent/src/utils/logger.ts` 中的共享日志记录器，并且 HTTP/Codex 日志点在 `canvas-agent/src/server/http.ts` 中不应暴露令牌、API 密钥、数据 URL、提示内容或大型负载；
- 针对性行为测试涵盖新的分支，使用 `canvas-agent/package.json` 列出的同位置测试，以及在更改影响 `canvas-agent` 时运行 `npm test` 和 `npm run build`。

将更改限制在所属的包中。 `canvas-agent/package.json` 列出了包的可用的测试/构建命令，并且如 `canvas-agent/src/config.test.ts` 这样的同位置测试是其当前测试边界的证据。 没有后端集成测试套件或强制性的覆盖率阈值的证据；不要在功能任务中发明它。
