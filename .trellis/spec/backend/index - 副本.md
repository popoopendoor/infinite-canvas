# 后端开发指南

> 基于证据的约定，适用于 `canvas-agent` 的 Node/TypeScript 包。

## 指南索引

| 指南 | 范围 |
|---|---|
| [目录结构](./directory-structure.md) | 入口、服务器模块、领域目录以及测试放置 |
| [数据库指南](./database-guidelines.md) | 目前仅使用文件系统持久化；没有 ORM 或迁移层 |
| [错误处理](./error-handling.md) | 异步路由传播、类型化的状态错误以及 JSON 响应 |
| [日志指南](./logging-guidelines.md) | Winston 等级、调试文件、生命周期记录以及脱敏 |
| [质量指南](./quality-guidelines.md) | 严格的 TypeScript、Node 测试、构建检查以及审查要点 |

## 包边界

这些指南中关于后端的示例，都指的是 `canvas-agent`。 该仓库还包含 `canvas-proxy`，这是一个小型独立代理包；仅在代码结构与 `canvas-agent` 包匹配时才应用这些规则。
</translate_input>