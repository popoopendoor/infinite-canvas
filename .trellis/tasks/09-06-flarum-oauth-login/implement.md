# OAuth、BFF 与 Money Bridge 执行计划

## 阶段 1：基线与服务骨架

- [x] 创建 `server/` Node.js/TypeScript package、严格 tsconfig、Express 启动入口、环境配置和结构化脱敏日志。
- [x] 添加完整 SQLite schema/迁移初始化：oauth states、sessions、model catalog/prices、model tasks、billing links、reconciliation records。模型目录配置会规范化并持久化为不可变 release、entry、active state 和发布/重新激活事件；任务与 capability/reconciliation 记录保留在同一持久卷。
- [x] 添加 `bridge/` 独立 Composer/Flarum 扩展骨架、独立命名和迁移（目标 Flarum 1.8.x 仅保留 `migrations/`）；确认 Docker 构建上下文不包含 bridge 运行时。
- [x] 将 BFF 健康检查、Nginx/Vite 代理、Docker Compose 和本地启动命令接通。

## 阶段 2：OAuth 与网站会话

- [x] 实现站内 returnTo 校验、state hash、事务 cookie、一次性并发消费和 callback 错误分类。
- [x] 实现 OAuth code/token/user 请求超时、HTTP 200 error 识别、schema 校验和最小用户资料归一化。
- [x] 实现服务端 opaque session、3 天 idle、30 天 absolute、重启恢复、立即撤销和服务故障 503。
- [x] 实现 Origin 防护的 POST logout、无敏感值重定向和安全 cookie。
- [x] 为上述行为补充可控时钟单元测试和 HTTP 集成测试。

## 阶段 3：钱包 bridge、目录与计费状态机

- [x] 实现 bridge 服务认证、整数金额校验、float 小数拒绝、余额查询、原子 hold、capture、release/refund 和服务端幂等。bridge balance、hold、capture、release 已在本机测试 Flarum 完成真实联调；独立 refund 由 release 语义覆盖。
- [x] 实现 BFF bridge client，稳定用户 ID 从 session 派生，禁止浏览器提供扣费身份和金额。
- [x] 实现服务端模型目录、能力校验、规范化参数、价格版本、报价和钱包错误分类；目录源配置会生成可审计的 SQLite 发布记录，恢复历史配置只重新激活已有 release。
- [x] 实现模型任务状态机、provider timeout/unknown 分类、重启恢复/对账和重复请求冲突处理。
- [x] 实现 BYOK 公钥加密封装、provider allowlist/SSRF 校验、secret redaction 和受控 adapter。
- [x] 覆盖并发消费、重复 hold/capture/release、未知结果和部分批量任务测试。当前已覆盖自定义 capability 并发建单、重复 capture/release、未知 provider/wallet 结果、幂等冲突，以及标准批量任务的独立成功/失败/待对账结果；本机测试 Flarum 的并发 hold 已验收，生产全论坛并发协调仍待部署验证。

## 阶段 4：前端认证与模型路径

- [x] 扩展 user store、认证 API、认证边界和公开认证页面；保护所有业务路由并处理 loading/error/expired 状态；BFF API 返回 `401` 时清理身份内存状态，页面重新获得焦点或恢复可见时重新确认会话。
- [x] 修改桌面/移动导航和画布导航，提供登录、用户资料、余额和退出入口，保持中英文与窄屏可用。
- [x] 将图片、编辑、文本、音频、视频、画布 Agent 和自定义插件的 Canvas 发起路径接入 BFF 任务/授权协议。图片、编辑、文本、音频、视频和画布 Agent 使用标准 BFF task；自定义模型脚本通过隔离 Web Worker、短期 capability、同源 provider proxy 和 capture/release/reconciliation 接入，脚本无法读取页面本地存储的 provider key。
- [x] 保证登录、退出和切换账户不清理现有本地画布、素材、配置、WebDAV 和 Agent 数据。

## 阶段 5：文档、联调与质量门禁

- [x] 更新 Docker、环境变量、Flarum OAuth client、bridge 安装升级、服务间认证、模型目录/价格发布和对账文档；生产配置至少发布一个托管模型。
- [x] 使用真实测试论坛完成 OAuth 身份、余额和至少一次真实扣费/失败处理联调；记录版本、时间和脱敏证据。2026-09-07 已完成真实 OAuth callback、BFF balance、bridge balance、hold/release、hold/capture、insufficient-balance，以及临时 BFF 的 session-bound provider-contract/capture 验证；echo provider 不替代真实模型 provider 验收。
- [x] 运行 `server` 测试、bridge 静态检查、`web` typecheck、目标文件 format check、build 和 Docker smoke test。当前 `server` 70 项测试/typecheck/build/format、bridge PHP lint/Composer validate、web typecheck/build/目标文件 format check、Compose config，以及 Docker smoke 均通过；真实 Flarum OAuth/money/bridge 联调已完成。`web` 全量 format check 仍有既有未格式化文件，未做无关格式化。
- [ ] 检查浏览器网络、存储、构建产物、日志和错误页面，不出现 OAuth token、client secret、bridge token、provider secret 或 cookie。
- [x] 登录后的托管模型按 provider endpoint 分组，服务端 key 不下发；无浏览器 key 的标准任务仍完成 money hold/capture，托管渠道的 endpoint、协议、模型能力和模型清单不可编辑。
- [x] 建立 `acceptance.md`，按 AC1-AC25 区分本地已验证、部分验证和未开始项目；任何未能真实验证的项目仍标记为未完成，不以 mock 代替。

## 当前验证记录

- `acceptance.md` 是 AC1-AC25 的唯一验收证据源，记录本地验证、真实 Flarum 联调和待完成项目。
- 当前未完成项仅包括浏览器网络/存储值审计、真实付费及异步 provider、以及生产发布/恢复演练；它们保持 `Partial`，不以 mock 或静态检查替代。Docker 本地在途任务恢复已完成验证。

## 验证命令

```bash
cd server && npm test && npm run typecheck
cd ../web && npm run typecheck && npm run format:check && npm run build
cd .. && docker compose -f docker-compose.local.yml config
git diff --check
```

## 回滚点

- OAuth/会话上线前：删除 BFF 路由代理即可恢复静态前端，但不删除 SQLite 数据卷。
- 计费上线前：模型目录保持未发布，所有收费请求 fail closed；不回滚或覆盖 bridge ledger。
- 生产升级失败：保留旧 BFF/数据库卷，停止新 provider 任务创建，将已有未知任务留在对账状态。
