# 错误处理

> 当前的 `canvas-agent` HTTP 和 MCP 层如何处理错误。

## 概述

错误在可以转换为有用的响应的边界处进行处理。异步 Express 处理程序被包装，以便拒绝的承诺到达一个终端中间件。 路由包装器和终端中间件都定义在 `canvas-agent/src/server/http.ts` 中。 携带 HTTP 状态码的域错误会保留该状态； 未知错误变为 500 响应。

## 异步 Express 处理程序

使用 `canvas-agent/src/server/http.ts` 中的本地 `route()` 辅助函数来处理异步处理程序：

```ts
function route(handler: (req: Request, res: Response) => Promise<unknown>) {
    return (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
}
```

现有的示例包括 `GET /agent/attachments/:attachmentId`、Codex 模型/技能路由以及 Codex 变异路由。 同步处理程序直接发送响应。 当处理程序需要执行清理时，保留主要错误并单独记录清理失败，例如在 Codex 轮次处理程序中。

## 域错误

仅当调用者需要明确的状态码时，才使用类型化的错误。 `SkillStoreError` 在 `canvas-agent/src/skills/store.ts` 和 `CodexSkillLookupError` 在 `canvas-agent/src/agent/codex.ts` 中暴露了用于 HTTP 中间件的 `statusCode` 值。 不要为普通失败添加广泛的层次结构。

在 MCP 边界处，使用 `canvas-agent/src/canvas/schemas.ts` 拥有的模式验证工具输入； `canvas-agent/src/server/mcp.ts` 在转发请求之前调用 `schema.parse(input)`。 无效的输入应在该边界处失败，而不是作为未检查的对象传递。

## 响应格式

HTTP 错误使用包含 `ok: false` 和错误消息的 JSON 包在 `canvas-agent/src/server/http.ts` 中。 一些并发和状态错误还会添加稳定的 `code` 和 `state` 快照，例如在同一文件中 `CONVERSATION_STALE`、`CONVERSATION_NOT_READY` 和 `CONVERSATION_BUSY`。

`canvas-agent/src/server/http.ts` 中的服务器还返回 `{ ok: false, error: "not found" }` 用于未匹配的路由，以及 `{ ok: false, error: "invalid token" }` 用于授权失败的情况。 在添加端点时，请保留状态码和包，以便前端可以一致地处理错误。

```ts
app.use((_req, res) => res.status(404).json({ ok: false, error: "not found" }));

app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error("HTTP request failed", { method: req.method, path: req.path, error });
    if (error instanceof SkillStoreError || error instanceof CodexSkillLookupError) {
        return void res.status(error.statusCode).json({ ok: false, error: error.message });
    }
    res.status(500).json({ ok: false, error: error.message });
});
```

不要将堆栈跟踪或原始请求主体返回给客户端。 请保持面向用户的消息有意义，并避免泄露凭据或数据 URL。
</translate_input>