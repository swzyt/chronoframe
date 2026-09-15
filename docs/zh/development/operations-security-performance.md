# 运维、安全、性能与成本手册

## 1. 生产拓扑建议

```text
Internet
  HTTPS reverse proxy
    Node/Nuxt :3000          # 唯一公网应用入口、SSR、fallback、控制面
      Go API :8080           # 仅容器网络/loopback
      Redis :6379            # 禁止公网暴露
      SQLite /app/data/...   # 持久卷
      Object storage         # Local / private S3-COS / OpenList
```

Go 端口不应直接暴露给浏览器。若为诊断临时绑定 `127.0.0.1`，也必须通过 SSH 隧道或本机访问。

## 2. 配置矩阵

### 必需且必须持久稳定

| 配置                               | 作用                    | 生产要求                         |
| ---------------------------------- | ----------------------- | -------------------------------- |
| `DATABASE_URL`                     | SQLite 路径             | 指向持久卷；Node/Go 必须相同     |
| `NUXT_SESSION_PASSWORD`            | 登录 session 和兼容签名 | 至少 32 位随机值；升级时不得改变 |
| `NUXT_OG_IMAGE_SECRET`             | 分享预览媒体签名        | 至少 32 位随机值；Node/Go 相同   |
| `CFRAME_REDIS_URL`                 | Redis 地址              | Node/Go 指向同一实例             |
| `CFRAME_REDIS_PASSWORD` 或 `_FILE` | Redis 凭据              | 使用 secret 管理；不得提交仓库   |
| `CFRAME_GO_UPSTREAM`               | Node 到 Go 的内部地址   | 容器中通常为 `http://go:8080`    |

### 执行权

| 配置                          | 合法值                 | 规则                                                                       |
| ----------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `CFRAME_DB_MIGRATOR`          | `node` / `go` / `none` | 整个部署只有一个 migrator；Go 常用 one-shot migrator                       |
| `CFRAME_PIPELINE_CONSUMER`    | `node` / `go` / `none` | 整个部署只有一个媒体 consumer                                              |
| `CFRAME_BACKUP_SCHEDULER`     | `node` / `go` / `none` | 整个部署只有一个 scheduler                                                 |
| `system.backend.readProvider` | `node` / `go`          | 历史名称保留；当前会切换 registry 内全部读写 route；切 Go 前强制 readiness |

### Go 运行参数

| 配置                                         | 默认/示例        | 用途                                          |
| -------------------------------------------- | ---------------- | --------------------------------------------- |
| `CFRAME_GO_ADDR`                             | `:8080`          | Go 监听地址                                   |
| `CFRAME_GO_PIPELINE_WORKER_COUNT`            | `1`              | 媒体 worker 数；SQLite/CPU/内存有限时保守设置 |
| `CFRAME_GO_PIPELINE_POLL_INTERVAL`           | `3s`             | queue 轮询间隔                                |
| `CFRAME_GO_MEDIA_TOOL_PREFLIGHT`             | enabled          | readiness 检查媒体工具                        |
| `CFRAME_GO_BACKUP_SCHEDULE_REFRESH_INTERVAL` | `1s` in lab      | 备份配置刷新；生产可适当增加                  |
| `CFRAME_HTTP_*_TIMEOUT`                      | runtime defaults | HTTP 读写、idle 和 header 超时                |
| `CFRAME_SHUTDOWN_TIMEOUT`                    | runtime default  | 优雅退出上限                                  |

### 存储与公开配置

存储 provider 优先由后台 `settings_storage_providers` 管理。环境变量适合作为 bootstrap/fallback。S3/COS bucket 应保持私有，媒体由 ChronoFrame 鉴权代理返回。`NUXT_PUBLIC_*` 会进入客户端 bundle，只能放真正公开的地图 token、站点展示默认值，不能放 secret。

## 3. 标准发布与回滚 Runbook

### 发布前

```bash
pnpm lint
pnpm contracts:check
pnpm test:go
pnpm build
pnpm docs:build
```

对双后端改动至少再运行：

```bash
pnpm dual:config:go-primary
pnpm dual:verify-all:container
```

### 部署

1. 记录当前容器 image digest、环境文件 checksum、数据库大小和健康状态。
2. 创建 SQLite 备份，并确认文件非空、可读取。
3. 拉取固定 SHA tag；验证后再使用 `latest`，不要把 `latest` 当作唯一回滚坐标。
4. 若有 migration，先以唯一 migrator 完成，再启动 API/worker。
5. 重建容器但复用原 `.env` 和 `/app/data` 挂载。
6. 检查 Node health、Go `/health/ready`、Redis PING、首页和登录。
7. 验证数据库里的 `app:title` 等设置没有被环境默认值覆盖。

### 回滚

1. API 行为异常时先把 `backend.readProvider` 切回 `node`。
2. 镜像异常时重建为部署前记录的 digest。
3. migration 只在明确支持向下兼容时回滚应用；不要直接用旧二进制写入未知新 schema。
4. 数据损坏时停止所有 writer，恢复 SQLite 与对应对象存储版本，然后再启动单一 migrator/consumer。

## 4. 健康检查与观测

| 信号                | 正常条件                                          | 异常意义                                   |
| ------------------- | ------------------------------------------------- | ------------------------------------------ |
| Node session health | `/api/_auth/session` 返回可接受响应               | Nuxt/Nitro、DB 或 session 初始化异常       |
| Go liveness         | `/health/live` 成功                               | 进程存活                                   |
| Go readiness        | status ready；database/mediaTools/redis 为 ok     | 只有 readiness 通过才允许切换              |
| Backend status      | Node 控制面显示实际 provider 和 Go 状态           | 配置/网络/版本不一致                       |
| Queue               | pending 可下降、failed 可诊断、claim 会过期回收   | worker 停止、工具缺失、存储不可读          |
| Redis               | PING、无 eviction、连接稳定                       | session/资格/限流/lease 退化或 fail closed |
| Media               | thumb/display/original 的状态码、Range 和缓存命中 | key、权限、provider 或 CDN 配置异常        |

建议日志始终携带 request id、backend id/version 和 task id。不要记录密码、session Cookie、上传明文 token、S3 secret 或完整私有对象 URL。

## 5. 常见故障决策表

| 症状                      | 优先检查                                                                | 处理方向                                        |
| ------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| 登录后刷新又回登录页      | 固定 `NUXT_SESSION_PASSWORD`、Redis、`auth_version`、Cookie Secure/域名 | 恢复一致密钥和代理协议头；确认用户仍启用        |
| 页面首屏无数据、刷新出现  | SSR 与 hydration 使用的 access/session 状态、provider 响应差异          | 保证服务端和客户端共用资格状态及刷新策略        |
| 图片 500/原图失败         | DB key、provider 配置、对象存在、Range 读取                             | 用受保护媒体 route 定位，不暴露临时直链         |
| 分享预览无原图            | `NUXT_OG_IMAGE_SECRET`、签名 URL、容器内回源、字体与渲染日志            | 保持密钥一致，验证 `/og-media` 能从渲染进程访问 |
| 上传一直“处理中”          | 每个文件的 task id、queue owner、failed error、worker lease             | UI 按全部任务终态聚合；修复 worker/工具链后重试 |
| `mkdtemp /tmp/... ENOENT` | 容器 `/tmp` 是否存在且可写                                              | 镜像创建 `/tmp`，运行用户具备权限               |
| 地球仪卡顿                | 可见照片数量、marker 聚合、纹理尺寸、重复 fetch                         | 分层加载、复用纹理、降采样和视锥裁剪            |
| 实例名称恢复 ChronoFrame  | DB 设置、env 中 `NUXT_PUBLIC_APP_TITLE`、初始化覆盖逻辑                 | 生产设置以 DB 为准，移除持续覆盖的环境默认值    |
| 切到 Go 后接口异常        | `/health/ready`、route registry、共享密钥/DB/Redis/storage              | 立即切回 Node，再执行对应差分脚本               |

## 6. 安全模型

### 资产与信任边界

- 高敏感：用户密码哈希、session/OG secret、存储凭据、SMTP 凭据、访客上传 token。
- 私有数据：原图、视频、隐藏相簿、EXIF/GPS、对象 key。
- 公共但受策略约束：非隐藏照片、相簿、缩略图、反应统计。
- 外部边界：浏览器、OAuth、地图/逆地理编码、S3/COS/OpenList、SMTP/CDN。

### 主要威胁与控制

| 威胁                    | 控制                                                         |
| ----------------------- | ------------------------------------------------------------ |
| 跨用户读取/修改         | 服务端 owner filter；管理员角色从 DB 实时确认；越权 404      |
| 猜测访问密码            | 后端哈希校验；同来源 15 分钟 5 次；429；签名 HttpOnly Cookie |
| 上传 token 泄露/滥用    | token hash、启用/过期/配额检查、原子消费、仅授予上传能力     |
| 直连对象绕过权限        | 私有 bucket；不返回底层 key/长期 URL；统一媒体代理           |
| Session 在部署后失效    | 固定随机密钥；SameSite=Lax；生产 HTTPS 下使用 Secure Cookie  |
| 双 worker 重复副作用    | 单 owner 配置、Redis runtime lease、SQLite claim fencing     |
| SSRF/危险 provider 配置 | 管理员专属配置；限制协议和地址；敏感字段不回显、不记录       |
| 恶意媒体文件            | MIME/魔数/大小校验；媒体工具 timeout；临时目录隔离和清理     |
| Secret 进入前端         | secret 禁止使用 `NUXT_PUBLIC_*`；API 响应脱敏                |

## 7. 性能与成本

| 路径            | 已采用策略                            | 继续观察                                    |
| --------------- | ------------------------------------- | ------------------------------------------- |
| 列表            | 缩略图、分页/预览额度、按更新时间索引 | 响应 payload、N+1 相簿/owner 查询           |
| 详情            | 展示图优先，原图仅在需要时加载        | 切图闪烁、预加载窗口、移动端显存            |
| 视频/Live Photo | 派生 H.264、poster、Range             | 转码 CPU、临时磁盘、热点视频带宽            |
| S3/COS          | 多尺寸派生、条件请求、缓存头          | CDN 回源率、跨区域流量、对象请求费          |
| 地图/地球仪     | 专用坐标 API、可见集限制              | marker 聚合、纹理复用、逐帧分配和 draw call |
| Queue           | 异步解析、可重试、可配置 worker 数    | SQLite 写锁、CPU/内存峰值、积压时间         |
| Redis           | 共享 session/资格/lease；noeviction   | key 数量、TTL、连接失败和持久化 I/O         |

成本优先级通常是：避免列表加载原图 > 提高 CDN/浏览器缓存命中 > 控制视频转码和出网 > 减少重复对象请求。对象存储图片处理参数可以作为补充，但不能替代私有对象鉴权、跨 provider 一致性和可预测的派生尺寸缓存。

## 8. 容量与并发建议

- SQLite 单实例部署从 `worker count=1` 起步，先观察任务耗时和写锁，再增加并发。
- 为 `/app/data`、`/tmp` 和对象存储分别设置监控；转码时临时空间可能大于源文件。
- Redis 使用 `noeviction`，避免悄悄删除 session 或 runtime lease；内存不足应告警并扩容。
- 反向代理允许媒体 Range，并为 API 与大媒体配置不同的 timeout/body size。
- CDN 只缓存可安全共享的派生媒体响应；包含用户私有授权差异的响应不能使用公共缓存键。

## 9. 已知限制与风险登记

| 风险                                                          | 当前状态                   | 退出条件                                            |
| ------------------------------------------------------------- | -------------------------- | --------------------------------------------------- |
| Node 仍是公网和 SSR 必需入口                                  | 架构约束                   | Go 独立承载 UI/API 且具备等价回滚控制面             |
| 89 个 operation 中 1 个固定 Node 控制面                       | 有意保留                   | 不建议迁移，除非重新设计 provider 控制面            |
| `backend.readProvider` 名称与“切换全部登记 route”的现状不一致 | 命名技术债                 | 兼容迁移为语义明确的 provider key，并完成旧设置升级 |
| 真实媒体 corpus 不可能被合成测试完全覆盖                      | 持续风险                   | 建立脱敏 JPEG/HEIC/MP4/Live/Motion 回归集           |
| 真实 COS/S3/OpenList 网络行为差异                             | 持续风险                   | 定期在真实 provider 执行上传、Range、缓存和删除验收 |
| SQLite 限制横向扩展和高写并发                                 | 当前产品取舍               | 业务规模需要多 writer 时引入服务型数据库并设计迁移  |
| Redis 中断影响 session/资格/lease                             | readiness/fail-closed 保护 | 增加生产高可用 Redis 和故障演练                     |
| 邮件备份不包含媒体对象                                        | 明确限制                   | 对象存储开启版本控制/生命周期和独立备份             |

## 10. 定期演练

- 每次发布：lint、契约、Node/Go 测试、构建、关键浏览器路径。
- 每月：从邮件/磁盘备份恢复到隔离实例，核对用户、照片、相簿和设置。
- 每季度：Redis 中断、Go 不可达、worker kill、磁盘不足、对象存储超时演练。
- 存储 provider 或媒体工具升级：重新跑 S3/OpenList、media-read、media-parity、upload-pipeline 和 share-og 套件。
