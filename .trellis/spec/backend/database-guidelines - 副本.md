# 数据库指南

> 当前项目的持久化现实。

## 当前状态

当前仓库中没有数据库、ORM、查询构建器、迁移系统或事务层。对于只需要现有本地存储机制的特性，不要为之发明数据库约定。

后端将本地配置和代理数据作为文件进行持久化。例如，`canvas-agent/src/config.ts` 读取和写入 `~/.infinite-canvas/canvas-agent.json`、创建工作区目录并显式设置文件权限。代理历史记录和消息元数据也使用文件系统模块，位于 `canvas-agent/src/agent/codex-event-history.ts` 和 `canvas-agent/src/agent/message-metadata.ts` 中。

## 查询模式

没有数据库查询。在当前包内部工作时，请使用现有的文件系统或内存抽象。保持序列化/反序列化与拥有模块的紧密联系。`canvas-agent/src/config.ts` 使用 `JSON.parse`/`JSON.stringify` 处理其文件格式；这并不是一个数据库 API。

## 迁移和事务

`canvas-agent/package.json` 和当前 `canvas-agent/src/` 模块中没有迁移或数据库事务。不要为与无关的功能添加迁移命令、模式版本控制、ORM 依赖项或事务包装器。如果稍后引入数据库，在实施之前，请更新此文档，包括所选库、生命周期、命名约定、迁移规则和事务规则。

## 命名

仅文件系统实现的没有表、列、索引或查询命名约定。本地文件名和 JSON 字段遵循拥有模块的 TypeScript 契约；请参见 `canvas-agent/src/config.ts`、`canvas-agent/src/agent/codex-event-history.ts` 和 `canvas-agent/src/agent/message-metadata.ts`。

## 常见错误

- 不要将本地 JSON/文件系统持久化描述为云同步或关系型数据库。
- 当没有涉及数据库时，不要添加虚构的 `models/` 或 `repositories/` 层。
- 不要默默地更改 `canvas-agent/src/config.ts` 中的现有磁盘格式或权限行为；持久性更改需要单独的任务和证据。
