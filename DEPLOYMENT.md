# 无限画布 Flarum OAuth + Money Bridge 跨机器部署指南

本文档面向 **在另一台机器上从零部署** 无限画布（infinite-canvas）的运维人员，覆盖
Flarum OAuth 登录、受控 `money` 积分计费、Canvas BFF（Node.js 服务）、Nginx 前端，
以及 Flarum 侧两个 PHP 扩展（OAuth Center fork 与 Canvas Money Bridge）的安装配置。

目标交付仓库：`https://github.com/popoopendoor/infinite-canvas.git`（开发分支 `flarum-outh`）。

---

## 1. 架构总览

```text
浏览器
  │  同源 /auth/*、/api/*、/health
  ▼
TLS 反向代理（可选，生产必备：Caddy / Traefik / Nginx + certbot）
  │  反代到 127.0.0.1:3000
  ▼
Nginx（Canvas 前端容器，端口 3000）
  │  /auth/*、/api/*、/health 反向代理
  ▼
Canvas BFF（Node.js/TypeScript，端口 3001，SQLite 持久卷 canvas-bff-data）
  │
  ├── HTTPS ──────────────> Flarum OAuth Center（论坛服务器 /oauth/authorize、/oauth/token、/api/user）
  ├── HTTPS + X-Canvas-Bridge-Token ─> Canvas Money Bridge（论坛服务器 /api/canvas-money/*）
  └── HTTPS ──────────────> 模型 provider（受 allowlist 约束的 OpenAI/Gemini/Generic 协议端点）
```

要点：

- **Canvas 侧** 由 `docker compose` 一键拉起 Nginx 前端 + BFF 两个服务，BFF 状态保存在
  SQLite 文件（持久卷 `canvas-bff-data`）。
- **Flarum 侧** 安装两个独立 PHP/Composer 扩展：OAuth Center（fork）负责身份授权，
  Canvas Money Bridge 负责 `money` 余额查询与 hold/capture/release 原子操作。
- BFF **绝不直连 Flarum 数据库**，只通过 `X-Canvas-Bridge-Token` 服务间令牌调用 bridge。
- OAuth `client_secret`、bridge token、provider key 全部只存在于服务端，绝不下发浏览器。

---

## 2. 前置条件

### 2.1 Canvas 应用服务器

- Docker Engine + Docker Compose v2（`docker compose` 子命令可用）。
- 一个公网域名与 HTTPS 证书（生产模式强制 HTTPS，见第 5 节）。
- 可访问 Flarum 论坛服务器的网络（BFF 需要能通过 HTTPS 访问 `FLARUM_BASE_URL` /
  `FLARUM_INTERNAL_BASE_URL` 和 `BRIDGE_URL`）。

### 2.2 Flarum 论坛服务器

- Flarum Core `1.8.x`（本机联调版本为 `1.8.16`），PHP `8.x`（联调 CLI 为 `8.2.4`），
  MariaDB/MySQL，Composer 2。
- `antoinefr/flarum-ext-money`（money 扩展）`^1.4`——Canvas Money Bridge 的依赖，提供
  `users.money` 余额字段。安装 bridge 时 Composer 会自动解析该依赖。
- `foskym/flarum-oauth-center`（OAuth Center）。本仓库附带其 fork（基于上游 `v1.3.0`），
  修复了授权拒绝时的错误处理；推荐直接安装本仓库 `oauth-center/` 目录中的 fork。

---

## 3. 第一步：Flarum 侧部署

把本仓库的 `oauth-center/` 与 `bridge/` 两个目录拷贝到 Flarum 服务器（例如放在
`/opt/canvas-deps/` 下），Flarum 站点目录下文记为 `$FLARUM`。

### 3.1 配置 Composer path 仓库

编辑 Flarum 站点的 `composer.json`，在 `repositories` 数组中增加两个 path 仓库：

```json
{
  "repositories": [
    {
      "type": "path",
      "url": "/opt/canvas-deps/oauth-center",
      "options": {
        "symlink": false,
        "versions": { "foskym/flarum-oauth-center": "1.3.1" }
      }
    },
    {
      "type": "path",
      "url": "/opt/canvas-deps/bridge",
      "options": {
        "symlink": false,
        "versions": { "popoopendoor/canvas-money-bridge": "1.0.0" }
      }
    }
  ]
}
```

> `symlink: false` 让 Composer 拷贝源码而不是软链，避免后续移动目录导致扩展失效。
> `versions` 必须显式给出，因为这两个目录不在独立 git 仓库里，Composer 无法自行推断版本。

### 3.2 安装两个扩展

```bash
cd "$FLARUM"

# 升级/安装 OAuth Center（保持原有包名、扩展 ID、路由与设置键不变）
composer update foskym/flarum-oauth-center

# 安装 Canvas Money Bridge（独立包名，不与旧 bridge / /aiart 冲突）
composer require popoopendoor/canvas-money-bridge:^1.0

# 启用扩展并执行迁移
php flarum extension:enable foskym-oauth-center
php flarum extension:enable popoopendoor-canvas-money-bridge
php flarum migrate

# 刷新缓存
php flarum cache:clear
```

验证：

```bash
php flarum info
```

确认输出中包含并启用了 `foskym-oauth-center` 与 `popoopendoor-canvas-money-bridge`。
bridge 迁移会创建 `canvas_money_ledgers` 表。

### 3.3 配置 bridge 服务令牌

Canvas Money Bridge 只接受 `X-Canvas-Bridge-Token` 请求头，令牌值存放在 Flarum 设置键
`popoopendoor-canvas-money-bridge.service-token`。该值必须与 Canvas 侧 `.env` 中的
`BRIDGE_TOKEN` **完全一致**。

本扩展没有管理后台界面，直接在 Flarum 数据库的 `settings` 表写入（`key` 为 MySQL 保留字，
需用反引号包裹）：

```sql
INSERT INTO `settings` (`key`, `value`)
VALUES ('popoopendoor-canvas-money-bridge.service-token', '<与 Canvas .env 中 BRIDGE_TOKEN 相同的私密随机值>')
ON DUPLICATE KEY UPDATE `value` = VALUES(`value`);
```

生成随机令牌示例（在论坛服务器上执行，不要写入文档或日志）：

```bash
openssl rand -hex 32
```

### 3.4 注册 Canvas OAuth 客户端

在 Flarum 管理后台的 **OAuth Center** 中新建一个客户端（或专用 `user.read` 客户端）：

| 字段 | 值 |
| --- | --- |
| 名称 | 例如 `Canvas` |
| Redirect / Callback URI | 必须**精确等于** Canvas 的 `/auth/callback`，例如 `https://canvas.example.com/auth/callback` |
| Scope | `user.read` |
| 客户端类型 | 机密客户端（confidential，带 client secret） |

记下生成的 **Client ID** 与 **Client Secret**，填入 Canvas 侧 `.env`（见 4.2）。

> 生产与本地/测试建议分别注册不同的 OAuth 客户端，避免回调地址混用。
> OAuth Center fork 保持上游的包名、扩展 ID、路由与设置键；本机已注册的客户端无需重建。

---

## 4. 第二步：Canvas 侧部署

### 4.1 获取代码并切换分支

```bash
git clone https://github.com/popoopendoor/infinite-canvas.git
cd infinite-canvas
git checkout flarum-outh
```

### 4.2 配置 `.env`

```bash
cp .env.example .env
```

编辑 `.env`。生产部署**最小可用**配置如下（`<...>` 为需要替换的占位符）：

```dotenv
# Canvas 公网 origin，生产必须是 HTTPS
APP_ORIGIN=https://canvas.example.com

# Flarum 论坛根地址（浏览器可见 URL，用于 OAuth 授权页）
FLARUM_BASE_URL=https://forum.example.com
# 可选：仅当 BFF 容器内部访问 Flarum 需要不同地址时才设置（例如论坛同机部署）
# FLARUM_INTERNAL_BASE_URL=http://host.docker.internal

# Flarum OAuth Center 客户端（3.4 节注册）
OAUTH_CLIENT_ID=<registered-client-id>
OAUTH_CLIENT_SECRET=<private-client-secret>
OAUTH_REDIRECT_URI=https://canvas.example.com/auth/callback

# /auth/login 与 /auth/callback 共享的按客户端 IP 限流（可选，有默认值）
AUTH_RATE_LIMIT_MAX=20
AUTH_RATE_LIMIT_WINDOW_MS=60000

# Flarum API 基地址与 bridge 服务令牌
BRIDGE_URL=https://forum.example.com/api
BRIDGE_TOKEN=<same-value-as-flarum-setting-service-token>

# 模型目录（服务端发布，详见 4.3）
MODEL_CATALOG_JSON=[]

# 服务端 provider key 映射（托管模型，详见 4.3）
MODEL_PROVIDER_KEYS_JSON={}

# provider 主机名白名单（逗号分隔，生产必填）
PROVIDER_BASE_URL_ALLOWLIST=api.openai.com,generativelanguage.googleapis.com
```

`.env` 权限建议 `chmod 600 .env`，**不要**提交进仓库（仓库 `.gitignore` 已排除 `.env*`）。

> 本地/开发环境可用 `docker-compose.local.yml`，它允许 OAuth、bridge、目录为空，适合先做
> 界面与健康检查联调；真实登录与计费仍必须填齐上述配置。

### 4.3 模型目录与托管模型

`MODEL_CATALOG_JSON` 是服务端发布的模型目录，每条目结构：

```json
[
  {
    "id": "gpt-image-1",
    "capability": "image",
    "provider": "openai",
    "baseUrl": "https://api.openai.com",
    "model": "gpt-image-1",
    "priceVersion": "2026-09-07",
    "price": 3
  }
]
```

字段说明：

| 字段 | 取值 |
| --- | --- |
| `id` | 模型目录内唯一 ID（1-120 字符） |
| `capability` | `image` / `video` / `text` / `audio` |
| `provider` | `openai` / `gemini` / `generic` |
| `baseUrl` | provider 根地址，HTTPS、无凭据/查询参数/锚点，主机名必须在 `PROVIDER_BASE_URL_ALLOWLIST` 内 |
| `model` | 可选，provider 侧模型名；缺省等于 `id` |
| `priceVersion` | 价格版本，**改价必须换新版本号** |
| `price` | 非负整数积分（`1 money = 1` 积分） |

`MODEL_PROVIDER_KEYS_JSON` 把目录 ID 映射到服务端 provider key：

```json
{ "gpt-image-1": "provider-key-from-secret-store" }
```

被映射的模型成为 **Canvas 托管模型**：登录后自动出现在前端 `Canvas 托管` 配置中，调用时
不要求浏览器提供 key，但仍走完整的 hold/capture 计费链路。未映射的模型为 BYOK 模型。

**生产启动强制要求**（缺任一条件 BFF 会直接启动失败，fail closed）：

1. `APP_ORIGIN`、`FLARUM_BASE_URL`、`BRIDGE_URL` 均为 HTTPS；
2. `OAUTH_REDIRECT_URI` 精确等于 `APP_ORIGIN + /auth/callback`；
3. OAuth 配置完整（`FLARUM_BASE_URL`、client id/secret 齐全）；
4. `BRIDGE_URL` 与 `BRIDGE_TOKEN` 齐全；
5. `PROVIDER_BASE_URL_ALLOWLIST` 非空；
6. `MODEL_CATALOG_JSON` 中至少有一个模型被 `MODEL_PROVIDER_KEYS_JSON` 映射为托管模型。

### 4.4 构建并启动

```bash
docker compose config -q      # 先校验 compose 与 .env 引用
docker compose up -d --build
docker compose ps             # 确认 app 与 bff 均为 running/healthy
```

BFF 容器内 SQLite 文件位于 `/var/lib/canvas-bff/canvas.sqlite`，由命名卷
`canvas-bff-data` 持久化。**该卷必须跨重启、重建、回滚保留**，否则会话与计费任务状态丢失。

### 4.5 健康检查验证

```bash
# Nginx 健康检查（转发到 BFF）
curl --fail https://canvas.example.com/health

# 匿名访问业务路由应 401/重定向到登录
curl -i https://canvas.example.com/api/models   # 期望 401

# 容器级健康
docker compose ps
```

浏览器验证：打开 `https://canvas.example.com`，未登录访问业务页面应跳转
`/login?returnTo=...`；用 Flarum 账户授权后应回到原目标页面，右上角账户菜单显示论坛用户名
与服务端返回的钱包余额。

---

## 5. HTTPS 与生产加固

- **TLS 终止**：Compose 内 Nginx 监听 `3000`（HTTP）。生产环境在它前面放置 TLS 反向代理
  （Caddy / Traefik / Nginx + certbot），把 `80/443` 转发到 `127.0.0.1:3000`，并透传
  `X-Forwarded-Proto: https`。`APP_ORIGIN` 填公网 HTTPS origin，BFF 据此给会话 cookie 设置
  `Secure`、`HttpOnly`、`SameSite=Lax`。
- **密钥管理**：`.env` 用 `chmod 600`；OAuth client secret、bridge token、provider key 一律
  不得写入 `VITE_*`、`config.js`、镜像构建参数、浏览器存储或任何日志。
- **日志脱敏**：Nginx 访问日志只记录方法 + 规范化路径（见 `nginx.conf`），BFF 结构化日志
  自动脱敏 code/state/token/密钥；不要改用会回显完整请求 URL 的错误日志。
- **限流**：`/auth/login` 与 `/auth/callback` 按客户端 IP 共享固定窗口限流（默认 60s/20 次），
  超出返回 `Retry-After` 且不创建 OAuth 事务。
- **单实例限制**：BFF 的 SQLite 不是多写者存储，第一版**只部署单个 BFF 实例**。如需水平
  扩展，必须在网关或共享存储实现等价的会话/限流/计费协调后再评估。
- **论坛 debug**：Flarum 生产必须关闭 debug mode，并验证错误输出脱敏。

---

## 6. 运行运维

### 6.1 目录改价

改价前先发布**新的 `priceVersion`**，然后仅重建 BFF：

```bash
# 修改 .env 中 MODEL_CATALOG_JSON 的 priceVersion 与 price
docker compose up -d --no-deps --force-recreate bff
```

目录在启动时被规范化、哈希并持久化为不可变的 SQLite release；恢复曾发布过的配置会重新
激活既有 release 并记录 `reactivated` 事件，内容不变不会产生重复 release。正在进行的任务
仍锁定其下单时的 `priceVersion`，不会跨版本重算或重复扣费。

### 6.2 密钥轮换

- **OAuth client secret**：在 Flarum OAuth Center 与 `.env` 中同步更新，再重建 BFF。
- **BRIDGE_TOKEN**：同步更新 Flarum 设置键 `popoopendoor-canvas-money-bridge.service-token`
  与 `.env` 中的 `BRIDGE_TOKEN`，再重建 BFF；两者不一致时新钱包请求被拒绝，不会出现
  无账本记录的扣费。
- **provider key**：更新 `.env` 的 `MODEL_PROVIDER_KEYS_JSON`，重建 BFF。

### 6.3 对账

`pending_reconciliation` 是冻结态，不是重试队列。BFF 绝不自动重放 provider、capture 或
release。运维需先在 provider 控制台确认结果，再进入 BFF 容器执行：

```bash
# 列出非终态任务
docker compose exec bff node dist/reconcile.js --list

# 确认 provider 成功：完成既有 hold 的 capture
docker compose exec bff node dist/reconcile.js --task TASK_ID --action capture

# 确认 provider 失败：release 既有 hold
docker compose exec bff node dist/reconcile.js --task TASK_ID --action release
```

命令只接受 `pending_reconciliation` 任务；capture/release 走 bridge 的幂等账本接口，
可在进程中断后安全重跑。不要直接改 `model_tasks` 表或 bridge 账本，不要重试 provider，
不要对未知结果自动退款。

### 6.4 回滚

- 停止新建模型任务，**保留 `canvas-bff-data` 卷**，用旧 BFF 镜像重建；在途任务在启动时
  标记为 `pending_reconciliation`，不会被重放。
- 回滚不删除卷、不改写 bridge 账本历史；需要补偿的未知任务按 6.3 人工确认后执行。

### 6.5 备份

至少备份 `canvas-bff-data` 卷（会话、目录 release、任务、计费关联、对账记录）。Flarum 侧
的 `users.money` 与 `canvas_money_ledgers` 由论坛自身的数据库备份策略覆盖。

---

## 7. 常见问题排查

| 现象 | 排查方向 |
| --- | --- |
| BFF 启动即退出 | 生产 fail-closed：检查 `.env` 是否 HTTPS、`OAUTH_REDIRECT_URI` 是否精确等于 `/auth/callback`、目录是否至少映射一个托管模型；看 `docker compose logs bff` |
| 登录跳转 `/login/error?reason=oauth_denied` | 用户在授权页拒绝了；属正常拒绝路径（需 OAuth Center fork 的修复） |
| `/login/error?reason=rate_limited` | 触发限流，稍后重试；检查共享 IP 下是否有大量登录尝试 |
| `/login/error?reason=oauth_unavailable` | 上游 OAuth 失败（HTTP 200 里带 error / 超时 / 用户 JSON 非法）；检查论坛 OAuth Center、HTTPS、`FLARUM_INTERNAL_BASE_URL` |
| 登录后余额显示「服务不可用」 | `BRIDGE_URL`/`BRIDGE_TOKEN` 或 Flarum 设置键不一致；`curl` 测试 bridge 路由（带 `X-Canvas-Bridge-Token`） |
| 扣费 409 `insufficient_balance` | 积分不足；bridge 不四舍五入，非整数/历史小数余额会返回 `wallet_balance_is_not_a_non_negative_integer`，需运营先迁移为整数 |
| 模型任务 `pending_reconciliation` | provider/钱包结果未知；按 6.3 人工对账，不要自动退款 |
| 托管模型不出现 | 确认目录 ID 已在 `MODEL_PROVIDER_KEYS_JSON` 映射，且 `GET /api/models` 正常返回 |

直接测试 bridge 路由（在论坛服务器本地执行，用于验证服务令牌）：

```bash
curl -sS -X POST https://forum.example.com/api/canvas-money/balance \
  -H 'X-Canvas-Bridge-Token: <BRIDGE_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"userId": 1}'
```

---

## 8. 数据与安全边界（必读）

- 登录、退出、切换账户**不删除**浏览器本地画布、素材、提示词、模型配置、WebDAV 与 Agent
  数据；不同 Flarum 账户在浏览器内共享同一本地命名空间（无账户级隔离）。
- OAuth access/refresh token 不落库、不下发浏览器；会话 cookie 仅含随机 opaque ID。
- 会话空闲 3 天、绝对 30 天后过期，BFF 重启保留未过期会话；退出即时撤销。
- 金额均为非负整数（`1 money = 1` 积分），余额最低为 0，bridge 拒绝小数/截断。
- 通过 Canvas UI/Agent/插件发起的模型请求必须经过 BFF 计费授权；未接入契约的脚本会被
  明确拒绝执行。用户在 Canvas 之外自行运行 provider/Agent/插件不属本系统控制范围。

更多 BFF 契约、会话与计费行为见 [`server/README.md`](server/README.md)；
bridge 独立安装说明见 [`bridge/README.md`](bridge/README.md)；
OAuth Center fork 说明见 [`oauth-center/README.md`](oauth-center/README.md)。
