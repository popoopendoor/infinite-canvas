# 记录规范

> `canvas-agent/src/utils/logger.ts` 中当前使用的记录约定。

## 日志和输出

使用 `canvas-agent/src/utils/logger.ts` 中的导出的 `logger`（包括 `debug`、`info`、`warn` 和 `error`）而不是在功能模块中创建另一个日志记录器。 Winston 以带时间戳的单行格式写入控制台。 正常模式下的日志记录级别为 `info` 及以上。 通过 `--debug` 启用 `debug` 输出，并会在 `~/.infinite-canvas/logs/` 下生成每日日志文件。

```ts
logger.info("Codex turn accepted", {
    threadId,
    model: model || "default",
    promptLength: prompt.length,
    attachmentCount: attachments.length,
});
```

`canvas-agent/src/server/http.ts` 中的 HTTP 中间件使用 `debug` 记录选定的请求完成记录，使用 `info` 记录 Codex 生命周期事件，使用 `warn` 记录可恢复的清理失败，并在终端请求处理程序中使用 `error`。

## 级别

- `debug`: 用于 `--debug` 的有用的诊断请求/生命周期详细信息。
- `info`: 重要操作事件，例如代理启动和接受/开始/完成 Codex 轮次。
- `warn`: 非致命的清理或恢复问题，此时主要操作仍可继续。
- `error`: 需要调查的失败 HTTP 请求或操作。

不要为单个模块添加新的级别或单独的日志格式。

## 清理

`Logger` 在将元数据传递给 Winston 之前对其进行清理。 匹配 `token`、`authorization`、`apiKey` 或 `dataUrl` 的键变为 `[REDACTED]`； data URL 值根据长度进行总结； `Error` 值被简化为名称/消息/堆栈； 循环对象标记为 `[CIRCULAR]`。

即使进行了这种清理，也应避免将秘密或大型数据传递给日志。 请遵循现有的 Codex 轮次模式，并记录 `promptLength` 和 `attachmentCount`，而不是实际的提示或图像数据。 在 `canvas-agent/src/config.ts` 中，用于本地授权的 token 永远不应作为值记录。

## 示例

- `canvas-agent/src/utils/logger.ts`: Winston 设置、级别、格式和清理。
- `canvas-agent/src/server/http.ts`: HTTP 完成和错误日志记录以及 Codex 生命周期记录。
- `canvas-agent/src/config.ts`: 必须保持在日志负载之外的本地 token/配置处理。
