# Flarum Money 与 Canvas Bridge 研究

## 研究对象与快照

### 原始 money 扩展

- 仓库：<https://github.com/AntoineFr/flarum-ext-money>
- Composer 包名：`antoinefr/flarum-ext-money`
- 公开源码快照：`master@69d44d8574040c597f647ea097dc32ab4af94072`
- 对照标签：`v1.4.0`、`v2.0.0-rc.1`

### 目标测试环境

通过仓库外的受限本机 SSH 配置连接目标测试环境，仅执行只读检查；连接信息和密钥路径不写入项目。

- Flarum Core：`1.8.16`
- PHP CLI：`8.2.4`
- MariaDB：`10.4.28`
- `antoinefr-money`：`1.4.1`
- `foskym-oauth-center`：`v1.3.0`
- `yuyuko233/vfxskill-ai-bridge`：目标环境已安装，当前提交为 `0b29f2d7be0ad22820767aa199b2533b4f7613ee`
- `yuyuko233/vfxskill-money-redeem`：`0.1.0`
- 目标环境的 AI bridge 工作树存在未提交修改；未覆盖、拉取或修改这些改动。
- 测试环境 debug mode 当前开启；未擅自修改，生产部署前必须关闭并验证错误输出脱敏。

## 原始 money 扩展的能力边界

1. `v1.4.0` 依赖 Flarum Core `^1.0`；`v2.0.0-rc.1` 依赖 Flarum Core `^2.0`。目标环境的 `1.4.1` 与 Flarum `1.8.16` 匹配。
2. `users.money` 由迁移定义为 `float`。v1.x 通过 `UserSerializer` 暴露 `money` 和 `canEditMoney`；v2.x 通过 `UserResource` 暴露可写的 `money`。
3. `src/Listeners/GiveMoney.php` 和 AutoModerator action 通过读取用户对象、修改 `$user->money`、调用 `$user->save()` 并派发 `MoneyUpdated` 完成加减。用户 API 写入余额要求 actor 具备 `edit_money`。
4. 已检查的源码没有面向消费者的扣费、冻结、退款、交易账本、交易 ID、幂等键或原子扣减 API。`edit_money` 是管理员修改余额的权限，不是普通 OAuth 用户或 Canvas 服务的消费授权。

## 现有 AI bridge 的能力

目标环境的 `yuyuko233/vfxskill-ai-bridge` Composer 配置依赖 Flarum `^1.8`、`antoinefr/flarum-ext-money ^1.4`、`foskym/flarum-oauth-center ^1.3` 和 `fof/upload`。其 `extend.php` 注册了：

- `/api/ai/bridge/bootstrap`
- `/api/ai/bridge/token`
- `/api/ai/bridge/resolve`
- `/api/ai/billing/quote-preview`
- `/api/ai/billing/quote`
- `/api/ai/billing/hold`
- `/api/ai/billing/capture`
- `/api/ai/billing/release`
- `/api/ai/generations`
- `/aiart` 及旧入口和资源路由

其迁移创建了 `ai_model_price_rules`、`ai_billing_ledgers`、`ai_bridge_token_nonces` 和 `ai_generation_records`，覆盖价格规则、计费状态、一次性 token nonce 和图片生成记录。主要流程是当前 Flarum 会话获取报价、hold 用户余额、创建生成记录、服务端调用 provider、capture 或 release，再保存生成结果。

部分 billing controller 使用共享 Bearer service token，另有 Flarum session 和签名一次性 bridge token。共享 service token 不能下发浏览器，且这些机制不能替代 Canvas OAuth 会话。

## 现有 AI bridge 的未验收缺口

1. `src/Support/UserMoneyBalanceGateway.php::balanceOf()` 将余额四舍五入为整数，`hold()`/`refund()` 再把整数写回浮点字段，可能造成小数余额损失或凭空变化。
2. bridge 事务内的用户行锁不能保护原始 money 扩展的奖励、撤回奖励和管理员修改路径中已经读取旧值的写入者；必须研究所有余额写入方的并发兼容。
3. `AiBillingHoldService::assertHoldReplayMatches()` 当前主要比较 generation UUID 和用户 ID，尚需绑定报价及规范化请求参数。
4. `AiBillingCaptureService` 对已 capture 的记录返回已有结果，尚需拒绝金额、请求或幂等参数冲突的重放。
5. `AiGenerationSubmitService::submit()` 每次调用都生成新的 generation UUID；hold 后、生成记录和 provider 提交之间存在恢复窗口，尚未证明浏览器请求级 exactly-once。
6. 生成异常会尝试 release hold，但 provider 超时、存储失败、断流或浏览器关闭可能对应已经产生费用的上游结果，不能统一当作可退款失败。
7. 当前已读生成服务主要覆盖图片生成/编辑链路，尚未覆盖 Canvas 现有文本、音频、视频和画布 Agent 全部入口。
8. bridge 工作树存在未提交改动；现有单元测试覆盖部分报价、账本和生成流程，但不能替代真实环境中的全论坛并发、OAuth 回调、跨服务重放和结果未知验证。

## 与 Canvas OAuth 任务的决策

- 用户已批准在 Flarum 侧提供独立 Canvas 积分桥接能力，并纳入必要的 money 并发兼容调整。
- 已确认采用独立 Node.js/TypeScript Canvas BFF：Canvas BFF 负责 OAuth、网站会话、模型目录、价格、provider 和模型任务状态；fork 后的 Flarum bridge 只负责受控的钱包余额与扣费及必要的 Flarum 侧接口。
- 用户明确不因接入 OAuth 和 money 计费而禁用 BYOK、本地 Agent 模型调用或自定义插件入口；这些入口及既有本地工具能力继续保留。通过 Canvas UI、Canvas Agent 或 Canvas 插件发起的文本、图片、音频、视频、Agent 和自定义插件模型请求均须纳入 money 计费，并由 fork bridge 与 Canvas BFF 提供统一的计费授权、受控适配和结果回传契约；价格采用服务端固定价格版本，按模型、能力和规范化请求参数匹配，并在报价/计费授权时锁定 `price_version`；不按 token、时长或上游成本动态结算。用户在 Canvas 外自行运行 provider、Agent 或插件不属于本系统可控制范围。
- 固定价格版本不等于已确定金额表达方式；用户已确认采用整数积分并禁止负余额。计费契约约定 `1 money = 1` 积分，价格、余额判定、预扣、capture 和 release/refund 金额均为有限非负整数，余额最低为 `0`，不做四舍五入或截断；没有未经确认的统一单次价格上限，每个可收费请求必须使用服务端价格目录中显式发布的合法整数价格，并由服务端执行安全整数范围和配置校验。由于目标 money 余额是 `float`，历史小数余额和所有共享余额写入方的兼容、迁移或拒绝策略仍需在设计与部署前明确。
- 已确认计费生命周期按计费单元执行：预扣/冻结 -> provider 明确成功后 capture -> provider 明确失败后 release/refund；超时、断流、取消、浏览器关闭或 provider 返回结果未知时保持待对账，不自动重试、不自动退款。异步任务和批量请求按可独立确认的计费单元处理；具体状态映射和对账流程仍待设计。
- 用户已确认网站会话采用服务端持久化存储：空闲有效期 7 天，绝对有效期 30 天；BFF 重启后保留未过期会话，主动退出立即使当前会话失效。会话过期和退出不自动撤销 Flarum OAuth token，不同步论坛全局登出、封禁或权限变化；具体存储产品仍待设计。
- 用户已确认不实施账户级本地数据隔离：同一浏览器切换不同 Flarum 账户时继续使用现有共享本地存储命名空间；登录、退出和账户切换不删除、迁移或重命名画布、素材、提示词、模型密钥和 WebDAV 数据。账户命名空间、历史迁移和共享设备隐私保护不属于本任务；相关回归只能证明数据未被认证流程改变。
- 已确认部署拓扑：完整 `infinite-canvas`（前端与 Canvas BFF）使用 Docker 部署，前端通过同源 Nginx 入口访问 BFF；fork 后的 bridge 作为独立 PHP/Composer Flarum 扩展安装到 Flarum，不进入 Canvas Docker 镜像或前端构建。BFF 通过受认证的服务间接口调用 bridge，不直连 Flarum 数据库。
- Docker Compose/编排方式、容器数量、数据库与会话存储产品、持久卷和网络/TLS 细节尚未选定；部署方式确认不代表已经批准实现或远程部署。
- fork 后的新扩展需要独立 Composer 包名、Flarum 扩展 ID、PHP namespace、路由前缀、配置键、迁移和账本表命名，安装时不得覆盖目标环境旧 bridge 的资产、数据或 `/aiart` 路由。
- 用户明确不直接复用目标环境当前安装的 AI bridge，但允许 fork 其源码并作为独立 bridge 的参考基础。
- fork 后的 bridge 不默认继承当前 `/aiart` 应用兼容；是否保留某些旧能力必须由最终设计和回归结果决定。
- 现有 AI bridge 标记为 proprietary。fork 授权、独立仓库归属、发布方式和部署权限需要由项目方管理；其源码不复制进 Canvas 公共仓库，也不覆盖测试机上当前 dirty 工作树。
- Canvas OAuth 登录仍需独立设计。OAuth 授权码、Flarum session、bridge token 和共享 service token 是不同机制，不能互相替代。
- 不得未经批准现场修改原始 money 扩展的余额字段、授予普通用户 `edit_money` 或让前端自行计算/提交扣费金额；必要的精度迁移、并发兼容调整和 bridge 钱包实现必须先经过设计、自动化测试及部署审批。
- 本次远程检查没有执行报价、扣款、退款、迁移、缓存清理或测试命令，因此不构成真实扣费验收证据。
