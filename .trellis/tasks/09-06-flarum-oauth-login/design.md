# Canvas OAuth、BFF 与 Money Bridge 设计

## 1. 目标边界

本任务在 `infinite-canvas` 仓库内交付 Web 前端和 `server/` BFF；Flarum 钱包能力作为仓库内独立的 Composer 扩展源代码维护，但不复制或依赖目标环境中已有的 proprietary bridge。Docker 构建只包含 `web` 静态产物和 BFF 运行所需文件，不把 PHP bridge 安装进 Canvas 镜像。bridge 面向目标 Flarum 1.8.x，迁移只保留在项目现有扩展约定的 `migrations/` 目录，避免同一迁移被注册两次。

浏览器只访问同源 Canvas BFF。BFF 不直连 Flarum 数据库，通过服务间认证访问独立 bridge。Flarum OAuth access token 只在 OAuth callback 的服务端内存中短暂使用，成功建立网站会话后丢弃，不保存 refresh token。

本地 Compose 使用 `development` 运行模式以支持 HTTP localhost；生产模式要求 Canvas `APP_ORIGIN`、Flarum OAuth 基础地址和 bridge 地址均使用 HTTPS，Cookie 的 `Secure` 属性由公开 Canvas origin 的协议决定。

生产 BFF 启动时 fail closed：除 HTTPS 外还必须具备完整 OAuth 配置、bridge
地址与服务令牌、provider host allowlist，并要求 `OAUTH_REDIRECT_URI` 精确
等于公开 Canvas 的 `/auth/callback`。这样配置错误会在进程启动时暴露，而
不会等到首次登录或扣费请求才发现。

## 2. 运行拓扑

```text
Browser
  │ same-origin /auth, /api
  ▼
Nginx ── /api/*, /auth/* ──> Canvas BFF (Node.js/TypeScript)
                                  │ OAuth HTTPS
                                  ├──────────────> Flarum OAuth Center
                                  │ X-Canvas-Bridge-Token
                                  ├──────────────> Canvas Money Bridge (Flarum PHP)
                                  └──────────────> configured model providers
```

开发时 Vite 将 `/auth` 和 `/api` 代理到 BFF；生产时 Nginx 反向代理同样的路径。BFF 使用 Express、Zod 和原生 `fetch`；SQLite 通过 `better-sqlite3` 保存网站会话、OAuth state、模型任务、计费关联及模型目录发布记录，数据文件位于显式持久卷。第一版按单 BFF 实例部署，避免 SQLite 多副本写入语义未定义。

## 3. OAuth 与会话

- `GET /auth/login?returnTo=/...`：校验站内 returnTo，生成 32 字节随机 state，数据库只保存 state hash、浏览器事务 cookie hash、过期时间和 returnTo，然后重定向到 Flarum authorize endpoint。
- `GET /auth/callback`：要求 state、事务 cookie、code 参数同时有效；事务以数据库条件更新原子消费，重复/并发 callback 只能有一个成功。OAuth error、缺参、上游错误和无效用户都跳转到不含敏感信息的认证错误页。
- Flarum OAuth Center 使用仓库内维护的 `oauth-center/` fork。它保留已有 package、extension ID、路由和设置键；表单与 Fetch 授权都只接受显式同意，并返回 OAuth server 生成的 redirect location，因此拒绝会携带 `access_denied` 和原始 state 回到 BFF。
- 授权码交换和 userinfo 请求强制 HTTPS、超时、响应大小限制和 JSON schema 校验；HTTP 200 中的 OAuth `error` 仍按失败处理。
- PKCE 不作为未验证 OAuth Center 的降级方案。实现保留配置化 S256 PKCE：只有 `OAUTH_PKCE_REQUIRED=true` 时才发送并要求 verifier；默认不宣称 provider 已支持 PKCE，并在联调记录中明确。
- 会话 cookie 使用 HttpOnly、Secure（生产）、SameSite=Lax、Path=/、随机 opaque ID；数据库只保存 hash。会话表保存稳定 Flarum user ID、最小展示资料、createdAt、lastSeenAt、absoluteExpiresAt、revokedAt。
- 空闲期限固定 3 天，绝对期限固定 30 天。只有成功通过 BFF 会话认证的请求更新 lastSeenAt；本地画布鼠标和编辑活动不会续期。过期会话删除 cookie 并返回 unauthenticated，数据库/网络故障返回 503，不伪装成匿名。
- `POST /auth/logout` 要求 Origin 与配置的 Canvas origin 相同，服务端立即撤销会话并清除 cookie；不调用 Flarum 全局登出。

## 4. BFF API 契约

认证：

- `GET /auth/session` -> `{ authenticated: false }` 或 `{ authenticated: true, user }`
- `POST /auth/logout` -> `{ ok: true }`

模型与计费：

- `GET /api/models`：只返回服务端发布的模型、能力和可用参数，不返回 provider secret。
- `GET /api/wallet`：通过 bridge 查询当前会话绑定用户的整数积分余额；钱包不可用与余额为零分别返回。
- `POST /api/model-tasks`：接受能力、服务端模型 ID、规范化请求、一次性幂等键和受保护的 BYOK 凭据封装；BFF 自己解析模型与价格，创建计费单元，调用 provider，持久化最终状态，并只在明确成功/失败时 capture/release。
- `POST /api/model-task-batches`：一次接收 1-20 个已规范化的模型请求；每个子请求必须提供独立幂等键，BFF 并行执行独立的 hold/provider/capture 或 release 生命周期，返回聚合状态和全部子任务。聚合状态只用于批量展示，不能替代子任务的成功、失败或 `pending_reconciliation` 状态。
- `GET /api/model-tasks/:id`：读取服务端任务状态，未知结果返回 `pending_reconciliation`，不触发自动重试或自动退款。

所有外部 JSON 使用 Zod/显式 type guard 解析。用户 ID、金额、模型 ID、价格版本、规范化请求和 provider 结果均由服务端生成或校验；浏览器提交的金额、用户 ID、价格和成功状态永远不具备权威性。

## 5. 价格、幂等与 provider

`MODEL_CATALOG_JSON` 是受控的启动配置源，不是可由浏览器修改的运行时输入。BFF 启动时先使用 Zod 校验目录，再将按模型 ID 排序后的规范 JSON 计算 SHA-256，并在 SQLite 中保存不可变的 `model_catalog_releases`、`model_catalog_entries`、单行 active state 和发布事件。新内容创建并激活新 release；恢复曾发布的内容只重新激活既有 release 并写入 `reactivated` 审计事件；内容不变不会产生重复 release。`MODEL_PROVIDER_KEYS_JSON` 是独立的服务端密钥映射，按发布模型 ID 将模型标记为 `managed`；key 不进入目录快照或任何浏览器响应。`GET /api/models` 只返回安全的模型路由元数据（`provider`、`apiFormat`、`baseUrl`、可选 provider model）和 credential mode。前端按 `apiFormat + baseUrl` 将托管模型分组，避免不同 provider 或 endpoint 共用错误渠道；生产启动要求至少存在一个已发布且映射了服务端 key 的托管模型。价格以有限非负 JavaScript safe integer 表示，按 `model + capability + normalizedParams` 匹配并锁定 `priceVersion`；同一模型改价必须使用新的 `priceVersion`。缺少价格、金额非法、余额不足或 bridge 不可达时，在 provider 调用前拒绝请求。

每个任务由 `idempotencyKey`、用户 ID 和规范化请求 hash 唯一确定。相同 key 与相同请求返回既有结果；相同 key 与不同请求返回冲突。批量请求只提供提交聚合，不合并计费；批量中的每个子请求仍按独立任务记录和幂等键处理，因此可以出现部分成功、部分失败和部分待对账。计费状态机为 `created -> held -> running -> succeeded|failed|pending_reconciliation`，钱包状态由 bridge 权威记录。BFF 进程重启后从数据库读取 running/held 任务并标记为待对账，不自动重放 provider。

BYOK 的原始 API key 不作为普通 JSON 传输给 BFF：BFF 提供短期 RSA-OAEP 公钥，前端用 Web Crypto 加密，服务端仅在当前 provider 请求内解密，绝不落库、写日志或返回浏览器。服务端托管模型从 `MODEL_PROVIDER_KEYS_JSON` 读取 key，不接受浏览器凭据。provider base URL 必须是 HTTPS 且通过服务端 allowlist/SSRF 校验；服务端目录决定请求路径和能力。用户已有本地配置继续保留，但请求不再直接携带原始 key 到 provider。

内置 OpenAI-compatible、Gemini-compatible 和可配置异步 provider 适配器共享同一个计费任务生命周期。自定义模型脚本在 Web Worker 中运行，不能读取页面 `localStorage` 中保存的 provider key，也不接收 capability token；其 `apiKey` 变量仅为受管占位值。capability 创建响应向 Worker 提供目录绑定的 `baseUrl` 和 provider model，而不是浏览器配置中的对应值。页面主线程持有 capability，并经私有 `MessageChannel` 以固定的 `X-Canvas-Capability` 请求头调用受控 BFF adapter。capability token 不进入 URL、查询参数、浏览器历史或可记录的重定向地址；BFF 还会移除脚本请求中的凭据查询参数和请求头，在 JSON、表单、query 与 Gemini URL 的标准模型位置锁定目录 model，并以服务端解密的 provider key 替换认证。Worker 会尽量屏蔽脚本直接使用全局 `fetch`/`XMLHttpRequest` 的路径，但不是对恶意脚本的强安全沙箱，不能作为完整的代码隔离或反恶意执行边界；真正的安全边界是 BFF 不向脚本提供原始 provider key，并在服务端校验 capability、provider origin、用户、价格和钱包状态。token 绑定用户、任务、模型、价格、规范化参数和过期时间，且自定义脚本不能通过受控 adapter 提交任意 provider URL 或宣称成功。终态完成会撤销 token 的请求能力；若 capture/release 成功后的 HTTP 响应丢失，同一用户可用原 token 安全重放完成请求以读取已持久化的终态，但不会再次调用钱包或 provider。

## 6. Money bridge

新增独立 Composer 包 `popoopendoor/canvas-money-bridge`，Flarum extension ID 为 `popoopendoor-canvas-money-bridge`，PHP namespace 为 `Popoopendoor\\CanvasMoneyBridge`，路由前缀为 `/api/canvas-money`，表前缀为 `canvas_money_`。它不注册旧 `/aiart` 路由，不复用旧 bridge 表或配置。

bridge 只接受来自 BFF 的 `X-Canvas-Bridge-Token` 服务间请求头，并从请求中的已验证 stable Flarum user ID 执行余额/账本操作；不使用 `Authorization`，避免被 Flarum OAuth Center 当作 OAuth access token。钱包表和 ledger 记录包含 external request ID、用户、金额、请求 hash、状态和时间；hold 使用数据库事务、用户行锁和条件余额更新，capture 不重复扣款，release 在 held 状态下原子返还。

原始 `users.money` 是 float。bridge 禁止四舍五入或截断：发现非有限值或历史小数余额时拒绝收费操作并返回可诊断错误，部署前由运营方完成显式迁移或人工处理。所有收费金额必须是整数且不低于零，余额不能降到零以下。bridge 不授予普通用户 `edit_money`，也不提供通用余额覆盖接口。

## 7. 前端集成

- `use-user-store` 只保存服务端返回的最小用户资料和认证状态，不持久化 token。
- 登录成功后，前端将 `/api/models` 中 credential mode 为 `managed` 的条目按 `apiFormat + baseUrl` 加入多个 Canvas managed 渠道，并为缺少有效本地配置的能力选择托管模型；endpoint、协议、能力和模型清单由服务端锁定，前端只允许编辑托管模型的自定义脚本。
- `UserLayout` 通过认证边界组件保护业务路由；登录、错误和 callback 处理页保持公开。未知状态显示阻塞加载，服务故障显示重试，不闪现业务内容。
- 桌面导航、移动导航和画布相关入口显示登录/用户菜单、积分余额和退出操作。
- `web/src/services/api/` 中的图片、视频、音频、文本、Agent/插件模型入口统一调用 BFF；本地 Agent 的本机连接仍保留，但 Canvas 发起的模型任务必须先获得 BFF 计费授权。
- 登录/退出只清理身份内存状态和 Query cache，不清空 localforage、localStorage、模型配置、画布、素材、WebDAV 或 Agent 数据；不同 Flarum 账户继续使用现有共享本地命名空间。

## 8. 失败、恢复和安全

网络超时、provider 断流、取消、浏览器关闭或 provider 结果未知都进入待对账，不自动重试/退款。明确 provider 失败才 release，明确成功才 capture。日志采用结构化字段并进行 secret、cookie、authorization、code、state 和请求体脱敏；认证响应禁止缓存。`/auth/login` 与 `/auth/callback` 在单个 BFF 进程中共享按客户端 IP 的固定窗口限流，默认每 60 秒 20 次；Nginx 是唯一受信任的代理跳，超限返回带 `Retry-After` 的 `rate_limited` 重试页且不创建或消费 OAuth transaction。多实例部署需要在网关或共享限流存储中实施等价策略。

测试以可控时钟覆盖 state 一次性消费、并发 callback、会话 3 天空闲/30 天绝对期限、重启恢复、退出撤销、Origin、开放重定向、OAuth 200 error、幂等冲突、并发 hold、capture/release 重放和 unknown reconciliation。
