# API 迁移矩阵与双后端切换

> 基线：`backend/contracts/routes.yaml` version 1。本文是阅读指南，route registry 和 OpenAPI 才是可执行的权威事实。

## 1. 当前结论

当前 registry 共登记 **89 个 HTTP operation**：

- 88 个 operation 的 Go 实现标记为 `verified`；
- 88 个 verified operation 都存在于运行时 `GO_API_ROUTES`；选择 Go 后，这些读写请求都会由网关转发；
- 其中 27 个只读 operation 额外标记为 `userSelectable/allowCompare/allowShadow`，供差分和 shadow 工具使用；
- 55 个 operation 有数据库、存储、会话、队列、网络或外部系统副作用，因此不允许 compare/shadow，但仍会随全局 provider 一起切到 Go；
- `/api/system/backend/status` 固定由 Node 控制面提供，不属于 Go 业务接管范围。

“Go 已验证”不等于请求会自动直接访问 Go。浏览器仍只访问 Node 公网入口，Node 网关根据 route registry 和 `system.backend.readProvider` 决定是否转发。

```text
browser request
  Node 01.backend-dispatch middleware
    route is absent from GO_API_ROUTES -> Node
    route is registered
      provider=node -> Node
      provider=go
        Go ready -> proxy to CFRAME_GO_UPSTREAM
        Go unavailable -> request fails visibly; operator switches back to Node
```

## 2. 能力矩阵

| Capability             | Operations | Go 状态                           | 可切换只读 | 主要验证入口                                                              |
| ---------------------- | ---------: | --------------------------------- | ---------: | ------------------------------------------------------------------------- |
| `access-control`       |          4 | 4 verified                        |          2 | `dual:verify-access-control:container`                                    |
| `albums-read`          |          3 | 3 verified                        |          3 | `dual:verify-albums:container`                                            |
| `albums-write`         |          6 | 6 verified                        |          0 | `dual:verify-albums:container`、`dual:verify-mutations:container`         |
| `backend-runtime`      |          3 | 3 verified                        |          0 | `dual:verify-go-readiness:container`                                      |
| `backup-control`       |          1 | 1 verified                        |          0 | `dual:verify-backup:container`                                            |
| `identity`             |          6 | 6 verified                        |          1 | `dual:verify-identity:container`、`dual:verify-oauth:container`           |
| `media-read`           |          8 | 8 verified                        |          1 | `dual:verify-media-read:container`                                        |
| `media-render`         |          1 | 1 verified                        |          0 | `dual:verify-share-og:container`                                          |
| `photos-read`          |          5 | 5 verified                        |          4 | `dual:verify-photos-read:container`                                       |
| `photos-write`         |          6 | 6 verified                        |          0 | `dual:verify-photos-write:container`                                      |
| `pipeline-control`     |          8 | 8 verified                        |          3 | `dual:verify-queue-control:container`                                     |
| `reactions-read`       |          2 | 2 verified                        |          2 | `dual:verify-reactions:container`                                         |
| `reactions-write`      |          2 | 2 verified                        |          0 | `dual:verify-reactions:container`                                         |
| `settings-control`     |         11 | 11 verified                       |          6 | `dual:verify-settings-control:container`                                  |
| `settings-public-read` |          1 | 1 verified                        |          1 | `dual:compare:container`                                                  |
| `setup`                |          7 | 7 verified                        |          0 | `dual:verify-wizard:container`                                            |
| `system-observability` |          3 | 2 verified + 1 Node control plane |          1 | `dual:verify-system-reads:container`、`dual:verify-system-logs:container` |
| `upload-shares`        |          8 | 8 verified                        |          2 | `dual:verify-upload-shares:container`                                     |
| `users-admin`          |          4 | 4 verified                        |          1 | `dual:verify-admin-users:container`                                       |

## 3. 鉴权分类

| Auth contract          | 数量 | 含义                                                           |
| ---------------------- | ---: | -------------------------------------------------------------- |
| `admin`                |   27 | 每次从数据库确认用户仍启用且仍为管理员                         |
| `user-owner`           |   17 | 登录用户只能操作本人资源，管理员可跨 owner                     |
| `preview`              |   14 | 登录用户或已验证匿名访客完整访问；未验证匿名访客受预览额度限制 |
| `setup-only`           |    7 | 只允许未完成初始化的实例使用                                   |
| `anonymous`            |    6 | 不要求登录，但仍可受限流和输入校验保护                         |
| `public-or-user-owner` |    5 | 公共内容可读；隐藏或后台数据要求 owner/管理员                  |
| `session`              |    4 | 依赖有效登录会话                                               |
| `user`                 |    3 | 任意启用的登录用户                                             |
| `oauth-callback`       |    1 | GitHub OAuth 回调专用                                          |
| `signed-media-token`   |    1 | 仅接受服务端签发、短生命周期的媒体签名                         |
| `upload-token`         |    4 | 仅接受有效、启用、未过期且未超额的访客上传 token               |

## 4. 迁移状态语义

| 字段                   | 约束                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `maturity.node=stable` | Node 是当前稳定行为基线                                                                          |
| `maturity.go=verified` | Go 已通过对应契约和场景验证，不表示所有生产故障模式均已覆盖                                      |
| `userSelectable=true`  | 该只读 operation 可进入专用选择/比较工具；全局 Go provider 的实际转发范围由 `GO_API_ROUTES` 决定 |
| `allowCompare=true`    | 测试工具可以对 Node/Go 响应进行归一化差分                                                        |
| `allowShadow=true`     | 只读请求可以安全用于 shadow；不得用于有副作用的写请求                                            |
| `owner=node`           | registry 的默认稳定 owner，不会被前端参数覆盖                                                    |

## 5. 切换与回滚

切到 Go 前：

1. 保持 Node、Go、Redis 使用相同的 `DATABASE_URL`、会话密钥和对象存储配置。
2. 执行 `pnpm dual:verify-go-readiness:container`。
3. 执行 `pnpm dual:verify-switch:container` 和目标业务域验证。
4. 在后台保存 `system.backend.readProvider=go`。虽然名称保留了历史上的 `readProvider`，当前动作会切换 `GO_API_ROUTES` 中全部读写接口。Node 会先调用 Go `/health/ready`，要求 database、Redis、媒体工具链均为 `ok`。
5. 观察 `/api/system/backend/status`、日志和关键页面。

回滚只需要把 `system.backend.readProvider` 改回 `node`。不要让前端携带 provider 参数，也不要让 Nginx/Caddy 根据客户端输入选择后端；否则会绕过 registry、权限和回滚控制面。

## 6. 新增或迁移 route 的完成定义

- Node 行为、Go 行为和 OpenAPI 使用同一 method/path。
- `routes.yaml` 填写 capability、auth、sideEffect、maturity 和选择策略。
- `pnpm contracts:check` 通过，不存在未登记或无实现的 route。
- 只读接口先通过 fixture 差分，再允许 compare/shadow/user selectable。
- 写接口必须验证失败回滚、owner 隔离、幂等或重复提交行为。
- 媒体接口必须覆盖 GET/HEAD、Range、条件请求、缓存头和权限拒绝。
- 改动同时更新本文矩阵、OpenAPI 和对应验收脚本。

## 7. 权威文件

- `backend/contracts/routes.yaml`：operation 所有权和成熟度。
- `backend/contracts/openapi.yaml`：请求与响应结构。
- `backend/nodejs/utils/backend-routing.ts`：运行时 Go route registry 与 provider 解析。
- `backend/nodejs/middleware/01.backend-dispatch.ts`：公网入口分流。
- `scripts/verify-route-contract.mjs`：契约完整性校验。
- `scripts/compare-backends.mjs`：Node/Go 只读差分。
