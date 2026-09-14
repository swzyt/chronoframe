# ChronoFrame Node.js + Go 双后端并存：技术设计

> 状态：已实现同仓库独立 Go API、共享 SQLite/Redis/对象存储、Node 网关切换和已登记 Go-capable operation 的读写路径；本地双栈默认使用 Docker named volume 承载共享 SQLite/WAL，并提供容器化 fixture seed；Go SQLite 层已切换为 CGo 原生 SQLite driver；Go one-shot migrator 已能复用同一份 Drizzle SQL ledger 从空库启动，并初始化同一份默认 settings metadata；Go readiness 已覆盖 SQLite schema preflight、Redis ping 和媒体工具链 preflight，并已纳入网关 runtime 路由与 Go 服务直连双面容器验收；Go wizard/admin/site/storage/map/submit 已按 Node zod schema 的必填字段、provider union、storage 默认值和首个用户冲突规则收紧；Go 后台用户管理已对齐 email 规范化、用户 CRUD 和最后活跃管理员保护；Go 照片上传准备、S3 非 COS 预签名直传 URL、内部对象 PUT、默认 MIME 白名单/最大文件限制、重复检测、对象上传授权、公开上传分享 Key/授权和队列入队 payload 规范化已对齐 Node 的共享 storage key/prefix 语义；Go Local provider 写入已接入请求 context，取消/中断时只清理临时文件、不发布半成品且不覆盖旧对象；Go S3/OpenList 上传 body 也通过 context-aware reader 传播取消，避免请求取消后继续从上游读取完整 payload；`dual:verify-route-boundaries:container` 已在 85 条 Go-capable 非 runtime HTTP operation 上固定匿名/空 body 基础边界差分；`dual:verify-upload-pipeline:container` 已在 Go consumer owner override 下验证本地 PNG 的 Go prepare → PUT → 入队 → consumer 消费 → photo/缩略图/display 生成 → media GET/HEAD 读回链路，并覆盖 Node/Go 公开上传分享匿名 prepare/PUT/task → Go consumer → Go photo 读回、`upload_count/last_used_at` 落库与 `maxUploads` 耗尽后 429 拒绝；`dual:verify-queue-control:container` 已通过临时 SQLite 队列行验证 Node/Go targeted retry、Go batch retry、跨端 stats 读回、invalid clear 400、安全 no-op clear，以及 SQLite 前置保护后的真实 clear 删除响应一致；`dual:verify-all:container` 已加入本地 Compose `Node owner → Go owner → Node owner` 的 pipeline consumer 回切阶段；`dual:verify-backup:container` 已通过 fake SMTP 验证 Node/Go 手动 database backup 都能生成加密 SQLite 备份附件并返回一致字段；`dual:verify-go-backup-scheduler:container` 已在 Go scheduler owner override 下验证定时备份邮件由 Go 容器发出、附件可解密为 SQLite、Node scheduler 被 owner 配置跳过；`dual:verify-redis-outage:container` 已受控停止/启动 Redis，固定 Node/Go 私有请求一致 fail closed、公开读取维持、readiness 降级和 AOF session 恢复；Go pipeline consumer 已支持普通图片导入、HEIC 转 JPEG、Live/Motion Photo、MP4 视频处理、反向地理编码和位置擦除切片，并通过 Redis runtime lease 与 Node consumer 做启动互斥，启动期遇到残留 lease 会等待重试；生产维护窗口、其余故障注入和全量真实媒体迁移演练仍需继续验证
> 关联文档：[双后端学习模式 PRD](/zh/development/dual-backend-product)
> 适用目标：Node.js/Nuxt 与 Go 长期并存，共享 SQLite、Redis 与对象存储
> 基线日期：2026-09-14

Pipeline consumer 的正常退出协议已在两端实现：先停止新 claim，在继续持有并刷新 runtime lease 与 task-row lease 的前提下排空在途任务，排空后才主动释放 owner lease。Node drain 超时会保留 runtime lease 直到进程退出/TTL 到期；Go 的进程退出 context 只停止 claim，不取消已领取任务，runtime lease 丢失才会取消任务 context。Go 行为测试和 Node 源级回归测试已固定这一顺序；真实长任务、kill -9、磁盘满和部署维护窗口仍属于后续故障注入范围。

## 1. 结论先行

推荐方案是“单一入口、两套实现、共享状态、能力级唯一写 owner”：

1. Nuxt/Node 保持现有 SSR 和稳定后端能力。
2. 新建一个 Go 模块化单体，不拆微服务。
3. 网关是唯一公网入口，Node 与 Go 端口只在内部网络开放。
4. 正常模式下，网关按 `HTTP method + path` 把请求完整交给一个后端。
5. SQLite 是业务数据真相，Redis 是跨进程会话、限流与失效协调层，对象存储保存媒体。
6. 禁止双写、双 migration、双 queue consumer 和双 scheduler。
7. compare/shadow 只对经过证明的纯读请求开放，并从基础设施层禁止写入。
8. Go 完成度提高后，只改变对应 capability 或 route 的 owner/registry；Node 不删除、不退役。

最重要的边界不是“两个服务都能连同一个库”，而是：

> 共享数据不等于共享执行权。任何可能产生副作用的能力，在同一时刻必须只有一个生产 owner。

### 1.1 实现状态

队列 `priority` 与 `maxAttempts` 在 API 层保持 Node 的 `z.number().min().max()` 语义，允许范围内小数。Go 的任务模型、SQLite scan/insert 与重试阈值比较统一使用 `float64`，从而兼容 SQLite `INTEGER` affinity 下实际保存为 `REAL` 的 Node 数据；容器验证同时覆盖单条/批量任务的 Node 写→Go 读和 Go 写→Node 读，并核对批量默认值及单任务覆盖值。

后台用户更新使用 raw JSON decoder 重现 Node 的可选字段、未知字段剥离、空对象 refine、email 校验后再 trim/lowercase、username trim 后 UTF-16 长度，以及 password/boolean 的 Zod issue 顺序。路由参数按 `z.coerce.number().int().positive()` 接受 `42.0`/科学计数法形式，非法值保持 Node 当前未捕获 ZodError 的 500 `Server Error` 形状。

当前代码已经包含：机器可读 route/OpenAPI/schema contract、Go 模块化单体、共享 SQLite/Redis Compose、Node/Go metadata、Node 网关分流中间件、管理后台 provider 开关，以及 `backend/nodejs/utils/backend-routing.ts` 中的显式 `GO_API_ROUTES`。管理员选择 `system:backend.readProvider=go` 后，登记且标记 `maturity.go` 的 GET/POST/PUT/PATCH/DELETE operation 会直接代理到 Go；切换设置本身保持 Node-owned。分流中间件读取 `system:backend.readProvider` 时绕过普通 settings L1 缓存并直读 SQLite，避免刚切回 Node 后下一跳仍被旧 TTL 值代理到 Go。

Go 当前已接入共享身份、访问授权、GitHub OAuth callback、后台用户管理、相册/照片 CRUD、反应、队列任务读写、queue stats 共享 telemetry/本地 worker stats、settings、storage config、upload share、wizard、system stats、logs SSE、手动 database backup、Go database backup scheduler、Go `photo` / `live-photo-video` / `video` / `photo-reverse-geocoding` / `photo-erase-location` pipeline consumer、Local/S3/OpenList 存储，以及 display/thumb/share image 等基础图片变换。Node 与 Go 仍共享同一 SQLite WAL、Redis key contract 和对象 Key；默认双栈仍由 Node 执行 migration，Go API 进程只校验 schema；显式使用 `CFRAME_DB_MIGRATOR=go` + `CFRAME_GO_MIGRATE_ONLY=true` 时，Go 可作为 one-shot migrator 复用生成出的 Drizzle SQL bytes 初始化空库并写入同一份 `__drizzle_migrations` ledger。Go `/health/ready` 会在运行时暴露 SQLite schema preflight、Redis ping，以及 `exiftool`、`magick`、`vips`、`ffmpeg`、`ffprobe` 媒体工具链检查；`dual:verify-go-readiness:container` 会同时请求网关 runtime 路由和 Go 服务直连地址，防止 readiness 只在单一表面成立；`CFRAME_GO_MEDIA_TOOL_PREFLIGHT=false` 只应用于最小 JSON-only 实验或测试环境。Go settings 默认值由 `backend/nodejs/services/settings/contants.ts` 生成到 Go contract，启动时会插入缺失项并同步 metadata，保留现有 `value` 不覆盖。Go wizard 复用同一套校验和持久化 helper，覆盖 admin email/password/username、site title、Local/S3/OpenList storage config、Mapbox/MapLibre/AMap map config，并在已有首个用户但邮箱不匹配时与 Node 一样拒绝继续初始化。Go 后台用户管理会在 create/update 中做 Node 一致的 email trim/lowercase 规范化、基础字段校验、唯一冲突处理，并阻止降级或禁用最后一个活跃管理员。手动 database backup 已用 fake SMTP 验证 Node/Go 都能从共享 SQLite 生成 `CFDBENC2` 加密 gzip 备份附件并返回一致字段，Node 备份目录也已和 Go 对齐为支持 `CFRAME_BACKUP_DIR` 且默认 `data/backups`；Go scheduler owner 已用 `dual:verify-go-backup-scheduler:container` 在真实 Compose 网络中验证邮件由 Go 容器发出。backup scheduler 仅在 `CFRAME_BACKUP_SCHEDULER=go` 时运行，pipeline consumer 仅在 `CFRAME_PIPELINE_CONSUMER=go` 时 claim 已支持的 `photo`、`live-photo-video`、`video`、`photo-reverse-geocoding` 与 `photo-erase-location` 任务。共享 Redis 可用时，Node/Go pipeline consumer 都会先竞争 `cf:v1:<env>:lease:pipeline-consumer` runtime lease，并在运行中刷新 TTL；Go 启动期未拿到 lease 时会等待重试，避免快速重启后的残留 TTL 让 consumer 永久退出，运行中 lease 丢失则停止消费者。`deploy/dual` 的 Go metadata 是 `experimental + normal`，独立运行镜像仍保留 `sandbox` 安全默认值。

当前 85 个文件/框架 HTTP operation 都已标记 Go-capable，并由 `GO_API_ROUTES` 覆盖；测试会进一步解析 Go `http.ServeMux` 和 wrapper method，确保每条后台可切换到 Go 的 method/path 都有真实 Go mux 注册，同时严格校验 `/share-og/{photoId}.png` 这类参数后缀。`dual:verify-route-boundaries:container` 已对这 85 条 Go-capable 非 runtime operation 做匿名/空 body 基础边界差分，要求 Node/Go 的 status、content type、backend/request-id header、redirect、Set-Cookie 有无和规范化 body 一致，并已修齐 login/access verify 缺 body ZodError、匿名 session、logout 响应体与 reaction 缺参错误形状。

按能力深度门禁计，当前 88 条 Go-capable route 全部为 `verified`，`experimental` 为 0：4 条访问控制、6 条身份、3 条运行时、9 条相册、4 条后台用户、4 条照片表态、5 条照片读取、6 条照片写入、8 条队列控制、11 条设置控制、8 条媒体读取、8 条上传分享、2 条系统读取、1 条日志 SSE、1 条手动备份、7 条 wizard 和 1 条分享图路由均已完成各自的生产镜像专项验收。`verified` 表示该能力切片已通过当前成功、错误、跨运行时共享状态和清理门禁，但不等于对所有输入、外部依赖、负载与故障条件作出普遍的 `stable` 承诺。刻意保持 Node-only 的 `system.backend.status` 不属于 Go route，也不参与代理。

队列层已补齐 `pipeline_queue.available_at/claimed_by/claim_token/claim_expires_at`，Node 与 Go worker 的 claim、stage、complete、fail/retry 和 heartbeat 都使用任务行 token fencing。`dual:verify-authz:container` 已在 Compose tools 网络中固化 145 条代表性错误场景和 8 条成功响应（7 条 Live Photo 管理与 1 条普通用户 system stats）：匿名 401、普通用户 403、普通用户访问隐藏 display 派生媒体 404、访问保护开启时匿名访问预览外公开相册详情 401、设置路由参数校验 400、设置字段 query 校验/未知 namespace 404、重复 query 的 Zod/队列/上传错误语义、设置单项/批量 body 校验 400、空/null/malformed/尾随多段 JSON、相册创建/更新空值与缺失字段的 Zod detail、上传分享管理 create/update 的 null、类型、trim 后长度、整数上下界和非法/可转换路径校验、照片元数据更新的缺 body/null/字段类型/UTF-16 长度/标签/location/rating/畸形 JSON/空对象/空白 ID 校验、EXIF/LivePhoto 管理 action 校验、照片-相册关系 body/缺失资源校验、认证后照片上传准备空/null body 400、重复检测缺 body/null body Zod 校验、重复检测缺少全部输入时的 `data.title/data.message` 与 JSON 字段顺序、重复检测数组字段/元素类型 Zod 校验、公开上传分享 prepare/task 的 Zod 校验、公开上传分享 upload 缺 key 与不支持 MIME 校验、公开 reaction 缺失删除 404（Nitro 形状为 `statusMessage: "Server Error"`、`message: "Reaction not found"`）、照片更新缺失原图文件 404、缺失资源 404，以及普通用户 runtime 隐藏/照片统计 body 对比。

基础写操作 parity 已扩展到照片上传准备、内部对象 PUT、重复检测、公开 reaction create/update/delete、真实 local storage 对象上的照片元数据更新，以及后台用户 create/list/update/delete 的 Node↔Go 交叉写后读验证。Go 登录、访问密码、上传限制、对象 Key 授权、公开分享、队列 payload 和照片元数据写入均复用 Node 的业务边界；Local 写入使用临时文件和 request context，S3/OpenList 上传同样传播取消。照片删除现在由 Node 与 Go 一致清理原图、HEIC 转换 `.jpeg`、thumbnail、display、Live Photo video 和 video playback 对象。

`dual:verify-upload-pipeline:container` 已把本地 PNG 完整 Go 上传路径和 Node/Go 公开上传分享链路纳入容器验收，并通过 Node 网关与 Go lab 面的并发 task 请求证明单次分享额度只能被原子消费一次；`dual:verify-s3-storage:container` 进一步用真实 MinIO 验证两端预签名直传、共享 Go consumer、媒体字节 parity 与完整对象清理；`dual:verify-redis-outage:container` 已覆盖运行中 Redis 受控中断与恢复，确保共享身份不可用时两端私有请求使用同一 503 契约、公开读取维持且 AOF session 可恢复。`dual:verify-all:container` 会在 Go consumer 验收后恢复默认 Compose 栈，再验证 pipeline owner 回到 Node，覆盖共享 volume 下的 Node→Go→Node 回切。仍需继续扩展的严格等价项是更大的真实媒体 corpus、托管云 S3/CDN 与真实 OpenList、大文件/断点/异常重试、深层业务错误分支、EXIF list 标签字节级矩阵、超时/资源限制、Redis 网络分区/容量/AOF 损坏/failover，以及生产维护窗口与其余故障注入交接演练。

已登记 Go 路由不得再用 `501 Not Implemented` 暴露“代码还没写”的语义；如果运行时缺少必需依赖，响应应表达为服务配置不可用（如 `503 Service Unavailable`），并由 readiness/preflight 把该状态提前暴露。Go 单元测试会扫描注册 handler 源码，防止新的 `StatusNotImplemented` 分支回流到可切换后端。

## 2. 当前架构与双栈障碍

基线审计时，ChronoFrame 是一个 Nuxt 4 + Nitro `node_server` 单体：

- SSR、API、媒体代理、队列 worker、定时备份位于同一 Node 进程；
- SQLite 使用 better-sqlite3 + Drizzle；
- 图片处理使用 Sharp、heic-convert 和 ExifTool；
- 视频处理使用 FFmpeg/FFprobe；
- 存储支持 Local、S3、OpenList；
- 设置缓存、访问密码限流、storage manager、worker 状态均是进程内对象；
- 用户会话与站点访问资格是 H3 sealed Cookie，不在共享存储中。

当前 M0/M1 已把会话、站点访问资格和安全限流接入共享 Redis；Node 设置 L1 已从永久缓存改为默认 5 秒的有界 TTL，并通过共享 Redis `chronoframe:settings:version` 做跨进程主动失效：Node 写设置、Go 写设置都会递增该版本，Node 在读/写本地设置缓存前检测版本变化并清空本地 L1。`system:backend.readProvider` 不走这条普通 settings 缓存路径，网关分流会对该控制项直读 SQLite，以保证后台切换保存后的下一次已登记请求立即按新 provider 路由。storage provider 协议已覆盖 Local/S3/OpenList，Go 也能读取自己的日志文件，并可执行手动数据库备份和定时数据库备份；worker pool 状态通过 Redis telemetry 或 Go 本地 worker stats 暴露给 HTTP 接口，当 Go consumer 在本进程 active 时优先返回本地 Go stats，避免旧 Redis telemetry 遮蔽当前 owner。Go pipeline consumer 已具备 SQLite claim/retry/complete 基础设施，并能处理 `photo` 普通图片导入、HEIC 转 JPEG、`live-photo-video` 配对、`video` MP4 处理、Motion Photo XMP 提取、`photo-reverse-geocoding` 反向地理编码与 `photo-erase-location` 位置擦除任务；Node/Go consumer 已接入共享 Redis runtime lease 做进程级启动互斥，并已在 `pipeline_queue` 任务行上实现 token fencing、`available_at` 重试调度与 lease heartbeat。跨服务日志聚合、持久化 revision/outbox 和完整 worker 交接演练留在后续里程碑。

当前显式后端面包括：

| 范围             | 数量/形态                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/nodejs/api` | 70 个 handler 文件；route manifest 当前收敛为 89 个 HTTP operation（85 个 Go-capable 文件/框架意图 + 1 个 Node-owned 后端状态接口 + 3 个虚拟运行时路由） |
| 媒体路由         | `/image`、`/storage`、`/display`、`/thumb`、`/og-media`、`/share-og`                                                                                     |
| 框架认证路由     | `GET/DELETE /api/_auth/session`                                                                                                                          |
| 源代码目标业务表 | users、photos、pipeline_queue、photo_reactions、albums、album_photos、upload_shares、settings、settings_storage_providers                                |
| 数据库迁移       | Drizzle SQL ledger；Node 默认执行，Go one-shot migrator 可执行同一 SQL bytes                                                                             |
| 自动化测试       | 已形成 Node/Go 单测、route/schema contract、读差分、鉴权/错误差分、本地 Compose、Redis 受控中断/恢复和生产式浏览器 smoke；完整错误/故障矩阵继续扩展      |

按当前 route manifest 的鉴权入口分类，89 个 operation 为：

| 鉴权类别                                | 操作数 | Route manifest 要求                                |
| --------------------------------------- | -----: | -------------------------------------------------- |
| 管理员                                  |     27 | admin session + active/role recheck                |
| 登录用户或资源 owner                    |     20 | current user + owner scope                         |
| 公共/登录用户双语义                     |      5 | 同一路由显式记录 public/manage 分支                |
| 匿名、preview、token、setup、session 等 |     37 | 分别声明 token/preview/setup 条件，不能统称 public |

另外还有 6 条媒体路由和 `nuxt-auth-utils` 动态注册的 session 路由；这些也已在 manifest 中登记。M0 必须把每一项展开成机器可读 inventory，不能只保留数量。

当前 `GET /api/system/stats` 已使用共享 user-aware scope：管理员查看全局统计，普通用户只统计自己的照片；Node 侧测试会断言所有照片聚合都调用 `buildPhotoStatsWhere(user)`，Go 侧按 `owner_user_id` 条件生成同等聚合。Go 也已按 Node 成员视图隐藏 runtime 信息，普通用户固定看到 `uptime=0`、`runningOn=unknown`、零值 memory 与 `workerPool=null`；照片/存储/趋势聚合的 SQLite 错误返回 500，不再吞掉为 0。

下表记录的是基线审计发现，用于说明为何共享状态和执行权治理必须先行，并不表示这些问题当前仍全部存在：

| 状态            | 基线实现              | 双栈问题                                       |
| --------------- | --------------------- | ---------------------------------------------- |
| 用户 session    | 浏览器 sealed Cookie  | Go 需要复刻 H3/iron codec，且当前 payload 过大 |
| 站点访问授权    | 另一枚 sealed Cookie  | 两种实现容易产生不同版本判断                   |
| Settings cache  | 永不过期的 Node `Map` | Go 写库后 Node 可能一直读旧值                  |
| 访问密码限流    | Node `Map`            | 可通过切换后端绕过                             |
| Storage manager | Node singleton        | Provider 切换只在一个进程生效                  |
| Worker 状态     | Node global           | Go 无法知道真实 in-flight 状态                 |
| Backup cron     | Node 内存定时器       | 两边开启会重复执行                             |
| 日志文件        | Node 本地 append      | 两个进程无统一协议                             |

其中 session、access 和访问密码限流已完成 Redis 共享协议；Settings cache 已通过短 TTL + Redis shared version key 避免永久陈旧，并能覆盖 Go 写设置后 Node 立即读回旧缓存的窗口；网关 provider 开关是控制面例外，分流判断直读 SQLite，不受普通 settings TTL 窗口影响；持久化 revision/outbox 尚未完成。因此，Redis 和执行权治理仍是后续能力晋级的前置工作，而不是已经全部完成的生产能力。

## 3. 目标拓扑

```text
                           ┌──────────────────────────┐
Browser / API Client ─────►│ Gateway :3000           │
                           │ route ownership + TLS    │
                           └────────────┬─────────────┘
                                        │
                  页面 / SSR / Node API │ Go-owned API / media
                         ┌──────────────┴──────────────┐
                         ▼                             ▼
              ┌──────────────────┐          ┌──────────────────┐
              │ Nuxt / Node      │          │ Go modular       │
              │ Stable :3000     │          │ monolith :8080   │
              └───────┬──────────┘          └─────────┬────────┘
                      │                               │
          ┌───────────┴───────────────┬───────────────┴──────────┐
          ▼                           ▼                          ▼
   SQLite WAL                  Redis shared state        Local/S3/OpenList
   business truth              session/rate/invalidate   media objects
   same-host volume            private network           shared key contract
```

### 3.1 服务职责

#### Gateway

- 唯一公网端口；
- TLS、可信代理、请求大小与超时；
- 删除客户端伪造的内部身份和路由头；
- 按版本化 route manifest 选择 upstream；
- 添加统一 request ID 和后端标识；
- Go 不健康时执行显式路由切换，而不是静默重放写请求。

#### Node

- Nuxt SSR、静态资源和现有页面；
- 所有未被明确交给 Go 的 API；
- 默认 migration、全量 pipeline worker 和 Node backup scheduler owner；
- Go 行为的稳定基线；
- 与 Go 使用同一 Redis session 协议。

#### Go

- 模块化单体；
- 实现与 Node 相同的 HTTP contract，并直接读写共享 SQLite/Redis；
- 由管理员选择后成为已登记 operation 的 normal owner；
- 提供 health、metrics、版本和差异元数据；
- 默认不执行 migration 或 pipeline worker；仅在 `CFRAME_BACKUP_SCHEDULER=go` 时执行 backup scheduler，仅在 `CFRAME_PIPELINE_CONSUMER=go` 时消费已支持的 `photo`、`live-photo-video`、`video`、`photo-reverse-geocoding` 与 `photo-erase-location` 任务。

#### SQLite

- 用户、照片、相册、反应、队列、上传分享和设置的唯一真相；
- Node/Go 必须挂载同一主机上的同一数据卷；
- 不能放在 NFS、SMB 或跨主机网络卷上。

#### Redis

- opaque session；
- 站点访问授权；
- 登录、站点密码、reaction 等跨进程限流；
- 设置缓存和失效通知；
- route/session 短期协调；
- 后续可承载带 fencing 的 scheduler lease。

Redis 不保存唯一业务真相，也不替代 SQLite 任务队列表。

#### 对象存储

- 继续使用现有 Local/S3/OpenList；
- 两套实现遵循相同 Key 和授权规则；
- compare/shadow 使用只读 adapter；
- sandbox 使用独立 bucket 或前缀。

## 4. 运行模式的物理隔离

| 模式        | DB 权限             | Redis 权限                  | 存储权限    | 用户响应                  |
| ----------- | ------------------- | --------------------------- | ----------- | ------------------------- |
| normal/node | 读写                | 读写                        | 读写        | Node                      |
| normal/go   | 读写                | 读写                        | 读写        | Go                        |
| compare     | shadow backend 只读 | session 只读 + 独立诊断 ACL | shadow 只读 | 当前 owner                |
| shadow      | shadow backend 只读 | session 只读 + 独立诊断 ACL | shadow 只读 | 当前 owner，不等待 shadow |
| sandbox     | 独立 DB             | 独立 ACL/实例               | 独立前缀    | sandbox backend           |

只靠代码中的 `if dryRun` 不足以保证 compare/shadow 无副作用。应同时使用：

- 独立 shadow 进程或至少独立 DB pool，并逐连接设置 `query_only=ON`；
- read-only Storage 接口包装器；
- Redis 独立 ACL user，只允许读取 session 和写诊断 namespace；namespace 本身不是权限边界；
- 明确的路由白名单；
- CI 中的“请求前后数据快照一致”检查。

SQLite WAL 的 live read-only URI 和只读挂载行为必须按实际 driver 验证；如果不能证明在线隔离，differential test 使用 SQLite online backup 生成的快照。强保证场景使用独立 peer-shadow 服务，不能让同时持有 normal 读写连接的进程自称物理只读。

默认生产拓扑不启用 live compare/shadow，而是用 SQLite online backup snapshot 做离线 differential；M1 的在线对照仅限本地/测试环境。若要在生产启用 live compare/shadow，必须额外部署 `node-shadow` 和 `go-shadow`（按当前 primary 选择 peer），关闭它们的 migration/worker/scheduler，使用独立 `query_only=ON` pool、只读 Storage credential 和 shadow Redis ACL。基础 Compose 中没有这些服务，因此不能仅凭请求头把 normal 服务称为“物理只读”。

## 5. 路由所有权

### 5.1 Route manifest

仓库中的 `backend/contracts/routes.yaml` 是当前唯一真实清单。下面的片段展示当前已登记的公开照片读接口，以及一个已经具备 Go 实现、但仍按能力 owner 受控切换的写接口：

```yaml
version: 1
defaultReadOwner: node

routes:
  - id: photos.list
    method: GET
    path: /api/photos
    capability: photos-read
    owner: node
    maturity:
      node: stable
      go: experimental
    sideEffect: none
    allowCompare: true
    allowShadow: true

  - id: albums.create
    method: POST
    path: /api/albums
    capability: albums-write
    owner: node
    maturity:
      node: stable
      go: verified
    sideEffect: database
    allowCompare: false
    allowShadow: false
```

生产 mutation ownership 只以该版本化清单为准，每次修改都必须经过代码审查。构建工具负责校验同一 capability 的 mutation 完整性、生成 Caddy/lab-router 配置、执行 `caddy validate`，再通过原子 reload 发布；生成产物带 manifest digest 并进入审计日志。

差分校验同样以这份清单为准：`scripts/compare-backends.mjs` 会从 `GET + sideEffect: none + allowCompare: true` 自动派生可对比接口，测试会强制 `backend/nodejs/utils/backend-routing.ts` 中的 Go 读路由白名单与路由契约保持一致。带参数的接口仍需要脚本里的显式安全策略，避免把未知设置 namespace 或 mutation 形态的 URL 误纳入对比。

### 5.2 路由规则

1. 以 method + 精确路径模板匹配，不能只写 `/api/*`。
2. 未匹配的纯读请求可以默认 Node；未匹配 mutation 必须有显式 Node owner 或返回 503。
3. mutation 失败后不得自动 fallback 到另一实现。
4. GET 也需要标注副作用；`logout`、OAuth callback、按需生成 display 等不能 shadow。
5. 写入切换按 capability group 进行，避免同一聚合由两个语言同时修改。
6. worker、scheduler、migration 不属于 HTTP 路由，但必须出现在同一 ownership 清单。
7. Redis route override 只允许短 TTL 的纯读实验，不能改变 mutation、worker、scheduler 或 migrator owner。
8. 管理控制面对 mutation 的“切换”只是发起 quiesce、drain、校验和 manifest 变更流程，不能直接翻转 Redis 值。

下表是后台 actor 与高风险 capability 的默认 owner，而不是 HTTP 网关当前的唯一实现。HTTP 请求是否由 Go 执行，以 `GO_API_ROUTES` 和 `system:backend.readProvider` 为准；migration 和生产默认 pipeline worker 仍保持单一 Node owner，backup scheduler 可配置为 Node 或 Go 单 owner，Go pipeline consumer 目前覆盖 `photo`、`live-photo-video`、`video`、`photo-reverse-geocoding` 和 `photo-erase-location` 学习切片。

建议能力组：

| Capability              | 初始 owner   | 说明                                                                                                                       |
| ----------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `public-read`           | Node         | 首个 Go 对照目标                                                                                                           |
| `identity`              | Node         | 共享 session 与 Go callback 已实现；identity owner 交接仍需演练                                                            |
| `albums-write`          | Node         | Go 已实现并通过 88 项相册专项门禁；生产归属按 route/provider 选择，不双写                                                  |
| `reactions-write`       | Node         | Go 已实现；DB fingerprint 限流、create/update/delete 响应和跨端读回已进入差分                                              |
| `photos-metadata-write` | Node         | Go 已实现；继续防止与 worker 生成字段冲突                                                                                  |
| `upload-storage`        | Node         | Go 已实现 Local/S3/OpenList；MinIO S3 已实测，托管云与真实 OpenList 继续差分                                               |
| `media-read`            | Node         | Go 已实现 Range/ETag/授权、基础图片变换与 MP4 pipeline 生成物读取                                                          |
| `settings-control`      | Node         | `backend.readProvider` 单项写入固定 Node；普通 settings 可由 Go 执行                                                       |
| `pipeline-consumer`     | Node         | Go 已支持 `photo`、`live-photo-video`、`video`、`photo-reverse-geocoding` 与 `photo-erase-location` 切片；全量任一时刻唯一 |
| `backup-scheduler`      | Node         | Go 已实现；任一时刻唯一                                                                                                    |
| `db-migrator`           | Node/Drizzle | 初期唯一                                                                                                                   |

### 5.3 会话级选择与 Compare Proxy

静态 Caddy 规则适合全局 capability owner，但它不能自行查询 Redis 并判断“这个用户是否被授权选择 Go”。目标方案增加一个不承载业务逻辑的 `lab-router`：

1. Caddy 继续负责 TLS、外部 Header 清理和公共入口；
2. 需要用户级选择或 compare/shadow 的 API 先进入 `lab-router`；
3. `lab-router` 用共享 session 确认用户，再读取管理员策略；
4. 当前实现由管理员全局选择 `system:backend.readProvider`，对 `GO_API_ROUTES` 中登记的 HTTP operation 生效；
5. migration、worker、scheduler 仍以全局唯一 actor owner 为准；HTTP writer 只能由当前选择的一个后端执行；
6. `lab-router` 把请求交给一个 primary，不能自己写业务数据。

`lab-router` 初期可以是 Node Nitro middleware，后续也可以是独立小进程；无论用哪种语言，其输入输出和策略必须由同一 route manifest 约束。

当前 Node middleware 转发到 Go 时，会保留原始 method/path/query/body、Cookie、`X-Forwarded-*`、`X-Request-Id` 等代理上下文，并额外写入只在内网可信的 `X-ChronoFrame-Backend-Request`、`X-ChronoFrame-Route-Id`、`X-ChronoFrame-Original-URL` 与 `X-ChronoFrame-Original-Accept-Encoding`。最后一个字段用于避免 Node→Go 内部代理 hop 改写 `Accept-Encoding` 后导致匿名 reaction fingerprint 与 Node 直连不一致；公网入口必须像 `deploy/dual/Caddyfile` 一样先删除这些 `X-ChronoFrame-*` 内部头，再由可信网关重建。

Compare 执行流程：

```text
request → lab-router ─┬─► current owner / primary ─► user response
                      └─► peer implementation     ─► normalizer ─► diff report
```

- compare 在管理员/开发者主动使用时等待两个结果或明确显示超时；
- shadow 立即返回 primary，异步执行有并发上限和硬超时的 peer read-only 请求；
- primary 失败不自动采用 shadow 结果；
- comparer 只保存脱敏后的字段路径、摘要、耗时和版本；
- compare/shadow 进程使用 read-only DB/Storage/Redis 权限。

### 5.4 学习直连

开发环境可额外暴露：

- `/__lab/node/<original-path>`；
- `/__lab/go/<original-path>`。

网关去掉 `/__lab/node` 或 `/__lab/go` 前缀后转发。生产默认关闭；如果确需开放，必须经过管理员认证，不能仅依赖可伪造的公开请求头。

也可以在仅绑定 loopback 的本地环境允许 `X-ChronoFrame-Backend: go`。公网网关必须删除客户端传入的同名内部头。

### 5.5 Nuxt SSR 内部请求

当前 Nuxt SSR 中的相对 `useFetch('/api/...')` 可能由 Nitro 在进程内直接执行，从而绕过 Caddy 与 `lab-router`。凡是进入 route manifest 的 API，SSR 不能继续依赖这种隐式内部路由，必须使用统一的 `backendClient`：

1. 浏览器页面请求仍由 Gateway 转到 Node SSR；
2. Node SSR 的数据请求直接调用内网 `lab-router`，由同一份 manifest、session 和用户选择决定 owner；
3. `lab-router` 再直接调用 Node API 或 Go API upstream，绝不回到公网 Gateway，也不把页面渲染请求代理给自己；
4. `backendClient` 透传 Cookie/授权上下文、`X-Request-Id`、原始 host/proto 和 locale，并使用内网身份验证；
5. 加入内部 hop/loop guard，超过一次 router hop 立即失败，不能形成 `router → Node SSR → gateway → router` 循环；
6. SSR 首屏与 hydration 后请求使用同一个 capability owner 决策和 session 选择。

E2E 必须同时断言 SSR HTML 中的数据、hydration 后刷新结果和响应 backend marker 来自同一契约版本；不能只测试浏览器直接调用 API。

## 6. API 契约

当前 `docs/zh/development/api.md` 仍是 WIP。双栈不能靠阅读 handler 猜行为，建议建立：

```text
backend/
  contracts/
    openapi.yaml
    routes.yaml
    errors.yaml
    settings.catalog.json
    fixtures/
    comparisons/
```

OpenAPI 3.1 至少锁定：

- method、path、path/query 参数；
- 请求 body、Content-Type 与最大尺寸；
- status code；
- H3 现有错误 envelope；
- camelCase 字段；
- `null`、缺字段和空数组的区别；
- timestamp 的 Unix 秒或 ISO 字符串语义；
- 0/1 与 JSON boolean 的映射；
- pagination、排序和默认 limit；
- Cookie、Range、ETag、Last-Modified、Cache-Control；
- SSE 和预签名上传等非普通 JSON 行为。

### 6.1 Differential test

对照流程：

1. 使用同一份只读 SQLite fixture 和媒体 fixture；
2. 为 Node、Go 准备等价共享 session；
3. 发送完全相同的请求；
4. 规范化 request ID、时间戳、签名 URL 等动态字段；
5. 比较 status、header、JSON 和权限结果；
6. 生成字段级差异，不忽略整个对象；
7. 所有差异进入批准列表或阻止路由切换。

不能直接用线上写请求对照两个服务。写行为使用独立数据库副本，比较最终逻辑快照。

发布门槛只使用同一 SQLite snapshot/fixture 的结果。在线 shadow 由 `lab-router` 或诊断 sidecar 在同一观察连接上，于两次读取前后读取 `PRAGMA data_version`；期间发生变化的样本标记为 `inconclusive`，不进入确定性一致率分母。不同 SQLite 连接的 `data_version` 数字不能直接互相比较。若未来增加领域 revision，则由所有 writer 在业务事务内递增，并随差异报告记录。

### 6.2 响应标识

两套服务统一输出：

```text
X-ChronoFrame-Backend: node | go
X-ChronoFrame-Mode: normal | compare | shadow | sandbox
X-ChronoFrame-Backend-Version: <build version>
X-ChronoFrame-Maturity: experimental | verified | stable
X-Request-Id: <request id>
```

Go 错误在兼容阶段映射为现有 Node/H3 格式；不能让前端针对两种语言分别解析。

## 7. 共享会话设计

### 7.1 为什么不直接让 Go 读取旧 Cookie

当前 `nuxt-session` 和 `chronoframe-access` 是 H3 sealed Cookie。直接在 Go 复制其 iron 加解密协议会把学习项目绑定到框架内部格式。

更严重的是，当前登录、GitHub OAuth 和向导把完整 `users` 行写入 session，其中包含 password hash；框架的 `GET /api/_auth/session` 又会返回 session 内容。新方案不能复刻这一 payload。

### 7.2 目标 Cookie

```text
cf_session=<256-bit random opaque token>
cf_access=<256-bit random opaque token>
```

属性：

- `HttpOnly`；
- `SameSite=Lax`；
- `Path=/`；
- HTTPS 下必须 `Secure`；
- 不包含 userId、role、password hash 或业务数据；
- 日志永不记录原 token。

Redis 只用 token 的 SHA-256 hex 作为 Key 后缀。

### 7.3 Session Redis 协议

Key：

```text
cf:v1:<environment>:session:<sha256(token)>
```

Value：

```json
{
  "schemaVersion": 1,
  "userId": 12,
  "authVersion": 1,
  "issuedAt": 1788940800,
  "expiresAt": 1791532800
}
```

规则：

- 时间统一为 UTC Unix 秒，token digest 固定为小写 SHA-256 hex；
- `authVersion` 是必填字段；目标 schema 为 `users` 增加默认值为 1 的对应列；
- Redis TTL 不得晚于 `expiresAt`，允许的时钟误差写入 golden vector；
- 不缓存 `passwordHash`；
- 不把 `isAdmin` 当成长期可信值，每次授权从 SQLite 读取用户的 active/role；
- 默认使用固定绝对 TTL，普通 Node/Go 读请求和 shadow 都不能 touch 或滑动续期；
- 只有 manifest 中的 identity owner 可以创建、撤销 session；如未来需要滑动续期，也只由其内部 touch API 执行；
- logout 由 identity owner 删除 Redis Key 并清 Cookie，peer 调用内部 revoke API；
- 密码修改、用户停用或权限变更递增 `authVersion`，使现有 session 失效；
- Node 与 Go 使用完全相同的 JSON、时间和 TTL 规则。

### 7.4 Site access Redis 协议

Key：

```text
cf:v1:<environment>:access:<sha256(token)>
```

Value：

```json
{
  "schemaVersion": 1,
  "accessVersion": 3,
  "issuedAt": 1788940800,
  "expiresAt": 1791532800
}
```

站点密码变化时递增 SQLite 中的 `access.version`。两边校验 Redis grant 的版本与数据库版本；旧 grant 自动失效。

### 7.5 旧会话过渡

1. 立即让 Node 的 session API 和新登录只输出/保存最小用户字段，停止向浏览器返回 password hash。
2. 先把当前复用的 `NUXT_SESSION_PASSWORD` 拆分成 legacy session 解密 key、legacy access-cookie key 和 OG signing key/keyring；保留旧 key 只用于验证，并让新签名使用独立新 key。
3. 无感迁移的目标实现必须给旧 session 增加稳定 ID，并用 Redis `SET NX` 兑换/撤销账本保证只可兑换一次；没有该账本时不得接受 legacy-only Cookie。
4. Go 只接受新 session；初期也可调用仅内网开放的 Node introspection。
5. 初期 Node 是唯一 identity owner；未来明确交接给 Go 后，Go 才能创建/撤销同一种 Redis session，两种登录 writer 不能同时在线。
6. 当前 identity owner 的登出同时撤销新 session 并清除新旧 Cookie。
7. 双栈共享 Redis 模式下，公开读请求不兑换 `chronoframe-access` 旧 Cookie；站点密码验证接口是 `cf_access` 的唯一写入口。带一次性兑换账本的无感迁移属于后续 M2；OG URL 在自身最长有效期内通过 signing keyring 同时验证新旧 key。
8. session、access 和 OG 各自的兼容窗口结束后再移除对应旧 key；不能用一次 secret 轮换同时意外失效三类凭证。若安全事件要求提前轮换，应明确记录 blast radius 并通知受影响用户。
9. 过渡结束后两套后端仍共同读取 Redis session，写入继续服从唯一 identity owner，不回到语言私有 Cookie。

当前 M0/M1 选择安全切断：配置 `CFRAME_REDIS_URL` 或 required 模式后，legacy-only session fallback 关闭，升级用户需要重新登录一次。此取舍堵住 logout 后重放旧 sealed Cookie 的路径；待 M2 一次性兑换账本完成后，才恢复无感迁移体验。

互通测试中的“Node 登录 → Go 读取”和“Go 登录 → Node 读取”分别发生在 identity owner 完成交接之后，不代表两个登录 writer 同时启用。

### 7.6 密码 Hash

现有密码使用 Adonis 风格 scrypt PHC。Go 可以用 `golang.org/x/crypto/scrypt` 兼容验证。

兼容契约：

```text
$scrypt$n=16384,r=8,p=1$<16-byte salt, standard Base64 without padding>$<64-byte derived key, standard Base64 without padding>
```

解析器必须拒绝超出资源上限的参数，比较 derived key 时使用 constant-time compare。用固定密码、salt、正确/错误密码和畸形 PHC 建立 Node/Go golden vectors，不能只拿一个真实用户 hash 手测。

双后端长期共存时，任何新 hash 格式都必须先被两边支持。因此默认：

- 第一阶段继续写现有 scrypt 格式；
- 若计划升级 Argon2id，必须先让 Node 与 Go 都能验证两种格式；
- 之后才能在任一后端登录成功时渐进 rehash；
- 不能让 Go 单方面写入 Node 无法验证的格式。

## 8. Redis 共享协议

### 8.1 Namespace

统一前缀：

```text
cf:v1:<environment>:<purpose>:<identifier>
```

建议 Key：

| Purpose                  | Key 示例                                         | 数据结构              |
| ------------------------ | ------------------------------------------------ | --------------------- |
| Session                  | `cf:v1:prod:session:<hash>`                      | String(JSON) + TTL    |
| Access grant             | `cf:v1:prod:access:<hash>`                       | String(JSON) + TTL    |
| Rate limit               | `cf:v1:prod:ratelimit:access:<ip-hmac>:<window>` | Counter + TTL         |
| Public setting cache     | `cf:v1:prod:setting:app:title`                   | String(JSON) + TTL    |
| Settings revision        | `cf:v1:prod:settings:revision`                   | Integer               |
| Settings L1 version      | `chronoframe:settings:version`                   | Integer               |
| Invalidation event       | `cf:v1:prod:events:settings`                     | Pub/Sub 或 Stream     |
| Read-only route override | `cf:v1:prod:route:<routeId>`                     | String + 短 TTL       |
| Scheduler lease          | `cf:v1:prod:lease:backup`                        | Token + TTL + fencing |
| Shadow result            | `cf:v1:prod:shadow:<requestId>`                  | String(JSON) + 短 TTL |

所有值使用 UTF-8 JSON 或明确的整数/字符串；禁止 Node V8 serialization、Go gob 或语言私有二进制格式。

### 8.2 Settings cache

SQLite 始终是 source of truth。建议 cache-aside：

1. 读 Redis；
2. miss 时读 SQLite；
3. 只缓存非 secret 设置，并写短 TTL；
4. 设置写入、SQLite `settings_revision` 递增和 outbox event 在同一 DB transaction 内提交；
5. outbox publisher 删除 Redis Key、更新 Redis revision 并发布失效事件；
6. Node 与 Go 收到事件后清理本地 L1；
7. 两端周期读取 SQLite revision，发现落后时主动丢弃缓存。

Redis Pub/Sub 是 at-most-once，不能作为唯一正确性机制。持久化 DB revision/outbox 负责弥合“DB 已 commit、Redis 尚未失效时进程崩溃”的窗口；L1 仍必须有短 TTL。安全关键设置直接读 SQLite 或使用更严格的失效路径。

当前 Node `SettingsManager` 使用默认 5 秒有界 TTL，并额外读取 `CFRAME_SETTINGS_CACHE_VERSION_KEY` 指向的 Redis 整数版本键（默认 `chronoframe:settings:version`）：Node/Go 设置写入成功后递增该键，Node 在 `get` 与 `set` 开始时发现版本变化就清空本进程 L1，避免 Go 写设置后 Node 因本地缓存继续读旧值。安全关键的 access 配置直接读取 SQLite；Go settings handler 直接读写同一张 `settings` 表并发布同一版本键。revision/outbox 仍是后续增强项，因此设置写入仍通过网关的 Node-owned 切换键保持可回退，其他设置 operation 可在 Go owner 下执行。

对应的中性 schema 至少包括：

```text
system_revisions(name PK, revision, updated_at)
outbox_events(id PK, topic, aggregate_key, revision, payload_json,
              status, attempts, available_at, created_at, published_at)
```

settings owner 在同一事务内更新设置、递增 `system_revisions('settings')` 并插入具有唯一 ID 的 outbox event。Publisher 以 at-least-once 方式发送，消费者按 event ID/revision 幂等处理；失败按 `available_at` 重试，成功事件按明确保留期归档或清理。Redis cache value 必须携带其 DB revision，reader 发现落后就回源，不能只相信 Pub/Sub 已送达。

### 8.3 不进入通用缓存的内容

- 密码 hash；
- GitHub client secret；
- SMTP 密码；
- S3/OpenList credential；
- 备份加密口令；
- 原始 Cookie/token；
- 完整 EXIF 中的敏感位置数据；
- 大型媒体 Buffer。

Storage provider 配置从 SQLite 读取，敏感字段只在进程内短期存在。Provider 切换的生产级目标协议是 `pendingRevision → backend acknowledgements → activeRevision` 两阶段流程，并由 `provider_config_rollouts(revision, status, required_instances_json, deadline, ...)` 与 `provider_config_acks(revision, instance_id, status, validated_at, error_digest)` 持久化。required instances 在创建 rollout 时从已验证的部署清单快照冻结；实例离线或 ack 超时只会使 rollout 保持 pending/failed，旧 active 配置继续提供读取和上传。Pending 配置可以被实例验证，但在激活前不能承接媒体读写；回滚把 rollout 标记 cancelled，不覆盖旧 active revision。当前 Go 已能执行 storage-provider 配置 CRUD，但主动 reload/ack/rollout 仍是后续生产硬化项。

### 8.4 Redis 故障策略

| 功能                   | Redis 不可用时                                                    |
| ---------------------- | ----------------------------------------------------------------- |
| 已登录 API             | fail closed，返回 503，不猜测身份                                 |
| 公共预览               | 保持未解锁预览                                                    |
| 访问密码验证           | 返回 503，避免绕过共享限流                                        |
| Settings cache         | 回源 SQLite                                                       |
| Public read cache      | 回源 SQLite/Storage                                               |
| Route manifest         | 继续使用最后一个已验证 manifest；owner 不确定的 mutation 返回 503 |
| Worker/scheduler lease | 非 owner 停止执行                                                 |
| Shadow report          | 丢弃诊断，不影响主请求                                            |

### 8.5 Redis ACL 与可靠性

生产环境不允许 Node、Go、router、shadow 和 sandbox 共用一个无认证 Redis 用户：

- `cf_node` / `cf_go`：只开放当前 capability 所需的 Key pattern 与命令，identity 非 owner 只能读 session；
- `cf_router`：读取 session/实验策略，只能写独立诊断 prefix；
- `cf_shadow`：读取最小 session/settings snapshot，只能写短 TTL 诊断结果，不能执行 session 删除、限流递增或业务缓存写入；
- `cf_sandbox`：只允许 sandbox prefix，生产最好使用独立 Redis instance；
- `cf_health`：只允许认证后的 `PING`。

密码通过容器 secret/file 传入，日志和 healthcheck 不打印凭证。Redis 配置使用 `maxmemory-policy noeviction`，让容量耗尽显式失败而不是随机驱逐 session；设置内存、连接数、AOF 大小和 eviction 告警。建议开启 AOF，并明确 `appendfsync`、备份/恢复与故障切换策略；即使 Redis 丢失只导致重新登录或短期 503，恢复演练也必须证明不会转化为身份绕过或业务数据回滚。

## 9. SQLite 双进程规则

### 9.1 可行边界

SQLite WAL 支持不同进程并发读取以及一个 writer，但要求所有进程位于同一主机。Node 和 Go 容器必须共享同一个本机 volume 与同一组 `-wal`/`-shm` 文件；本地双容器学习栈默认使用 Docker named volume，避免 macOS bind mount 文件共享层破坏 WAL 可见性。

基线审计时，Node 连接已设置 WAL、`synchronous=NORMAL`、cache 和 temp store，但缺少统一的 `foreign_keys=ON` 与 `busy_timeout`。当前主运行时 `useDB()` 已统一启用这两项；Go normal 连接使用 `github.com/mattn/go-sqlite3` 的 CGo 原生 SQLite driver、`mode=rwc`、`_foreign_keys=1` 和同一 busy timeout，并在启动时要求数据库已经建立 WAL。为避免另一进程 checkpoint 后复用陈旧 WAL 元数据，Go 不保留跨请求 idle connection；事务期间仍固定同一连接。

### 9.2 连接基线

所有 Node/Go 连接：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

注意：

- `foreign_keys` 是连接级设置；
- 在开启之前先运行 orphan audit 和 `PRAGMA foreign_key_check`；
- Node 与 Go 必须同一次发布启用，不能长期保留两套约束行为；
- Go 初期 `SetMaxOpenConns(1)`，压测后再调整；
- 对 `SQLITE_BUSY` 只做有上限、带 jitter 的重试；
- 事务中不能执行网络请求、对象上传、FFmpeg、ExifTool 或图片处理；
- 需要 read-modify-write 的操作使用短事务和条件更新；
- 监控 WAL 大小并安排单一 checkpoint owner。

本次工作区检查中，Node 运行时的 SQLite 为 3.53.2。[SQLite 官方 WAL 文档](https://sqlite.org/wal.html#the_wal_reset_bug)说明，多线程或多进程同时写入/检查点时，3.7.0 至 3.51.2 存在低概率 WAL-reset 问题，并在 3.51.3 修复。因此 Go driver 与 Node runtime 都必须固定到已修复版本，并通过双进程 WAL、online backup 和 crash-recovery 测试；不能只比较版本号后跳过验证。

### 9.3 Schema 唯一所有者

通用 preflight 必须读取目标数据库的 migration ledger，与当前源码 journal 和 schema fingerprint 比较；存在 pending migration 时先做 SQLite online backup，再由唯一 migrator 按 journal 应用全部待执行项，随后校验 ledger、目标表/列、`integrity_check`、`foreign_key_check` 和 fingerprint。完成前 Go readiness 必须失败，不能通过启动时自行补表绕过。

截至 2026-09-12，源码权威 journal 到 `0023_skinny_gambit`。`schema.json` 同时锁定完整 ledger、关键表/列/索引和安全 trigger 定义；`db-preflight`、Go readiness 与 Go one-shot migrator 使用同一份生成契约。任何实际数据库是否需要迁移都必须通过参数化只读 preflight 判断，文档不硬编码某个工作区数据文件的状态。

当前策略：

- Drizzle SQL ledger 是唯一 schema 历史；
- 默认双栈由 Node/Drizzle migration 启动或 job 执行；
- Go API 进程只校验 schema version/fingerprint；
- Go one-shot migrator 仅在 `CFRAME_DB_MIGRATOR=go` 且 `CFRAME_GO_MIGRATE_ONLY=true` 时执行同一份 SQL bytes，初始化默认 settings metadata，并在完成后退出；
- Node 与 Go API 服务启动时都不自动抢 migration；
- schema 不兼容时 Go readiness 失败，网关继续 Node。

学习 Go migration 时必须进行明确的 ownership transfer，不能让 Node 与 Go 两个 migrator 同时运行，也不能让 Drizzle 与 Goose 维护两套独立 ledger。当前实现选择更保守的方式：Go 直接嵌入并执行 Drizzle 生成的 SQL bytes，继续写同一份 `__drizzle_migrations` ledger。

Schema 变更规则：

1. 先加法，后清理；
2. Node 与 Go 在清理前都能读写新旧格式；
3. 禁止未协调的 rename/drop/type change；
4. migration 前使用 SQLite online backup；
5. 执行 `integrity_check`、`foreign_key_check` 和 schema fingerprint；
6. 对 JSON 与 enum 未知值做向前兼容。

### 9.4 共同数据格式

必须冻结：

- SQLite boolean 为 INTEGER 0/1；
- Drizzle timestamp 的 Unix 秒语义；
- `date_taken`、`last_modified` 等文本日期格式；
- tags、EXIF、queue payload、storage config 的 JSON 结构；
- `album_photos.position` 为 REAL；
- content hash 为小写 SHA-256 hex；
- 现有 photo/video ID 生成算法；
- 媒体 Key 与 owner 前缀。

Go 解码未知 enum 或新增 JSON 字段时不能直接崩溃，应保留向前兼容错误或原始值。

## 10. 并发写与一致性

共享 SQLite 并不会自动防止 lost update。规则：

1. 以 capability/aggregate 设唯一 write owner，而非随机按请求分流。
2. 相册与 `album_photos` 整组归属一个后端。
3. settings 与 storage provider 整组归属一个后端。
4. upload、photo record、queue producer 和媒体对象写入作为一个能力链归属。
5. 用唯一约束和条件更新实现幂等，不只依赖先查再写。
6. 分享上传配额用单条条件更新或同一事务扣减。
7. 写响应返回前，数据库事务必须已经 commit；跨存储操作设计补偿状态。
8. 客户端重试使用 `Idempotency-Key`，Node 与 Go 共用记录。

已落地或建议新增的中性基础表/字段必须由唯一 migration owner 添加：

- `idempotency_keys`；
- `system_revisions` 与 `outbox_events`；
- `provider_config_rollouts` 与 `provider_config_acks`；
- `runtime_leases`；
- queue 的 `available_at`、`claimed_by`、`claim_token`、`claim_expires_at` 已落地；`processor_version` 仍可作为后续兼容性字段；
- 必要的 schema fingerprint/ownership metadata；
- `album_photos(album_id, photo_id)` 唯一约束；
- `photo_reactions(photo_id, fingerprint)` 唯一约束。

增加唯一约束前必须先清理既有重复数据。

差异报告不写入生产业务 SQLite。`lab-router`/可信 control plane 将其写到独立诊断 SQLite、Redis Stream 或日志后端；shadow backend 本身只返回只读对照结果。这样产品指标中的“compare/shadow 对生产 DB 零写入”仍可被直接验证。

## 11. Queue 与 Scheduler

### 11.1 当前状态与限制

当前 Node 在 Web 进程内启动 worker；Go consumer 在 `CFRAME_PIPELINE_CONSUMER=go` 时启动已迁移的学习切片。二者共享同一张 `pipeline_queue`，并使用两层保护：

1. Redis runtime lease：防止同一共享 Redis 环境中 Node/Go pipeline consumer 同时 active；
2. SQLite task-row lease：`available_at` 决定何时可 claim，`claimed_by/claim_token/claim_expires_at` 记录当前 worker，stage、complete、fail/retry 和 heartbeat 都必须用 claim token 条件更新。

Node 启动时不再重置所有 `in-stages`；只回收 `claim_expires_at IS NULL` 或已过期的历史/僵尸任务。因此当前基础设施允许在学习环境安全切换 owner，但仍需要维护窗口、真实媒体 corpus、故障注入和交接 runbook 才能把它认定为生产全量 worker 交接。

Go consumer 的启动期 lease 获取是可等待的：如果 Redis 中还存在旧实例残留的 `pipeline-consumer` lease，进程不会永久跳过 consumer，而是在后台按短间隔重试，直到 lease 过期/释放后进入 active 状态或进程上下文取消。`dual:verify-upload-pipeline:container` 在发现 Go worker 已配置但 `pool.isActive=false` 时也会在超时窗口内等待，避免把正常的 lease TTL 交接误判为功能失败。

正常退出时，Node/Go 都先关闭 claim 入口，并继续让已领取任务运行及刷新任务 lease。Node 在 shutdown timeout 内排空后才删除 Redis runtime lease；若超时则保留 lease，由进程退出后的 TTL 提供交接缓冲。Go 将 claim context 与 task/lease context 分离：SIGTERM/SIGINT 只取消 claim context，已领取任务完成并写回后才释放 runtime lease；只有 runtime lease 真正丢失时才取消 task context。这样正常回切不会主动制造两个可执行 owner，但强制终止仍依赖 runtime/task lease 到期和 fencing 恢复。

> Node worker 与 Go worker 绝对不能同时连接生产队列。

### 11.2 初期配置

`CFRAME_DB_MIGRATOR`、`CFRAME_PIPELINE_CONSUMER` 和 `CFRAME_BACKUP_SCHEDULER` 已由 Node migration、queue 和 backup 插件读取，并执行严格的 `node|go|none` 解析；Go 服务接受 migrator 为 `none|go`，其中 `go` 必须配合 `CFRAME_GO_MIGRATE_ONLY=true` 作为一次性迁移 job 使用。Go 也接受 `CFRAME_BACKUP_SCHEDULER=go` 并启动自己的定时备份 actor，接受 `CFRAME_PIPELINE_CONSUMER=go` 并启动只 claim `photo`、`live-photo-video`、`video`、`photo-reverse-geocoding` 与 `photo-erase-location` 的学习 consumer。它仍可以通过共享 Redis 读取 Node worker telemetry，并可独立执行手动 backup API。生产多副本仍需 one-shot migrator/lease 与部署级互斥校验，不能仅凭各进程环境变量证明全局只有一个 owner。

```text
CFRAME_DB_MIGRATOR=none
CFRAME_GO_MIGRATE_ONLY=false
CFRAME_PIPELINE_CONSUMER=node
CFRAME_BACKUP_SCHEDULER=node

Node: worker enabled
Go:   pipeline consumer disabled unless owner=go, backup scheduler disabled unless owner=go, API migrations disabled unless launched as one-shot migrator
```

只有当前业务 command owner 可以为该命令直接入队；另一个后端必须调用 owner 的内部 command API，而不能重复生产。同一生产队列使用相同的 versioned payload；当前任务行字段已包含：

```text
pipeline_queue(
  available_at,
  claimed_by,
  claim_token,
  claim_expires_at
)
```

后续可继续在 payload 上增加生产者元信息：

```json
{
  "schemaVersion": 1,
  "type": "photo",
  "storageKey": "photos/users/12/...",
  "producerBackend": "go"
}
```

旧 Node consumer 必须先证明可以忽略未知字段并处理 Go 产生的任务。

### 11.3 学习 Go worker

顺序：

1. 使用独立 sandbox DB 和 storage prefix；
2. 通过 media golden corpus；
3. 增加 queue lease schema（已完成：`available_at/claimed_by/claim_token/claim_expires_at`）；
4. claim 使用条件更新并写入 claim token（Node 使用 `RETURNING`，Go 使用事务 + `RowsAffected` fencing）；
5. 用 `available_at` 实现退避，不修改 `created_at`（已完成）；
6. 定期续租，只有 `claim_expires_at IS NULL OR claim_expires_at <= now` 才能回收（已完成基础实现）；
7. 输出文件使用确定性 Key；
8. 数据库 commit 与对象写入设计幂等补偿；
9. 验证 kill -9、超时、磁盘满和重复执行；
10. 最后在维护窗口把 consumer owner 从 Node 切到 Go。

长期策略只有两种：生产队列整体由 Node 或 Go 中的一种实现消费；或者 Go worker 只使用独立 sandbox queue。不要按任务类型同时启动两个生产 consumer，也不采用随机 worker 负载均衡。

“Node 启动即重置全部 `in-stages`”已修复为只回收过期 lease。正式 claim/commit 必须携带 fencing token，旧 consumer 即使晚到也不能在失去 owner 后提交结果。

Fencing 的权威状态持久化在 SQLite，而不是某个进程内变量：

```text
runtime_leases(
  name PRIMARY KEY,
  owner_backend,
  owner_instance,
  fence INTEGER NOT NULL,
  lease_until,
  updated_at
)
```

协议如下：

1. 只有 versioned manifest 中配置的 consumer backend 有资格申请 `pipeline-consumer` lease；
2. 申请者在 `BEGIN IMMEDIATE` 短事务中，仅当 lease 已过期或仍属于同一 instance 时更新记录；每次重新获取/交接都原子递增 `fence` 并返回新值；
3. claim 把 `owner_instance`、`fence` 和 task `lease_until` 一起写入 queue row；
4. heartbeat、stage、complete、fail/retry 都使用 `WHERE locked_by = ? AND fencing_token = ?`，并确认 `runtime_leases` 仍是同一 owner/fence；影响行数为 0 就立即丢弃本次结果；
5. 媒体输出写到包含 task ID/fence 的不可变版本 Key，只有通过上述条件更新的 DB row 才能把该版本标记为 active；失去 lease 的进程不能覆盖 canonical object，stale object 由补偿任务清理；
6. Redis lease 可以用于快速健康提示，但不能替代 SQLite fence 的最终提交条件。

环境变量、进程退出检查和部署副本数只是第一道防线，不能替代该协议。

### 11.4 Consumer handoff

1. 在 manifest/control plane 中把交接置为 `quiescing`，停止产生新任务和新 claim；
2. 等待当前 owner 的 in-flight 数归零；超时则等待 lease 过期并把未完成任务留给恢复流程；
3. 停止旧 consumer，确认其 lease/fence 不再有效；
4. 经审计把 manifest owner 更新为新 backend；
5. 新实例通过 `runtime_leases` CAS 获取更大的 fence，记录 queue 状态后启动 claim；
6. 恢复 producer；
7. 观察失败、重复、stale commit 拒绝数和最老任务年龄；
8. 回退时执行相同的反向步骤，绝不复用旧 fence。

Backup、配置轮询和其他 cron 也遵循同一 owner/lease 模型。

## 12. 对象存储与上传

### 12.1 共同接口

Go 不应复制 Node 的全量 Buffer 模式。建议接口：

```go
type Storage interface {
    Put(ctx context.Context, key string, src io.Reader, size int64, contentType string) error
    Open(ctx context.Context, key string, r *ByteRange) (io.ReadCloser, ObjectMeta, error)
    Head(ctx context.Context, key string) (ObjectMeta, error)
    Delete(ctx context.Context, key string) error
    PresignPut(ctx context.Context, key string, opts UploadOptions) (SignedRequest, error)
}
```

Node 的目标 adapter 也应遵循等价的 stream contract。

### 12.2 Key 安全

共同 sanitizer 必须：

- 拒绝绝对路径；
- 拒绝 NUL、反斜杠和控制字符；
- 拒绝任何 `.` 或 `..` segment；
- 不直接使用客户端原始文件名作为最终 Key；
- 规范化后再次验证 owner 前缀；
- Local provider 在 `resolve` 后验证最终路径仍在 base directory 内；
- 删除、读取、写入使用同一个 sanitizer。

### 12.3 共享 Provider

- Provider 配置以 SQLite 为准；
- credential 不放入 Redis 通用缓存；
- 两边实现相同 prefix、CDN URL、签名过期和 MIME 规则；
- Provider 切换是控制面操作，在两边 reload 成功前不接受新上传；
- normal owner 写出的对象必须能被另一后端读取；
- shadow/compare 使用强制只读 adapter。

### 12.4 上传事务边界

建议状态机：

```text
prepared → uploading → stored → queued → processing → ready | failed
```

对象上传不能放在 SQLite transaction 中。使用记录状态和补偿任务解决：

- DB prepare commit；
- 流式写对象并计算 hash；
- 对象成功后短事务写 stored + enqueue；
- 失败时标记 failed 并异步清理孤儿对象；
- 所有阶段使用同一 idempotency key。

当前 Node 内部上传仍会把请求体读成 Buffer 后写入 provider；Go 内部上传已使用 `http.MaxBytesReader` 做未知长度请求限制，并把 body 以 reader 形式交给 Local/S3/OpenList provider，Local provider 会先写入同目录临时文件再原子 rename，且复制过程中会持续检查 request context；如果客户端断开或上游取消，Go 会返回取消错误、删除临时文件并保留旧对象，不发布半成品。S3/OpenList provider 的上传 body 同样经过 context-aware reader，避免取消后继续消费完整请求体。上传准备阶段已补齐 Node 的 S3 策略：普通 S3 返回 PutObject 预签名 URL，Tencent COS 因浏览器 CORS 兼容性继续回退内部上传 URL，Local/OpenList 也保持内部上传 URL。生产化仍需测试当前 `upload.maxFileSize` 允许的上限及多个文件档位，证明 Go API RSS 增长有界且不随完整 payload 近似线性增长。

## 13. 媒体路由与媒体处理

### 13.1 媒体授权

任一媒体 Key 都先解析到数据库 photo，再使用统一 visibility policy：

- 匿名公开；
- 站点 access grant；
- owner；
- admin；
- hidden album；
- original 与 derived asset 的不同权限。

不能仅凭 `users/<userId>/` 字符串前缀授权。

本阶段冻结的 canonical public predicate：

```text
public(photo) =
  NOT EXISTS (
    album_photos
    JOIN albums ON albums.id = album_photos.album_id
    WHERE album_photos.photo_id = photo.id
      AND albums.is_hidden = 1
  )
```

- 没有相册关系的照片公开；
- 同时位于公开相册和隐藏相册的照片仍不公开；
- 公开 photo list、album cover、album detail、map、OG 和所有 media proxy 共用同一个 predicate；
- site access grant 只解除公开集合的预览额度，不扩大到其他用户的隐藏/私有媒体；
- 普通用户只额外读取自己的私有媒体，管理员可以读取全部；
- owner 的 active 状态暂不加入 public predicate，除非另立产品变更。

公开相册详情现在会重新应用同一访问谓词：Node 通过 `requirePublicAlbumAccess` 与 `filterAccessibleAlbumPhotos` 执行，Go 通过 `album.IsHidden`、`accessState` 和 `IsPublicWithinLimit` 执行；fixture 额外提供预览外公开相册，`dual:verify-authz:container` 会在访问保护开启、`albumLimit=1` 时要求 Node/Go 对匿名详情访问都返回 401。

### 13.2 HTTP 契约

Go 媒体实现要覆盖：

- HEAD；
- 单 Range、206、`Content-Range`；
- 非法 Range 的 416；
- ETag、If-None-Match、304；
- Last-Modified；
- Content-Length、Content-Type；
- 客户端断开；
- Local、S3、OpenList 的差异。

目标矩阵：

| Route                     | 目标授权                                                                         | Range/HEAD                                                                     | Validator 与缓存                                                                               | 副作用和对照规则                                                           |
| ------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `/image/{key...}`         | key → photo → canonical policy；original 额外要求 owner/admin 或已批准的原图访问 | GET/HEAD；单 Range 完整支持 closed/open-ended/suffix；multi-range 明确返回 416 | 有内容 hash 时使用强 ETag，否则使用包含 key/size/mtime 的 weak ETag；私有缓存与 `Vary: Cookie` | 无写副作用后才允许 shadow                                                  |
| `/storage/{path...}`      | 与 `/image` 完全相同，Local path 额外 containment                                | 同上；非法/不可满足 Range 返回 416 和 `Content-Range: bytes */size`            | 不能对依赖 Cookie 的资源设置 public immutable；正确 `Vary`                                     | 禁止成为绕过 original policy 的旁路                                        |
| `/display/{photoId}`      | canonical policy                                                                 | 仅 GET；HEAD 暂缓                                                              | 派生对象按公开性选择 public/private                                                            | 缺图时当前会生成并写 DB/Storage，故不属于纯读；compare/shadow 必须禁用生成 |
| `/thumb/{encodedUrl...}`  | 先解析到 photo 再授权，不能信任任意外部 URL                                      | 仅 GET；HEAD/Range 暂缓                                                        | 明确 JPEG ETag/TTL 与 `Vary`                                                                   | 转码有 CPU/外部读取，首期离线 corpus 对照                                  |
| `/og-media/{photoId}`     | 校验 versioned HMAC token，并再次解析 photo                                      | 仅 GET；HEAD/Range 暂缓                                                        | private/no-store 由 token 可见性决定                                                           | 无持久化写入才可对照                                                       |
| `/share-og/{photoId}.png` | canonical policy；模板资源也需约束                                               | 仅 GET；HEAD/Range 暂缓                                                        | ETag 覆盖 photo/template/version                                                               | 动态合成，使用离线视觉对照，不进入默认 shadow                              |

共同 Range 规则：

- `bytes=start-end`、`bytes=start-` 和 `bytes=-suffixLength` 使用同一 parser 与 golden vectors；
- 不支持的 multi-range 不得在 Node/Go 中表现不同；
- 支持 `If-Range`：validator 匹配才返回 206，否则返回完整 200；
- HEAD 返回与 GET 相同的授权、validator、长度和缓存头，但不返回 body；
- 客户端断开必须取消上游读取，不能继续把整个对象读入内存。

访问受限资源使用 `private` 或 `no-store` 并正确 `Vary: Cookie`。只有真正公开、内容版本化且不依赖 Cookie 的派生对象才可使用 `public, immutable`。

媒体路由不能随机在 Node/Go 间切换；先通过独立 `/__lab/go` 和契约测试，再整条路由改变 owner。

当前 `/image` 与 `/storage` 已在 Node 侧共用同一个 Range parser，并覆盖 `bytes=start-end`、`bytes=start-`、`bytes=-suffixLength`、multi-range 拒绝和不可满足 Range；Go 侧使用同等 parser，并由 Go 单测固定 closed/open-ended/suffix 语义。`/storage` 已与 `/image` 对齐原图授权、`private, max-age=86400` cache policy 与 `Vary: Cookie`，非法或不可满足 Range 会返回 416 与 `Content-Range: bytes */size`。直读对象路由 `/image` 与 `/storage` 已补齐 GET/HEAD 双端契约，HEAD 复用同一套鉴权、ETag、Last-Modified、Range、If-Range、私有缓存/Vary 与 Content-Length 逻辑但不写响应体；客户端断开取消也已接入直读对象链路：Node 将请求/响应生命周期转换为 abort signal 并传入 StorageProvider 的 metadata/full/range 读取，Local/S3/OpenList provider 负责继续向文件流、AWS SDK 或 fetch 传播，Go 则通过 `r.Context()` 与 context-aware body/local file read helper 取消对象读取；Go Local provider 的对象写入也已纳入同一取消模型，源级测试固定“覆盖已有对象时中途取消不会发布部分新内容，读回仍是旧对象”；context-aware upload reader 源级测试固定取消会传给上层复制/上传链路；Node/Go S3/OpenList provider 源级测试都已覆盖“上游忽略 Range 返回 200 全量对象时按请求范围切片”的 fallback 语义，避免把全量 body 当成 206 range body 返回；`display` 的 Go 授权已收敛到 Node 的两阶段规则：owner/admin 可访问自己的私有派生图，其他访问者必须先命中 public photo predicate，再接受站点 access/preview 限制；`display`、`thumb`、`og-media` 与 `share-og` 的私有媒体响应也已统一设置 Cookie Vary，Node 生成缩略图会显式返回 `image/jpeg`、`Content-Length` 和私有缓存头；`dual:verify-upload-pipeline:container` 会在 provider 切到 Go 后通过 Node 网关探测 `HEAD /image/...`，并验证 stale `If-Range` 会回落到 200 完整响应。仍需继续补齐真实外部 Provider 服务矩阵和更大媒体 corpus 对照；会生成或渲染派生资源的 `/display`、`/thumb`、`/og-media`、`/share-og` 暂不开放 HEAD，避免探针触发副作用。

Go 的 `/display/{photoId}` 生成新派生图后不再吞掉 `provider.Put` 或 DB 更新错误；写入对象存储与 `photos.display_key` 更新都成功后才返回图片，与 Node 的 `storageProvider.create` + Drizzle update 失败即异常语义一致。

Go 的公开上传分享 task 路径在 `enqueueTask` 成功后会执行与 Node `markUploadShareUsed` 相同的 active-only update：递增 `upload_count`，刷新 `last_used_at` 与 `updated_at`；SQLite 写入错误会返回 500，避免队列任务已创建但分享使用状态没有落库。

Go 的上传分享管理 create/update 已改为从原始 JSON 执行 Node Zod 等价解析：根值必须是对象，未知字段剥离，标签使用 ECMAScript `String.prototype.trim()` 空白字符集合和 UTF-16 code unit 长度，`expiresInDays/maxUploads` 使用 safe-int 及相同上下界；create 的 `label:null` 非法，而 update 的 `label/maxUploads:null` 会显式写入 SQL NULL。update 不要求至少一个字段，空对象同样执行 `updated_at=unixepoch()` 并返回 `serializeUploadShare` 完整结构。PATCH/DELETE 的 ID 使用 Node `Number()` 风格解析，接受十进制小数形式、科学计数法及进制前缀中的正整数，不能映射到 SQLite signed integer 的超大合法数字直接按 404 处理。双向 mutation 验证已把 padded label、默认过期天数、未知字段剥离、nullable update 与 empty update 纳入真实 Node/Go 执行，当前实跑 212 项检查且清理零失败。

照片元数据 PUT 使用独立 raw JSON decoder 在任何数据库/对象存储读取前完成 Node `bodySchema` 等价校验和转换：title/description/tags 使用 ECMAScript trim 与 UTF-16 code unit 上限，tags 数组最多 64 项且单项最多 128，location 与 rating 分别保留 omitted/null/value 三态，rating 使用 safe-int 0..5，location 限制经纬度范围，未知字段剥离。当前 Node 路由直接调用 `bodySchema.parse(await readBody(event))`，未通过 `readValidatedBody` 映射 ZodError，因此合法 JSON 的 schema 错误表现为 500 `Server Error`；Go 为兼容现有客户端观测保持相同结果，而 malformed/trailing JSON 继续映射 400 `Bad Request`，空对象/未知字段对象继续返回 400 `No changes to apply`。这是一项显式兼容行为，若修正 Node 状态码必须同时升级两端契约。

Go 的 `/api/queue/task/retry` 与 `/api/queue/task/retry-batch` 已对齐 Node 的响应和错误契约：单任务重试返回 `payload.type/storageKey` 摘要；批量重试在非 `retryAll` 且没有 `taskIds` 时返回 400，查询任务后按 `failed` / 非 `failed` 拆分，返回 `retriedTasks`、`skippedTasks`、`retriedCount`、`skippedCount` 与 Node 一致的 message；重置任务会清理 `status_stage`、错误信息和 `claim_*` 租约字段，SQLite 查询或更新失败会返回 500，避免 claim/fencing 状态未落库时对外报告成功。

Go 的 `/api/queue/task/clear` 已改为 Node 一致的“先查询再删除”语义：`includeCompleted` / `includeFailed` 缺省为 true，显式值只有字符串 `"true"` 才会纳入清理，`olderThanDays` 会生成同一类 threshold filter；响应返回 `message`、`deletedCount`、`breakdown.completed/failed`，有时间过滤且实际删除时返回 `filter.olderThanDays/thresholdDate`，没有匹配任务时返回 `No tasks found to clear`。Go 侧阈值计算避免使用可能纳秒溢出的 `time.Duration(days) * 24h`，大 `olderThanDays` 会和 Node 一样落到过去时间而不是溢出到未来。`dual:verify-queue-control:container` 把 retry、batch retry 和 clear 放进生产式双栈验证：clear 删除分支执行前会直接查询 SQLite，确认 `olderThanDays=1` 命中的 completed/failed 行全部属于本次临时 task id，只有满足这个前置条件才经 HTTP 调用真实删除。

### 13.3 处理工具

推荐：

| 能力              | Go 路线                                            |
| ----------------- | -------------------------------------------------- |
| EXIF              | 继续调用 ExifTool                                  |
| 视频/探测         | 继续调用 FFmpeg/FFprobe                            |
| 图片              | 首先评估受控 `vips` CLI；用 corpus 与 Sharp 对照   |
| HEIC              | 验证 libvips/系统 codec 覆盖，否则保留专用 adapter |
| Live/Motion Photo | 按现有 metadata 与 Key 契约复刻                    |

所有外部进程：

- 使用 `exec.CommandContext` 和参数数组，不经过 shell；
- 有超时、并发、内存和临时磁盘预算；
- 在独立 temp directory 工作；
- 捕获有上限的 stdout/stderr；
- 退出时清理；
- 不允许用户控制可执行文件路径或任意参数。

派生媒体不要求字节完全一致，但必须满足格式、方向、尺寸、颜色、ThumbHash、感知相似度和播放兼容标准。

## 14. Go 代码结构与选型

### 14.1 目录

```text
backend/
  contracts/
    openapi.yaml
    routes.yaml
    settings.catalog.json
    fixtures/
  go/
    go.mod
    cmd/api/
      main.go
    internal/platform/
      config/
      db/
      redisx/
      httpx/
      observability/
      security/
    internal/auth/
    internal/access/
    internal/users/
    internal/photos/
    internal/albums/
    internal/reactions/
    internal/uploads/
    internal/settings/
    internal/storage/
    internal/media/
    internal/pipeline/
    internal/location/
    internal/backup/
    internal/system/
    testdata/
```

### 14.2 分层约束

```text
HTTP handler
    ↓
Application service  ← transaction / authorization / idempotency
    ↓
Domain ports
    ↓
SQLite / Redis / Storage / External tool adapters
```

- handler 不直接写 SQL；
- transaction 边界位于 application service；
- context.Context 贯穿调用链；
- domain 不依赖 HTTP、SQLite driver 或 Redis client；
- 全局 singleton 只用于不可变 wiring，不保存动态业务状态；
- error 类型在边界统一映射；
- 所有 goroutine 都有 owner、取消路径和 shutdown wait。

### 14.3 默认技术栈

| 领域       | 默认选择                               | 原因                                                  |
| ---------- | -------------------------------------- | ----------------------------------------------------- |
| Go 版本    | 由 `go.mod` 的 `go/toolchain` 精确固定 | CI、开发与镜像使用同一工具链                          |
| HTTP       | `net/http` + 标准 ServeMux             | 减少框架魔法                                          |
| 契约       | OpenAPI 3.1 + oapi-codegen             | 两种语言共用边界                                      |
| SQL        | `database/sql` + sqlc                  | 保留显式 SQL并获得类型                                |
| SQLite     | `github.com/mattn/go-sqlite3`          | CGo 原生 SQLite；与 Node 原生 SQLite WAL 语义保持一致 |
| Redis      | `github.com/redis/go-redis/v9`         | 官方 Go client                                        |
| Node Redis | `redis`                                | 使用同一协议而非语言私有 adapter                      |
| S3         | AWS SDK for Go v2                      | 官方 SDK                                              |
| 密码       | `x/crypto/scrypt`                      | 兼容现有 PHC                                          |
| OAuth      | 标准库 `net/http` + `encoding/json`    | 显式掌握 OAuth redirect/exchange                      |
| 日志       | `log/slog` JSON                        | 标准库、结构化                                        |
| Trace      | OpenTelemetry Go                       | 跨 Node/Go 请求链                                     |
| 测试       | `testing`、`httptest`、go-cmp          | 先掌握标准工具                                        |

初版不建议 Gin/Fiber、GORM、Redis queue 或微服务。它们会掩盖本项目最值得学习的 HTTP、SQL、事务和并发边界。

当前 `go.mod` 固定 `go 1.27.0` 与 `toolchain go1.27.1`，构建镜像固定为 `golang:1.27.1-alpine`；本地测试和容器因此使用同一工具链。后续版本升级通过独立 PR/ADR 完成，CI 落地时也必须读取同一权威版本，不能另设漂移的模糊范围。

## 15. 配置契约

建议两边共同支持：

```text
CFRAME_ENV=development
DATABASE_URL=/app/data/app.sqlite3
CFRAME_REDIS_URL=redis://redis:6379/0
CFRAME_RATE_LIMIT_SECRET=<optional-dedicated-rate-limit-secret>
CFRAME_SESSION_COOKIE=cf_session
CFRAME_ACCESS_COOKIE=cf_access
CFRAME_ROUTE_MANIFEST=/app/contracts/routes.yaml
CFRAME_DB_MIGRATOR=none
CFRAME_PIPELINE_CONSUMER=node
CFRAME_BACKUP_SCHEDULER=node
CFRAME_BACKEND_ID=node|go
CFRAME_INTERNAL_SECRET=<secret>
CFRAME_GO_MIGRATE_ONLY=false
CFRAME_GO_BACKUP_SCHEDULE_REFRESH_INTERVAL=1m
```

Node 与 Go 已识别共享数据库、Redis、backend metadata、owner 配置和共享登录/访问限流 key contract；Go 会拒绝 migrator 的非 `none|go` 值，并要求 `CFRAME_DB_MIGRATOR=go` 只能在 `CFRAME_GO_MIGRATE_ONLY=true` 的一次性迁移进程中使用。consumer owner 只允许 `none|go` 且当前只 claim `photo` / `live-photo-video` / `video` / `photo-reverse-geocoding` / `photo-erase-location`，并在 `CFRAME_BACKUP_SCHEDULER=go` 下启动 Go 定时备份；`CFRAME_GO_BACKUP_SCHEDULE_REFRESH_INTERVAL` 控制定时备份设置重读频率，默认 1 分钟，本地 verifier override 会临时降到 1 秒以便快速观察。`CFRAME_GO_MEDIA_TOOL_PREFLIGHT` 默认 true，让 Go `/health/ready` 在 normal 服务缺少 EXIF/ImageMagick/libvips/FFmpeg 依赖时返回 not_ready；只有最小 JSON-only 实验或测试环境才应设为 false。Node 插件按 owner 开关启停，Node/Go pipeline consumer 还会通过共享 Redis runtime lease 防止同一环境下双消费者同时运行，Go 启动期遇到残留 lease 会等待重试，并通过任务行 token fencing 防止失去 claim 后继续提交。`CFRAME_RATE_LIMIT_SECRET` 是登录/访问限流的可选专用 HMAC secret，长度必须至少 32；未设置时两边都从 `NUXT_SESSION_PASSWORD` 与 `chronoframe:rate-limit:v1` 派生同一 key，以保证 provider 切换不能绕过登录或站点解锁限流。动态 route ownership、生产 ACL/secret 和 worker handoff 演练尚未完成，因此这些变量目前只支撑本地学习栈，不能单独构成生产安全证明。

配置加载要求：

- 启动时严格验证；
- secret 不打印；
- 两边对 duration、size、URL、boolean 使用同样解析；
- readiness 显示缺失项名称但不显示值；
- 不允许使用语言默认值悄悄产生差异；
- 运行时设置与环境变量的优先级写入契约。

## 16. Docker Compose 参考拓扑

仓库中的 `deploy/dual/compose.yaml` 与 `Caddyfile` 是已实现的本地学习栈：绑定宿主 loopback，Caddy 将正常请求交给 Node，Node 再依据 `system:backend.readProvider` 对已登记且 Go-capable 的 HTTP operation 转发给内部 Go；该分流判断直读 SQLite 中的 provider 控制项，因此后台刚切换到 `node` 或 `go` 后，下一次已登记 API 请求不需要等待普通 settings 缓存 TTL；同时保留 `/__lab/go/*` 直连入口。Node 与 Go 默认通过 Docker named volume `app_data` 共享 SQLite/WAL 和本地媒体文件，避免 macOS bind mount 在跨容器 SQLite WAL 场景下出现不可见写入或 `disk I/O error`；fixture 也通过 Compose `fixture` 工具服务在同一个 volume 内写入。Go 使用可写共享数据卷，能读取共享 worker telemetry，并可执行手动 backup API；当 `CFRAME_BACKUP_SCHEDULER=go` 时也可持有定时备份 actor。默认 `deploy/dual` 仍由 Node 执行 migration，`deploy/dual/compose.go-migrator.yaml` 可把 schema bootstrap 和默认 settings 初始化交给一次性的 Go migrator，并让 Node/Go API 服务等待它完成。该学习栈使用单一开发 Redis 用户和开发默认密码，不具备生产 ACL、secret rotation、资源上限或动态控制面，因此禁止直接公网部署。

`deploy/dual/compose.go-primary.yaml` 是完整的 Go owner 拓扑，而不是单能力实验叠加：one-shot `go-migrator` 首先应用共享 Drizzle ledger，随后 Go API 独占 pipeline consumer 和 backup scheduler；Node 对这三个 actor 都只声明 owner=`go` 并跳过自身实现。该 override 用 `depends_on: !override` 明确把 Go API 的启动依赖收敛为 `go-migrator + redis`，不存在 Node 依赖；同时将 Go 直连端口仅发布到 loopback。Node 仍必须运行才能提供 Nuxt 页面与管理后台控制面，但停止 Node 不会停止或降级 Go 后端 API。

### 16.1 运行当前本地学习栈

首次体验建议直接使用 Compose 默认的 Docker named volume，不要指向正在使用的生产数据库。以下命令在仓库根目录执行：

```bash
export CFRAME_DUAL_PORT=33100
export CFRAME_DUAL_REDIS_PORT=36379

pnpm dual:config
pnpm dual:up
```

`Publish Images` 工作流会为 Node 和 Go 分别发布多架构镜像：`ghcr.io/<owner>/chronoframe` 与
`ghcr.io/<owner>/chronoframe-go`。要在本机用同一 SHA 的已发布镜像复验双栈，可显式指定镜像并禁止
Compose 从工作区重新构建：

```bash
export CFRAME_NODE_IMAGE=ghcr.io/<owner>/chronoframe:sha-<short-sha>
export CFRAME_GO_IMAGE=ghcr.io/<owner>/chronoframe-go:sha-<short-sha>

docker compose -f deploy/dual/compose.yaml pull node go
docker compose -f deploy/dual/compose.yaml up --no-build -d
```

不设置这两个变量时，现有 `pnpm dual:up` 仍从当前工作区构建
`chronoframe-node:dev` 与 `chronoframe-go:dev`，开发流程保持不变。

完整 Go owner 模式使用单独命令，直连端口默认是 `38080`，可用 `CFRAME_DUAL_GO_PORT` 覆盖：

```bash
export CFRAME_DUAL_GO_PORT=38080
pnpm dual:config:go-primary
pnpm dual:up:go-primary
```

生产式独立性门禁会先由编排停掉 `gateway` 与 `node`，再执行 `pnpm dual:verify-go-standalone`。它要求 `/health/live`、`/health/ready`、`/version` 全部通过，85 条非 runtime route 均由 Go 响应且不出现 5xx，并完成真实管理员读取、设置写入/恢复和 Go 自己的登录、session 读取、`DELETE /api/_auth/session` 撤销。任何清理失败都会使门禁失败。

如果确实需要在宿主机直接查看 SQLite 或媒体文件，可以设置 `CFRAME_DATA_DIR="$PWD/.data/dual-lab"` 覆盖为 bind mount；但在 macOS/OrbStack/Docker Desktop 上，跨容器共享同一个 SQLite WAL 更推荐使用默认 named volume。

启动完成后，入口与职责如下：

| 地址                                                             | 实际处理者 | 用途                                                                                                 |
| ---------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| `http://127.0.0.1:33100/`                                        | Node/Go    | 页面由 Node 提供；已登记 Go-capable API 可由 Node 转发到 Go                                          |
| `http://127.0.0.1:33100/api/access/config`                       | Node 或 Go | 管理员访问控制配置读取，受 provider 开关控制                                                         |
| `http://127.0.0.1:33100/api/admin/users`                         | Node 或 Go | 管理员用户列表读取，受 provider 开关控制                                                             |
| `http://127.0.0.1:33100/api/system/settings/all`                 | Node 或 Go | 公共设置读取，受 provider 开关控制                                                                   |
| `http://127.0.0.1:33100/api/access/status`                       | Node 或 Go | 公开访问状态读取，受 provider 开关控制                                                               |
| `http://127.0.0.1:33100/api/albums`                              | Node 或 Go | 公开/管理相册列表读取，受 provider 开关控制                                                          |
| `http://127.0.0.1:33100/api/albums/{albumId}`                    | Node 或 Go | 相册详情读取，受 provider 开关控制                                                                   |
| `http://127.0.0.1:33100/api/profile`                             | Node 或 Go | 登录用户 profile 读取，受 provider 开关控制                                                          |
| `http://127.0.0.1:33100/api/photos`                              | Node 或 Go | 公开/管理照片列表读取，受 provider 开关控制                                                          |
| `http://127.0.0.1:33100/api/photos/visible`                      | Node 或 Go | 公开可见照片列表读取，受 provider 开关控制                                                           |
| `http://127.0.0.1:33100/api/photos/map`                          | Node 或 Go | 公开照片地图/聚类读取，受 provider 开关控制                                                          |
| `http://127.0.0.1:33100/api/photos/status`                       | Node 或 Go | 登录用户最近照片状态读取，受 provider 开关控制                                                       |
| `http://127.0.0.1:33100/api/photos/{photoId}/albums`             | Node 或 Go | 照片所属可见相册读取，受 provider 开关控制                                                           |
| `http://127.0.0.1:33100/api/photos/{photoId}/livephoto`          | Node 或 Go | Live Photo 元数据读取，受 provider 开关控制                                                          |
| `http://127.0.0.1:33100/api/photos/{photoId}/reactions`          | Node 或 Go | 单照片反应统计读取，受 provider 开关控制                                                             |
| `http://127.0.0.1:33100/api/photos/reactions`                    | Node 或 Go | 批量照片反应统计读取，受 provider 开关控制                                                           |
| `http://127.0.0.1:33100/api/queue/task/list`                     | Node 或 Go | 管理员队列任务列表读取，受 provider 开关控制                                                         |
| `http://127.0.0.1:33100/api/queue/stats`                         | Node 或 Go | 全局 worker/queue 状态读取；Go consumer active 时优先本地 worker stats，否则回退共享 Redis telemetry |
| `http://127.0.0.1:33100/api/queue/stats/{taskId}`                | Node 或 Go | 当前用户/管理员队列任务详情读取，受 provider 开关控制                                                |
| `http://127.0.0.1:33100/api/system/backup/run`                   | Node 或 Go | 管理员手动数据库备份触发，受 provider 开关控制                                                       |
| `http://127.0.0.1:33100/api/system/settings/{namespace}`         | Node 或 Go | 管理员设置 namespace 读取，受 provider 开关控制                                                      |
| `http://127.0.0.1:33100/api/system/settings/{namespace}/{key}`   | Node 或 Go | 管理员设置单项读取，受 provider 开关控制                                                             |
| `http://127.0.0.1:33100/api/system/settings/fields`              | Node 或 Go | 管理员设置表单字段读取，受 provider 开关控制                                                         |
| `http://127.0.0.1:33100/api/system/settings/schema`              | Node 或 Go | 管理员设置 schema 读取，受 provider 开关控制                                                         |
| `http://127.0.0.1:33100/api/system/settings/storage-config`      | Node 或 Go | 存储配置列表读取，受 provider 开关控制                                                               |
| `http://127.0.0.1:33100/api/system/settings/storage-config/{id}` | Node 或 Go | 存储配置详情读取，受 provider 开关控制                                                               |
| `http://127.0.0.1:33100/api/upload-shares`                       | Node 或 Go | 当前用户上传分享列表读取，受 provider 开关控制                                                       |
| `http://127.0.0.1:33100/api/upload-shares/public/{token}`        | Node 或 Go | 有效上传分享信息读取，受 provider 开关控制                                                           |
| `http://127.0.0.1:33100/__lab/go/api/system/settings/all`        | Go         | 精确直连学习入口，不受全局 provider 开关影响                                                         |
| `http://127.0.0.1:33100/__lab/go/api/photos`                     | Go         | 精确直连公开照片学习入口                                                                             |
| `http://127.0.0.1:33100/__lab/go/api/photos/visible`             | Go         | 精确直连公开照片学习入口                                                                             |
| `http://127.0.0.1:33100/__lab/go/api/photos/map`                 | Go         | 精确直连地图学习入口                                                                                 |
| `http://127.0.0.1:33100/__lab/go/api/photos/status`              | Go         | 精确直连照片状态学习入口                                                                             |
| `http://127.0.0.1:33100/health/ready`                            | Go         | Go 的数据库与 Redis 就绪状态                                                                         |

本地学习栈会给 Node 和 Go 注入同一组开发默认 session/OG signing secret；正式环境必须使用 `.env` 固定自己的 `NUXT_SESSION_PASSWORD` 与 `NUXT_OG_IMAGE_SECRET`，并建议单独配置至少 32 位的 `CFRAME_RATE_LIMIT_SECRET`，不能依赖开发默认值。

对任一 `allowCompare: true` 的无副作用 GET 执行差分：

```bash
node scripts/compare-backends.mjs \
  --node http://127.0.0.1:33100 \
  --go http://127.0.0.1:33100/__lab/go \
  --path /api/system/settings/all
```

要批量执行当前契约中全部可比读接口，先写入幂等固定夹具。夹具会写入固定管理员、照片、相册、已完成队列任务、存储配置、上传分享 token，并在共享 Redis 中写入 Node/Go 都能识别的 `cf_session`。默认 named volume 模式下应使用容器化 seed，让 fixture 与 Node/Go 使用同一个 Linux volume：

```bash
pnpm dual:seed-compare:container
```

宿主机 seed 命令 `pnpm dual:seed-compare` 仍保留给显式 `CFRAME_DATA_DIR` / `DATABASE_URL` 的调试场景使用。

fixture 管理员也可用于浏览器登录验证：

| 字段 | 值                                             |
| ---- | ---------------------------------------------- |
| 邮箱 | `dual-backend-fixture-admin@chronoframe.local` |
| 密码 | `DualBackendFixture123!`                       |

如果服务已经在 seed 前启动，需要让 Node/Go 的长期 SQLite 连接重新打开数据库；推荐的稳定验证顺序是：

```bash
pnpm dual:seed-compare:container
docker compose -f deploy/dual/compose.yaml restart node go
pnpm dual:seed-session:container

pnpm dual:compare:container

pnpm dual:verify-route-surface:container

pnpm dual:verify-route-boundaries:container

pnpm dual:verify-switch:container -- \
  --iterations 3

pnpm dual:verify-mutations:container

pnpm dual:verify-albums:container

pnpm dual:verify-admin-users:container

pnpm dual:verify-reactions:container

pnpm dual:verify-livephoto:container
pnpm dual:verify-photos-read:container
pnpm dual:verify-photos-write:container

pnpm dual:verify-system-reads:container
pnpm dual:verify-system-logs:container
pnpm dual:verify-wizard:container
pnpm dual:verify-share-og:container

pnpm dual:verify-queue-control:container

pnpm dual:verify-runtime-owners:container

pnpm dual:verify-backup:container

pnpm dual:verify-authz:container

pnpm dual:verify-oauth:container

pnpm dual:verify-redis-outage:container

pnpm dual:verify-media-parity:container

pnpm dual:verify-openlist-storage:container
```

第一次 seed 写入 SQLite 业务夹具，并写入固定管理员与普通用户；重启让两个服务重新加载设置与用户行；第二次只使用 `--redis-session-only` 刷新固定 Redis session，不再打开 SQLite。完整 seed 还会在共享 local storage 中写入 `dual-fixture-photo-editable` 的真实 JPEG 对象，用于照片元数据成功更新验收；`dual-fixture-photo-1` 继续保持缺失原图文件，用于 404 错误边界验收；`dual-fixture-preview-locked-album` 会作为访问保护开启且 `albumLimit=1` 时的预览外公开相册详情 401 样本。

`dual:compare:container` 会从 route contract 派生所有 `GET + sideEffect: none + allowCompare: true` 的安全样本，当前固定 fixture 下会比较 40 个读取场景，包含照片管理搜索/分页/媒体类型和地图范围的重复 query、后台 `queue.stats` 与管理员 `system.stats`，并要求 Node/Go 状态码、JSON body、`Content-Type`、`X-ChronoFrame-Backend`、`X-Request-Id` 和无 `Set-Cookie` 副作用一致；时间戳、进程 uptime、worker uptime 与内存 used 这类天然运行态字段只通过显式 normalizer 忽略。`dual:verify-switch:container` 会从 Compose tools 网络直连 `http://go:8080`，先调用 Go 服务自己的 settings 写接口把 `backend.readProvider` 写为 `go`，再直连 Go 写入临时 `app.slogan`，随后通过网关切回 Node，并由 Node 立即读回 Go 直连写入的 slogan；随后脚本反复执行 `backend.readProvider: node → go → node`，并用 `/api/system/settings/system/backend.readProvider` 与 `/api/system/settings/all` 的 `X-ChronoFrame-Backend` 响应头证明 provider 切换立即生效。脚本还会先捕获原 `app.slogan`，在 provider=`go` 时经网关写入临时 slogan，切回 provider=`node` 后读回同一值，最后恢复原 slogan 和 provider。脚本默认使用固定 fixture session，失败时会尽量恢复为 `node`，避免把本地学习栈留在 Go provider。

`dual:verify-go-readiness:container` 会先探测 `http://gateway/health/ready` 和 `http://go:8080/health/ready`，要求响应头来自 Go、`checks.database/redis/mediaTools` 都为 `ok`，并返回整数型 schema migration 摘要。`dual:verify-route-surface:container` 会先把 provider 切到 Go，再对 route contract 中 85 个 Go-capable 非 runtime HTTP operation 发送无有效业务 body、无认证 Cookie 的探针请求；除切换开关本身必须继续由 Node 返回外，每个已登记 operation 都必须经网关返回 `X-ChronoFrame-Backend: go` 且不能是 5xx。随后脚本会对同一批 85 个 operation 通过 `/__lab/go` 直连 Go API 面再探一次，同样要求 `X-ChronoFrame-Backend: go` 且不能是 5xx，最后自动切回 Node。脚本 summary 会输出 `surfaceCounts.gateway=85`、`surfaceCounts.lab=85` 和 `probeCount=170`，用于直接审计网关切换面和独立 Go 直连面都已跑到。它证明的是真实 Node 网关不会在 provider=go 时把某个已登记 API 悄悄落回 Node，也证明 Go lab 直连 API 面与 registry 覆盖一致；它不替代业务字段级 parity。`dual:verify-route-boundaries:container` 会先把 provider 固定到 Node，随后对同一 85 个 Go-capable 非 runtime HTTP operation 分别请求 Node 网关和 `__lab/go` 直连 Go；探针同样不带认证 Cookie 和有效业务 body，要求 status、`Content-Type`、`X-ChronoFrame-Backend`、`X-Request-Id` 回显、redirect `Location`、`Set-Cookie` 有无和规范化 body 一致，并显式忽略运行时 URL/stack、匿名 session id、时间戳、uptime、内存 used 与 worker uptime。它补上了全量 route set 的匿名/空 body 基础错误边界，已固定 login/access verify 的 ZodError、匿名 `_auth/session`、`/api/logout` 与 `_auth/session` delete 的不同返回体、reaction 缺参 Nitro 错误形状，但仍不替代带真实业务 payload 的完整错误矩阵。

`dual:verify-mutations:container` 会在 Compose tools 网络中使用同一 fixture session 验证一组可逆或确定性 mutation/API 切片：设置值、照片上传准备、内部对象 PUT、照片重复检测、后台用户 CRUD、相册 CRUD、照片-相册关系、公开 reaction create/update/delete、照片元数据更新、存储配置 CRUD 和上传分享 CRUD；每个切片都要求写入端响应头等于当前 provider，并在切到另一端后的下一跳立即读回一致的关键字段或返回一致的响应形状；照片-相册切片还会覆盖 bulk add/remove 的 `success/updatedCount/mode` 响应字段，公开 reaction 切片会覆盖 created/updated/deleted 响应字段和跨端 `userReaction` 读回。上传准备切片要求 Node/Go 对同一 `fileName/contentType/contentHash` 返回完全一致的 `signedUrl/fileKey/contentHash/expiresIn` 字段集，并固定 active local storage prefix 拼接和 `encodeURIComponent` 路径编码；active S3 provider 切片会创建临时 S3 配置、切换 `/api/system/settings/storage/provider`，分别经 Node/Go 调用照片上传准备，校验 `fileKey/contentHash/expiresIn` 与预签名 URL 的 scheme/host/path、`X-Amz-Expires=3600`、`X-Amz-SignedHeaders=host`、credential access key/region/service 等稳定字段，随后恢复原 active storage provider 并删除临时配置；内部对象 PUT 切片会用上传准备返回的 `fileKey` 分别经 Node/Go 写入共享 local storage，并校验 `{ ok, key }` 响应字段；重复检测切片要求 content hash 规范化、非法 hash 的 `null` 表达、文件名派生 `photoId`、结果顺序、`duplicatesFound` 与 summary 文案保持一致。后台用户切片覆盖 Node 创建后 Go 读/改、Go 创建后 Node 读/改和双端删除，并对 create/update 响应体执行精确字段集校验，防止 Go 比 Node 多返回 `avatar`、`createdAt` 等响应形状漂移；存储配置切片覆盖 Local/S3/OpenList 三类 provider 的 create/update，要求 S3 `region/prefix` 与 OpenList endpoint/pathField 默认值、provider literal 校验和未知字段剥离与 Node Zod schema 一致；上传分享切片同样会对 create/update 响应体执行精确字段集校验，并要求 `createdAt`、`updatedAt`、`expiresAt`、`lastUsedAt` 使用 Node `Date.toISOString()` 一致的毫秒级 UTC 时间格式。照片元数据切片覆盖 Node 写后 Go 读、Go 写后 Node 读，并要求标题、描述、tags、Rating、成功响应形状和共享 DB 关键字段一致；Go 写入路径会先读取原对象、调用 exiftool 重写 EXIF、覆盖对象存储、重新抽取 EXIF，再更新 SQLite。该脚本会恢复 `app.slogan`、原 active storage provider、fixture 照片的原始相册关系和可编辑照片的主要元数据，并删除临时 user/album/reaction/storage-config/upload-share；它证明的是基础数据库/API mutation parity、上传准备/active S3 预签名 URL/内部对象 PUT/重复检测响应契约与真实 local 对象重写链路，不替代外部对象存储真实 PUT、EXIF list 标签字节级矩阵、资源限制或故障注入矩阵。

`dual:verify-albums:container` 是相册能力的独立晋级门禁，而不是只复用综合 mutation smoke。它覆盖全部 9 条 `albums-read` / `albums-write` route：先比较 5 组固定 fixture 读取，再比较 42 组匿名、跨 owner、非法/非正 album id、缺失/错误字段、非法 bulk mode 和缺失资源边界，最后分别执行 Node 创建→Go 更新/删除与 Go 创建→Node 更新/删除的完整生命周期。两轮生命周期还验证 cover 自动关系、单照片关系替换、bulk remove、跨端列表/详情可见性和 create/update 精确字段集。共 88 项检查要求 status、`Content-Type`、backend/request-id header、无 `Set-Cookie`、完整 JSON body 与嵌套 Zod `data` 一致，只排除动态 `url` 和 `stack`；`finally` 会恢复可编辑照片的原相册关系、删除临时相册并恢复原 provider。该门禁通过后，清单中的 9 条相册 route 才允许标记为 `verified`。

`dual:verify-admin-users:container` 是 `users-admin` capability 的独立晋级门禁，覆盖全部 4 条用户列表、创建、更新和删除 route。它先执行确定性列表对比和 49 组认证、空/null/malformed body、完整嵌套 Zod issue、UTF-16 长度、email 校验转换时机、创建冲突、更新冲突、JavaScript 十六进制/小数/科学计数路径 coercion、缺失资源和管理员自保护边界，再分别执行 Node 创建→Go 管理与 Go 创建→Node 管理的完整生命周期。两轮均验证跨端列表可见、真实密码登录、相册 owner 关系、用户名/email/密码/角色/启用状态更新、管理员删除保护、降级后删除、相册归属转移和删除用户 session 的 401 + 清 Cookie 行为。共 110 项检查要求 status、`Content-Type`、backend/request-id header、Cookie 副作用、完整 JSON body 与嵌套 Zod `data` 一致，只排除动态 `url` 和 `stack`；`finally` 会删除临时用户、相册和 Redis session 并恢复 provider。该门禁通过后，清单中的 4 条后台用户 route 才允许标记为 `verified`。

`dual:verify-reactions:container` 是 `reactions-read` / `reactions-write` capability 的独立晋级门禁，覆盖全部 4 条单照片 GET/POST/DELETE 与批量 GET route。它比较公开/隐藏/缺失/空白照片、重复与空 `ids` query、访问控制、无 body、空/null/malformed/trailing JSON、primitive/array/object 根值和 reaction type 枚举边界，再执行 Node 创建→Go 读取和更新→Node 批量读取和删除，以及 Go 创建→Node 读取和更新→Go 批量读取和删除的双向生命周期。匿名指纹用例证明两个访客的 `userReaction` 相互隔离；限流用例先通过真实 Caddy→Node 请求捕获代理链实际生成的指纹，再向共享 SQLite 写入 10 条窗口内记录，要求 Node 与 Go 对同一请求都返回 429 且不产生第 11 条记录。共 72 项检查要求 status、`Content-Type`、backend/request-id header、无意外 `Set-Cookie`、完整 JSON body 和错误 envelope 一致，只排除动态 `url` / `stack`；`finally` 会按指纹和 User-Agent 删除临时行并恢复 provider。该门禁通过后，清单中的 4 条照片表态 route 才允许标记为 `verified`。

`dual:verify-system-logs:container` 专门覆盖普通 JSON 差分无法处理的管理后台日志 SSE。脚本在 fixture 容器中写共享 `/app/data/logs/app.log`，分别经 Node/Go 验证精确 `text/event-stream`、private/no-store/no-transform 缓存策略和 `X-Accel-Buffering: no`；初始读取矩阵固定 `initial` 缺失默认值、空值归零、十六进制/科学计数/小数的 JavaScript `Number()` 语义、带空格的 `all`、重复 query fallback、`all` 和普通模式 2 MiB 截断，并用 `initial=0` 在连接建立后追加日志验证两端都能实时推送。finally 恢复 provider=node。

`dual:verify-system-reads:container` 是 public settings 与 system stats 两条路由的独立晋级门禁。22 项生产镜像检查先直连 Node/Go，固定 boolean/number/string/json/null 等已持久化公开设置的逐类型解码、必需 `system:firstLaunch`、private 值排除及 query 不影响响应；再验证匿名 stats 401、管理员全局 photo/storage/trend/runtime、普通用户 owner-scoped photo/storage/trend 与 runtime 隐藏，并通过真实网关各切换一次 Node/Go。动态 uptime/内存字段只按显式 normalizer 忽略，`finally` 恢复数据库夹具、共享 settings cache version 和 provider=node。

`dual:verify-queue-control:container` 是全部 8 条 `pipeline-control` 路由的能力晋级门禁。脚本要求显式传入 SQLite 路径；在默认 named volume 双栈中应使用容器命令，让工具容器直接访问 `/app/data/app.sqlite3`。固定的 124 项生产镜像检查由 8 个读取、78 个 Node/Go 成对边界和 38 个双向生命周期/控制检查组成：读取覆盖任务详情、共享 worker telemetry、全量与过滤列表；边界覆盖匿名/成员/管理员和 owner 隔离、EOF/空/malformed/trailing/primitive JSON、嵌套 Zod、重复 query、JavaScript `Number()` 路径 ID 与 `parseInt()` clear 参数。所有成对响应逐项比较状态码、完整 canonical JSON、Content-Type、backend/request-id 响应头，并拒绝意外 `Set-Cookie`。生命周期会创建高位临时 `pipeline_queue` 任务行，执行 Node→Go 与 Go→Node 单条/批量入队读回、targeted/batch retry、安全 no-op clear；真实 clear 删除分支先直查 SQLite，确认命中的 completed/failed 行全部属于本次登记的临时 task id，才经 HTTP 删除。脚本在 `finally` 精确删除登记过的任务并恢复 provider；若前置条件不满足，它会拒绝执行 destructive clear。

`dual:verify-settings-control:container` 是全部 11 条 `settings-control` 路由的能力晋级门禁，必须在可访问共享 SQLite named volume 的 tools 容器内运行。固定的 185 项生产镜像检查由 13 个确定性读取、104 个 Node/Go 成对边界和 68 个双向生命周期检查组成。读取覆盖 namespace、key、schema、过滤后的 fields 和 storage config；边界覆盖三层鉴权、EOF/null/malformed/trailing/primitive JSON、完整 Zod issue 顺序、readonly/type/enum/missing-pair、batch partial failure、Local/S3/OpenList discriminated union 与嵌套字段，以及 JavaScript `parseInt(value, 10)` 对十进制前缀、小数、十六进制的路径语义。生命周期分别从 Node 与 Go 写入 string/number/boolean/enum/null 和 batch，要求对端立即读到共享 SQLite 值与 Redis cache version；随后由两端各自创建、读取、更新、列出和删除三类 storage config，并验证默认值和未知字段剥离。所有成对响应比较完整 canonical JSON、状态码、Content-Type、backend/request-id 与无意外 `Set-Cookie`；`finally` 精确删除登记过的配置并恢复设置、active storage 和 backend provider。门禁通过后，这 11 条 route 才可标记为 `verified`。

`dual:verify-media-read:container` 是全部 8 条 `media-read` 路由的能力晋级门禁，必须在可访问共享 SQLite 与 Local storage named volume 的 tools 容器内运行。脚本创建颜色互异的 original PNG、thumbnail/display WebP 和 Live Photo MOV，并登记一条隔离照片；随后经真实网关分别切换 Node 与 Go，固定执行 89 项检查和 43 组成对比较。矩阵覆盖 `/image`、`/storage` 的 GET/HEAD、closed/open/suffix/invalid/unsatisfiable Range、current/stale If-Range、If-None-Match 与 If-Modified-Since，要求 Local `/storage` 的 mtime ETag、`/image` 的 key ETag、Last-Modified、Cache-Control、Accept-Ranges、Content-Range 和 Vary 完全一致；还覆盖已有 `/display` 对象及 304、`/thumb` 显式 thumbnail/original key 与 original URL 回退、裸 key 拒绝、`/og-media` dedicated/derived/raw-session 三代签名和 Range 忽略、Live Photo JSON、匿名原图 401、未知 key、反斜杠与路径 traversal。二进制结果逐项比较字节长度和 SHA-256，JSON 比较 canonical body；`finally` 精确删除照片行和对象目录并恢复 provider=node。该门禁通过后，8 条 route 标记为 `verified`；大文件视频、真实 CDN/托管对象存储和长连接故障仍不因此升级为 `stable`。

`dual:verify-upload-shares:container` 是全部 8 条 `upload-shares` 路由的独立晋级门禁。它从 `dual:verify-authz` 精确选取 35 项分享相关权限、请求体、路径、token、MIME 和缺失资源边界；再执行 228 项 mutation 套件，固定 Node/Go 创建、对端读取/更新/删除、可空字段、毫秒 UTC 时间、外部分享 URL，以及两种创建端 × 两种处理端共 4 次公开 S3 prepare 预签名字段；最后在 Go consumer owner 栈中完成真实 Local 匿名读取、prepare、对象 PUT、task、photo/usage 读回、`maxUploads` 耗尽和 Node/Go 同时争抢最后一个额度。流水线稳定证据为 `publicChecks=14`、`exhaustedShareChecks=2`、`atomicQuotaChecks=6`，轮询次数导致总 `checkCount` 可变化。脚本按 route id 校验每类证据确实出现，`finally` 删除临时 photo/share/pipeline task/object、恢复 active storage 和 provider=node；管理后台浏览器 smoke 还会在 Go 模式创建并删除分享，确认 URL 使用网关 origin 后切回 Node。门禁通过后 8 条 route 标记为 `verified`；托管云 S3/CDN、大文件 multipart 和公网故障仍不因此升级为 `stable`。

`dual:verify-photos-read:container` 是全部 5 条 `photos-read` 路由的独立晋级门禁，必须在可访问共享 SQLite named volume 的 tools 容器内运行。脚本创建 530 条经度分布在 `179.5/-179.5` 的地图照片、1 条普通用户照片和 1 条隐藏相簿照片，并把预览限制临时提高到 700，要求 Node/Go 的公开照片查询仍统一封顶 500；这同时固定地图预览不聚类、认证后超过 520 点的低缩放聚类、高缩放逐点返回、普通 bounds、跨日期变更线 bounds、不完整和重复 query 的语义。管理列表覆盖管理员/普通用户 owner scope、分页、meta-only、搜索、image/video 过滤；status 只忽略动态时间戳；重复检测覆盖匿名/空/null/malformed/Zod 边界、单个及全部空数组成功、SHA-256 规范化、文件名和存储 Key 派生。38 项有效检查逐项比较完整 canonical JSON、状态码、Content-Type 与 backend/request-id，并通过真实网关各执行一次 Node/Go 切换读取和重复检查。`finally` 恢复预览限制、删除全部 532 条临时照片和相簿关系、恢复 provider=node；浏览器 smoke 另验证 Go 模式后台表格、公共图库与地图标记后回切 Node。门禁通过后 5 条 route 标记为 `verified`；大数据长期压测、SQLite 锁故障和真实多用户数据分布仍不因此升级为 `stable`。

`dual:verify-photos-write:container` 是全部 6 条 `photos-write` 路由的独立晋级门禁。固定 53 项主检查覆盖创建接口缺 body、`null`、primitive、array、数字字段和 JavaScript truthiness，Node/Go 各自生成上传 URL 后实际 PUT 并比对原始字节；两端再以同一完整 payload 重写标题、描述、标签、评分和坐标，要求共享 SQLite、完整 EXIF 结构及对象 SHA-256 精确一致。单张与批量重建必须对齐标题回退、毫秒 UTC 时间、GPS 时区和图像元数据；删除必须清理原图、HEIC 转换 JPEG、thumbnail、display、Live Photo 视频/播放对象和相册关系。脚本还复用 26 项 Live Photo 双向生命周期门禁，并在 `finally` 恢复 provider=node、删除临时照片/相册/队列/对象并复查零残留。门禁通过后 6 条 route 才标记为 `verified`；真实云对象存储、大文件和故障注入仍需由各存储专项门禁覆盖。

`dual:verify-wizard:container` 是全部 7 条 wizard 路由的独立晋级门禁。固定 70 项检查覆盖 admin/site/storage/map namespace 的完整 schema、24 项 storage 字段、secret redaction、环境变量默认值、EOF/null/malformed/trailing/primitive JSON 与 Node Zod issue 顺序；成功矩阵覆盖 Local/S3/OpenList 默认值、Mapbox/MapLibre/AMap 配置、complete 跨端关闭向导，以及 Node/Go submit 创建的 session 被对端接受并能读到同一 storage。验证器在隔离 SQLite savepoint 之外显式快照并恢复 users/settings/storage config/序列、共享 settings cache version 与 provider，避免初始化测试污染现有学习数据。

`dual:verify-share-og:container` 是 `media.share-og` 的独立晋级门禁。验证器创建隔离 Local provider、真实图片、视频缩略图候选与缺失媒体 fallback 三类照片，经 Node/Go 直连和真实网关执行 14 个请求、8 组比较，固定 preview grant/admin 权限、缺失照片、严格小写 `.png` 后缀、Node→Go 即时切换、1200×600 PNG、Content-Type/Length、private cache 与 Cookie Vary。两端使用相同 SVG 模板和 libvips cover/centre/autoorient 语义；三类输出解码为统一 300×150 flattened raw pixels 后的 MAE 均为 0。`finally` 精确删除照片、对象、临时 provider/settings/序列和 Redis settings version，并恢复原 provider。

`dual:verify-runtime-owners:container` 专门验证后台 actor 的实际 owner，而不是业务响应字段。默认容器脚本 `dual:verify-runtime-owners:container` 会把 HTTP provider 固定到 Node，读取 `/api/queue/stats`，要求响应头来自 Node、`pool.isActive=true` 且 worker id 为 `worker-*`，并拒绝出现 `go-worker-*`；Go consumer override 容器脚本 `dual:verify-runtime-owners:container:go-pipeline-consumer` 会把 provider 切到 Go，要求响应头来自 Go、worker id 为 `go-worker-*`，并在结束后恢复 provider=node。它证明的是本地双栈当前配置下 consumer owner 与 telemetry 一致，不替代 drain/handoff、kill -9 或长任务故障演练。

任务行 fencing 另有源级回归测试覆盖：`tests/pipeline-queue-repository.test.ts` 直接验证共享 SQLite 的 `status='in-stages' AND claim_token=?` 条件更新不能被旧 token 写回 stage/complete；`backend/go/internal/queue/repository_test.go` 验证 Go repository 对旧 token 的 stage、refresh lease、complete 均拒绝并保持原 claim 不变。`backend/go/internal/app/pipeline_consumer_test.go` 还验证正常退出不会取消已领取任务或提前释放 runtime lease，`tests/pipeline-consumer-shutdown.test.ts` 固定 Node drain 超时必须保留 runtime lease。上述测试用于固定 Node/Go 共同依赖的数据库与退出契约，真实进程崩溃、长任务超时和完整 handoff 仍由后续生产式演练覆盖。

`dual:verify-backup:container` 专门覆盖手动 database backup 成功路径。脚本会临时启动一个极简 fake SMTP，捕获邮件但不连接真实邮件服务；容器模式应使用 `dual:verify-backup:container`，工具容器会把 `--smtp-host self` 展开为当前容器 hostname，Node/Go 服务再通过共享 Compose network 连接它，避免一次性 `fixture` 容器名被外部 DNS 解析污染。脚本会先用 Node 管理 API 捕获原备份设置，再临时写入 `smtpHost/smtpPort/smtpSecure=false/mailFrom/mailTo/encryptionPassphrase` 等配置，分别切换 provider 到 `node` 和 `go` 调用 `/api/system/backup/run`，要求响应头、`success/result.fileName/filePath/size/encrypted/sentTo/createdAt` 字段一致；随后从 fake SMTP 邮件中解析附件，确认附件大小等于 API 返回值，解密 `CFDBENC2` envelope、gunzip，并校验明文以 SQLite header 开头。最后脚本恢复 provider 和原备份设置；在工具容器可访问 `/app/data/backups` 时会删除本次生成的备份文件，除非显式传 `--keep-files`。该脚本验证的是手动备份的共享 SQLite + SMTP + 加密附件链路；定时 scheduler owner 由 `dual:verify-go-backup-scheduler:container` 单独覆盖，两者都不代表真实外部 SMTP 或长期保留策略已完成生产演练。

Go 单元测试还固定了公开 reaction 60 秒/10 次 fingerprint 限流、POST 缺失照片 404、超限时不更新已有 reaction、照片删除时的 HEIC 转换 JPEG/displayKey 副作用列表，以及队列入队 payload schema 规范化：`add-task` 支持 photo/live-photo-video/video/reverse-geocoding/erase-location，`add-tasks` 按 Node 当前 schema 不接受 video 分支并剥离 photo.contentHash，非法 contentHash/boolean/坐标会被拒绝，非管理员必须拥有对应 storageKey/photoId；公开上传分享 Key 也会固定 provider prefix、owner/share/date 目录、随机 hex 后缀和安全扩展名。

`dual:verify-authz:container` 会先将网关 provider 固定到 `node` 并在结束后恢复原值，再使用管理员与普通用户固定 session，对 145 条代表性权限/错误边界和 8 条成功响应进行 Node/Go 直连差分：匿名 401、普通用户访问管理员资源 403、普通用户访问隐藏 display 派生媒体 404、访问保护开启时匿名访问预览外公开相册详情 401、非法设置 namespace/key 400、设置字段缺失/空/重复 namespace 400、队列 list/clear 重复筛选参数 500、照片上传和公开分享上传重复 key 500、设置字段未知 namespace 404、设置单项缺少 `value` 400、设置批量缺少/错误 `updates` 与非法 update 400，并固定空/null/malformed/尾随多段 JSON 的根对象或 H3 解析错误、相册创建/更新空值与缺失字段的 Zod detail、上传分享管理 create/update 的 null、字段类型、trim 后 UTF-16 长度、safe-int 上下界与非法/可转换数值路径错误、照片元数据更新的缺 body/null/字段类型/UTF-16 长度/标签/location/rating/畸形 JSON/空对象/空白 ID 校验、EXIF/LivePhoto 管理 action 校验 400、照片-相册关系 body/缺失资源校验 400/404、认证后照片上传准备空/null body 400、重复检测缺 body/null body Zod 校验、重复检测缺少全部输入时的 `data.title/data.message` 与 JSON 字段顺序、重复检测数组字段/元素类型 Zod 校验、公开上传分享 prepare/task 的 Zod 校验、公开上传分享 upload 缺 key 400 与不支持 MIME 415、公开 reaction 缺失删除 404（Nitro 形状为 `statusMessage: "Server Error"`、`message: "Reaction not found"`）、照片更新缺失原图文件 404、缺失资源 404，以及普通用户 system stats 的 runtime 隐藏、照片/存储/趋势 body 关键字段；脚本在 tools 容器内使用 Node=`http://gateway`、Go=`http://gateway/__lab/go`，要求 `statusCode`、`statusMessage`、`message`、`X-ChronoFrame-Backend`、`Content-Type`、`X-Request-Id`、无 `Set-Cookie` 副作用和成功 body 关键字段一致。它覆盖的是代表性权限/错误/成功边界，仍不替代完整越权矩阵。

`dual:verify-oauth:container` 专门固定 GitHub OAuth 的协议级兼容性。它先捕获并临时替换 `auth.github.enabled/clientId/clientSecret`，然后对 Node 网关和 Go lab 面执行 8 组不触发真实 GitHub token exchange 的请求，覆盖初始授权、空 code、重复/空 error、缺失或重复 state、重复 code 与已有 state Cookie。比较范围包含 302/401、GitHub `Location` 的 UFO 编码与参数顺序、H3 meta-refresh body、8-byte 随机值对应的 11 字符 base64url state、`nuxt-auth-state` 的完整 Set-Cookie 属性、Cookie 清理和 `GitHub`/`Github` 大小写敏感错误文案；随机 state 会在分别验证格式后归一化。脚本无论成功失败都会恢复原 OAuth 设置与 provider。真实 GitHub 授权码交换和账号成功登录仍需用受控测试 OAuth App 单独验收。

`dual:verify-identity:container` 不复用 fixture 预置 session 作为身份互通结论，而是分别把 provider 切到 Node 和 Go，使用固定管理员真实密码调用 `/api/login`，校验各自返回 201、空响应体/无 Content-Type、正确 backend header 以及新的 32-byte base64url `cf_session` Cookie。每个运行时各签发两组动态 session：一组通过对端 `/api/logout` 撤销，另一组通过对端 `DELETE /api/_auth/session` 撤销。每次跨端撤销后，Node 网关和 Go lab 面都必须对旧 Cookie 返回 401；两端 profile body 逐字段相等且不含 password。当前门禁稳定输出 26 项检查，失败清理会撤销残余动态 session 并恢复原 provider。配合 `dual:verify-oauth:container` 的 8 组 callback 协议差分，route manifest 中 6 条 `identity` operation 可以标记为 `verified`。

`dual:verify-access-control:container` 是 access-control capability 的生产式深度门禁。它先捕获 provider、访问配置和只读 `access.version`，再分别让 Node/Go 更新同一份 SQLite 配置和签发同协议 `cf_access`；每个 32-byte base64url grant 都必须被另一端读取。Go 递增版本后，Node/Go 都必须将旧 grant 与损坏 token 判为未授权预览，并返回字节级相同顺序的 `cf_access=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`。限流阶段把 5 次失败交替分给两端，第 6、7 次必须同时返回 429 和正数 `Retry-After`，证明 provider 切换不能绕过共享 Redis Lua bucket。finally 通过 fixture 挂载的 SQLite 精确恢复只读版本号、递增共享 settings cache version、恢复访问配置/provider，并删除只属于本次运行的 access/rate-limit key。门禁稳定输出 20 项行为检查且清理零失败后，4 条 access-control Go 路由可标记为 `verified`；真实公网代理链、长期并发压测和 Redis 集群故障尚未覆盖，因此不能标记 `stable`。

`dual:verify-media-parity:container` 专门覆盖普通 JSON 差分与单端上传链路都不擅长证明的二进制媒体一致性。脚本会先经 Go prepare/PUT/queue/consumer 生成一张本地 PNG 与派生 thumbnail/display 对象，然后对同一组 `/image/...`、`/storage/...`、`/display/{photoId}` 与 `/thumb/{thumbnailUrl...}` URL 依次切到 Node 与 Go 读取，比较状态码、`Content-Type`、`Cache-Control`、`Content-Range`、`Accept-Ranges`、`Vary`、响应字节长度与 SHA-256；所有样本都以稳定业务响应头、实际收到的字节长度和 SHA-256 为准；Range 长度由 206 状态、`Content-Range` 和实际字节数共同证明，避免把代理层 fixed-length/chunked 或 `Content-Length` 省略差异误判为业务差异。样本包含原图 `/image` 完整 GET/HEAD/suffix Range/stale `If-Range`、原图 `/storage` 完整 GET/HEAD/suffix Range、派生 thumbnail/display 对象直读，以及 `/display`、`/thumb` 用户级媒体入口。脚本结束后会删除临时照片并恢复 provider=node。它证明的是同一共享对象存储内容在 Node/Go 媒体路由上的稳定头部与字节级一致，不替代外部 S3/CDN、浏览器缓存或大文件视频 Range 压测。

`dual:verify-s3-storage:container` 将相同媒体 parity 扩展到真实 S3 协议实现。`compose.s3.yaml` 启动仅绑定 loopback、数据位于 tmpfs 的临时 MinIO；验证器创建隔离 bucket，通过 Go 管理 API 创建并启用 S3 storage config，然后先后以 Node 和 Go 作为 prepare/delete owner。每轮使用后端生成的绝对预签名 URL 直接 PUT 到 MinIO，由唯一 Go pipeline consumer 生成 thumbnail/display，再对 22 组 `/image`、`/storage`、`/display`、`/thumb`、HEAD、Range 和 stale If-Range 响应执行 Node/Go 字节与稳定头部对比。删除照片后必须立即确认 bucket 为空；finally 会恢复 backend provider 和原 storage provider、删除临时 storage config、残留对象与 bucket。该门禁已经覆盖 MinIO S3，但不等价于托管云 S3、CDN、真实 OpenList、跨公网超时或大文件 multipart 验收。

`dual:verify-openlist-storage:container` 将相同媒体 parity 扩展到 OpenList HTTP 协议。验证器在 Compose tools 容器内启动隔离的内存 fixture，实现带 Bearer token 的 `/api/fs/put`、`/api/fs/get`、`/api/fs/remove`、配置 `downloadEndpoint` 和 metadata 返回的 `raw_url`；Go 管理 API 创建并启用临时 OpenList storage config，Node 管理 API 再把同一配置切到 `raw_url` 下载模式。验证器按 Node/Go prepare-delete owner × 两种下载模式执行 4 轮完整流水线，每轮都由唯一 Go consumer 生成 thumbnail/display，并比较 22 组 Node/Go 媒体响应，合计 88 组结果。fixture 故意对 Range 请求返回 200 全量对象，要求 Node/Go provider 都在客户端按范围切片；同时拒绝错误 token、非隔离 rootPath、重复 rootPath 和未知协议请求。每轮删除后对象必须为空，finally 还会恢复 backend provider 与原 active storage provider、删除临时配置并关闭 fixture。该门禁覆盖协议级认证、上传、metadata、两种下载、删除与 Range fallback，不等价于真实托管 OpenList、CDN、跨公网超时或大文件传输。

`dual:verify-redis-outage:container` 必须运行在宿主机，而不是 Compose tools 容器，因为它需要控制本地 Redis 服务生命周期。验证器只接受仓库内 Compose 文件和 loopback 网关，先确认 gateway/node/go/redis 全部运行并固定 provider=node，再执行 Redis stop：Node 网关与 Go lab 的已认证 `/api/profile` 都必须返回 503、`Shared identity service unavailable`、正确 backend/request-id/content-type 且不得修改 Cookie；两端公开 `/api/photos/visible` 必须继续 200 且 body 相等；Go `/health/ready` 必须返回 503，database/mediaTools 仍为 ok、redis 为 failed。Redis start 后脚本轮询 readiness，并要求停机前的固定 session 通过 AOF 被 Node/Go 同时接受。`finally` 会在必要时拉起 Redis、等待 readiness 并恢复 provider=node；74 项行为检查和 3 项清理检查均通过才算成功。该门禁不覆盖网络分区、客户端重连风暴、内存容量/驱逐、AOF 损坏或 Redis 主从/集群 failover。

默认 named volume 模式下，完整 seed 也应通过 `fixture` 容器执行；不要在 Node/Go 已持有长期 SQLite WAL 连接后从宿主机 bind mount 再次执行完整 `dual:seed-compare`，否则外部 fixture 连接可能让运行中进程继续持有已删除的 `-wal`/`-shm` 文件，导致后续设置写入只对旧文件描述符可见。`seed-dual-backend-fixture.mjs` 默认要求显式 `--confirm-fixture-write`，并期望数据库已经完成迁移与 `DEFAULT_SETTINGS` 初始化；宿主机 seed 只建议用于临时 `CFRAME_DATA_DIR` 调试。容器化 seed 脚本使用 `docker compose run --build fixture`，避免更改 fixture 代码后误用旧工具镜像。

推荐用 `pnpm dual:verify-all:container` 做当前双后端学习栈的一键总验收。它会先跑默认 Node owner 双栈，再切到带 MinIO 的 Go pipeline consumer owner override，随后执行 Go backup scheduler、Go-primary Node-off 独立运行和 Go migrator 隔离验收；脚本默认使用 `CFRAME_DUAL_PORT=33119`、`CFRAME_DUAL_REDIS_PORT=36399`、`CFRAME_DUAL_MINIO_PORT=39019`、`CFRAME_DUAL_GO_PORT=38019` 避免占用日常开发端口，结束时执行各 override 的 `down`，不会自动删除 named volume。可用 `--dry-run` 查看计划，用 `--port`、`--redis-port`、`--minio-port` 与 `--go-port` 指定端口，用 `--keep` 保留服务现场。

差分脚本会拒绝不在契约对比范围内的路径；只有 `dual:compare:container` 输出中的 `equal` 为 `true` 才表示当前夹具下契约派生的读取样本两套实现一致；只有 `dual:verify-go-readiness:container`、`dual:verify-switch:container`、`dual:verify-route-surface:container`、`dual:verify-route-boundaries:container`、`dual:verify-mutations:container`、`dual:verify-livephoto:container`、`dual:verify-photos-read:container`、`dual:verify-photos-write:container`、`dual:verify-system-reads:container`、`dual:verify-system-logs:container`、`dual:verify-wizard:container`、`dual:verify-share-og:container`、`dual:verify-queue-control:container`、`dual:verify-settings-control:container`、`dual:verify-media-read:container`、`dual:verify-upload-shares:container`、`dual:verify-runtime-owners:container`、`dual:verify-backup:container`、`dual:verify-authz:container`、`dual:verify-oauth:container`、`dual:verify-identity:container`、`dual:verify-access-control:container`、`dual:verify-redis-outage:container` 与 `dual:verify-media-parity:container` 输出中的 `ok` 都为 `true`，才表示当前 Go 服务直连 settings 写入、网关切换链路、已登记 Go operation 网关分流面和 Go lab 直连 API 面、全量匿名/空 body 基础边界、基础 mutation parity、Live Photo 成功写回与跨端读取/删除、照片读取查询/权限/地图聚类、照片写入动态边界/真实对象/EXIF/重建/删除、public settings/system stats、日志 SSE、完整 wizard 生命周期、分享图权限/响应策略/像素、队列 retry/control、settings/storage control、media-read 协议/缓存/签名/权限边界和上传分享全生命周期、当前 consumer owner telemetry、手动 database backup 成功链路、真实 local 对象重写链路、代表性权限/错误/成功边界、GitHub OAuth 初始化/回调协议、Node/Go 双向 session 签发/读取/撤销、访问配置/预览/跨端 grant/版本失效/共享限流、Redis 中断/恢复和媒体二进制响应 parity 通过；在 Go backup scheduler owner override 下，`dual:verify-go-backup-scheduler:container` 输出 `ok: true` 且 `emails[0].origin.validated=true` 才表示本地定时备份由 Go 容器发出、附件可解密、Node scheduler 未抢占；在 Go pipeline consumer override 下，`dual:verify-runtime-owners:container:go-pipeline-consumer` 输出 `ok: true` 才表示 Go worker telemetry 已接管 queue stats，`dual:verify-upload-shares:container` 输出 `ok: true` 才表示本地 PNG 的 Go prepare → PUT → 入队 → consumer → 派生媒体完整读回、suffix Range 读回，以及 Node/Go 公开上传分享匿名 read/prepare/PUT/task → Go consumer → photo/usage 落库、maxUploads 耗尽 429、公开 S3 预签名和 Node/Go 同时提交最后一个额度时恰好一端成功的原子配额链路通过；`dual:verify-openlist-storage:container` 输出 `ok: true`、`runCount: 4`，且四轮各有 `mediaComparisons: 22`，才表示 OpenList 配置下载端点与 `raw_url` 两种模式均由 Node/Go owner 完成协议级流水线、Range fallback 与零残留清理。`dual:verify-all:container` 会按上述顺序编排这些检查，因此它通过代表当前容器化 parity gate 已整体通过。上传分享门禁会输出稳定的 `publicChecks: 14`、`exhaustedShareChecks: 2` 与 `atomicQuotaChecks: 6`；轮询相关的总 `checkCount` 和协议请求总数可能随运行时序变化。完成后停止服务；如不再需要本地学习状态，可同时删除 Compose volume：

同一 Go consumer override 阶段还要求 `dual:verify-s3-storage:container` 返回 `ok: true`、`runCount: 2`，两个 run 均有 `mediaComparisons: 22`，且 Node/Go API 删除后 MinIO bucket 都为空；否则总验收失败。

```bash
pnpm dual:down
# 明确不再需要本地学习状态时才执行：
docker compose -f deploy/dual/compose.yaml down -v
```

默认 named volume 会被 `docker compose -f deploy/dual/compose.yaml down -v` 删除；如果使用了 `CFRAME_DATA_DIR` bind mount，其中的 SQLite 与媒体文件不会被 `down -v` 删除，是否清理该目录由开发者单独决定。

若要验证 Go 可以独立承担 schema bootstrap，可使用专门的 one-shot migrator override。它会先启动 `go-migrator` 服务，设置 `CFRAME_DB_MIGRATOR=go` 与 `CFRAME_GO_MIGRATE_ONLY=true`，用 Go 执行同一份 Drizzle SQL ledger、写入 `__drizzle_migrations` 并初始化默认 settings metadata；Node 看到 owner=go 后跳过自身 migrator，Node/Go API 服务只在该 job 成功完成后启动：

```bash
pnpm dual:config:go-migrator
pnpm dual:verify-go-migrator
```

`dual:verify-go-migrator` 会使用 `chronoframe-go-migrator-*` 隔离 Compose project、独立端口和独立 Docker volumes，启动 `compose.go-migrator.yaml`，等待 Go migrator 成功退出并确认 Node/Go API 服务都已启动，然后读取该隔离 SQLite：migration ledger 必须等于 Go 生成的当前 migration contract，默认 settings 数量必须等于 Go 生成的 defaults contract，`system:backend.readProvider` 必须保持 `node` 默认值和 `["node","go"]` 枚举，`integrity_check`/`foreign_key_check` 必须通过。默认会执行 `down -v` 删除本次 smoke 新建的临时 volumes；如需保留现场可追加 `--keep`。这个 override 证明 Go 可以从空库应用当前 SQL ledger，不代表生产环境允许两个 migrator 同时运行；生产部署仍必须用部署级 job、锁/lease、备份和回滚 runbook 保证全局唯一 migrator。

若要在本地学习栈中让 Go 持有定时数据库备份 actor，使用专门的 override。它会让 Node 看到 `CFRAME_BACKUP_SCHEDULER=go` 并跳过 Node scheduler，同时让 Go 启动自己的 scheduler：

```bash
pnpm dual:config:go-backup-scheduler
pnpm dual:up:go-backup-scheduler
```

该 override 只改变 backup scheduler owner；migration 和 pipeline consumer 仍保持默认安全组合，除非再显式叠加对应 owner override。override 会把 `CFRAME_GO_BACKUP_SCHEDULE_REFRESH_INTERVAL` 默认降到 `1s`，只用于本地验收更快观察设置变化；常规默认仍是 `1m`。

验证 Go 定时备份 owner 时，推荐用同一个 Compose override 启动服务、容器化写入 fixture、刷新固定 Redis session，然后让工具容器启动 fake SMTP 并等待 Go scheduler 发出第一封定时备份邮件：

```bash
export CFRAME_DUAL_PORT=33100
export CFRAME_DUAL_REDIS_PORT=36379

pnpm dual:up:go-backup-scheduler

docker compose \
  -f deploy/dual/compose.yaml \
  -f deploy/dual/compose.go-backup-scheduler.yaml \
  --profile tools run --rm --build fixture pnpm dual:seed-compare

docker compose \
  -f deploy/dual/compose.yaml \
  -f deploy/dual/compose.go-backup-scheduler.yaml \
  restart node go

docker compose \
  -f deploy/dual/compose.yaml \
  -f deploy/dual/compose.go-backup-scheduler.yaml \
  --profile tools run --rm --build fixture pnpm dual:seed-session

pnpm dual:verify-go-backup-scheduler:container
pnpm dual:down:go-backup-scheduler
```

`dual:verify-go-backup-scheduler:container` 会临时写入 `backup.enabled=true`、秒级 cron、fake SMTP 主机/端口和加密 passphrase，不连接真实邮件服务；捕获邮件后会解析附件、解密 `CFDBENC2` envelope、校验 SQLite header，并通过 Compose DNS 解析 `go` 与 `node` 服务地址，要求 SMTP 连接来源等于 Go 容器且不等于 Node 容器。最后脚本会恢复备份设置和原 provider；工具容器可访问 `/app/data/backups` 时会删除本次生成的备份文件，除非显式传 `--keep-files`。它验证的是本地双栈中的 Go scheduler owner、共享 SQLite 备份与 fake SMTP 发件链路，不代表真实外部 SMTP、长期 retention 和生产调度窗口已经覆盖。

若要单独学习 Go pipeline consumer 的已实现切片，使用另一个 override。它会关闭 Node pipeline worker，让 Go claim `photo`、`live-photo-video`、`video`、`photo-reverse-geocoding` 与 `photo-erase-location` 任务。日常推荐使用 package scripts，避免手写漏掉 override 文件：

```bash
pnpm dual:config:go-pipeline-consumer
pnpm dual:up:go-pipeline-consumer
```

这个 override 不代表全量 pipeline 已交接。当前已有 Redis runtime lease 防止共享 Redis 模式下 Node/Go 双消费者同时启动，也已有任务行级 fencing token 和 `available_at` 重试调度；只有在更大的真实媒体 corpus、失败矩阵、资源限制和 drain/handoff runbook 等 processor/细节逐项迁移并完成差分后，才能把它升级为生产全量 consumer owner。

验证 Go 本地上传流水线时，应在 Go consumer owner override 启动后写入 fixture，再执行专用脚本。该脚本会把 provider 切到 Go，先确认或等待 Go consumer active，再上传一个有效 PNG，经 Go 入队和 Go consumer 生成 photo、thumbnail、display，再通过 Go media route 读回；随后分别把 provider 切到 `node` 和 `go` 创建公开上传分享，使用无 Cookie 匿名请求完成 prepare、对象 PUT、task 入队，确认两端公开分享入口都能把任务交给同一个 Go consumer，并通过 Go 读取生成的 photo 与分享用量字段，再验证 `maxUploads` 用尽后同一 token 继续匿名 prepare 返回 429；最后额外创建只有一个剩余额度的分享，由 Node 网关和 Go lab 面并发提交同一个已上传对象，要求响应状态严格为一个 200 和一个 429、计数只能增加一次且胜出的任务可被 Go consumer 完整处理。脚本结束时删除临时 photo/upload share，并恢复 provider 为 Node：

```bash
export CFRAME_DUAL_PORT=33100
export CFRAME_DUAL_REDIS_PORT=36379

docker compose \
  -f deploy/dual/compose.yaml \
  -f deploy/dual/compose.go-migrator.yaml \
  -f deploy/dual/compose.go-pipeline-consumer.yaml \
  up --build -d

docker compose \
  -f deploy/dual/compose.yaml \
  -f deploy/dual/compose.go-migrator.yaml \
 -f deploy/dual/compose.go-pipeline-consumer.yaml \
  --profile tools run --rm --build fixture pnpm dual:seed-compare

pnpm dual:verify-runtime-owners:container:go-pipeline-consumer

pnpm dual:verify-upload-pipeline:container

pnpm dual:down:go-pipeline-consumer
```

公开照片 reaction POST 不使用通用 Go struct decoder，而是先按 Node/H3 的根值行为解析原始 JSON：EOF 和 `null` 映射为现有 Node 的 500 `Server Error`；非对象基础类型按缺失 `reactionType` 处理并返回 400 `Invalid reaction type`；对象仅接收字符串 `reactionType`，未知字段被忽略；malformed 或 trailing JSON 仍返回 400 `Bad Request`。对应 6 条负向探针已加入 `dual:verify-authz:container`，避免后续重构把这些可观测边界意外统一成另一种错误形状。

Live Photo 管理 body 由专用 decoder 保留 JavaScript 的可观测语义：EOF/`null` 在对象解构前映射 500，非 null primitive/array 根值按属性 `undefined` 进入 action 校验，数组/对象始终 truthy，JSON number 依据 JavaScript 数值真值判断。`detect.photoIds` 只有非空数组才形成 SQLite `IN` 条件，字符串等非数组值回退为扫描全部，boolean/object 等 better-sqlite3 不支持的 binding 映射外层 500；数字/null binding 则传入查询。Go 对 Live Photo 视频候选调用完整 `Provider.Get` 并以实际字节长度判定，不再只依赖 `Meta`；视频到图片的匹配按 Node 的 8 个扩展名候选逐条查询，保持确定性优先级。在线差分已覆盖 11 条负向和 7 条成功/安全无副作用场景；`dual:verify-livephoto:container` 进一步在共享 Local storage 和 SQLite 中创建 4 组隔离 photo + MOV，分别验证 Node/Go 的 `detect`、`process` 与 `update-photo` 成功响应完全同形、`is_live_photo/live_photo_video_url/live_photo_video_key` 确实落库、另一运行时可立即读取，并由另一运行时删除照片与 MOV。验证器在 `finally` 恢复 provider=node，并对任何未完成用例按精确 ID/路径直删和复查，因此失败运行也不会遗留测试数据。

### 16.2 目标生产拓扑

以下 YAML 仍是 owner 开关、独立 migrator、ACL 和 router 全部完成后的目标生产示意，不等同于 `deploy/dual`：

```yaml
services:
  gateway:
    image: caddy:<pinned-version>
    ports:
      - '3000:80'
    depends_on:
      - router

  router:
    image: chronoframe-lab-router:<pinned-version>
    expose:
      - '8090'
    environment:
      CFRAME_REDIS_URL: redis://redis:6379/0
      CFRAME_REDIS_USERNAME: cf_router
      CFRAME_REDIS_PASSWORD_FILE: /run/secrets/redis_router_password
      CFRAME_ROUTE_MANIFEST: /app/contracts/routes.yaml
      CFRAME_NODE_UPSTREAM: http://node:3000
      CFRAME_GO_UPSTREAM: http://go:8080
    secrets:
      - redis_router_password
    depends_on:
      redis:
        condition: service_healthy
      node:
        condition: service_started
      go:
        condition: service_started

  migrator:
    image: chronoframe-migrator:<pinned-version>
    restart: 'no'
    environment:
      DATABASE_URL: /app/data/app.sqlite3
    volumes:
      - chronoframe_data:/app/data

  node:
    image: chronoframe-node:<pinned-version>
    expose:
      - '3000'
    environment:
      DATABASE_URL: /app/data/app.sqlite3
      CFRAME_REDIS_URL: redis://redis:6379/0
      CFRAME_REDIS_USERNAME: cf_node
      CFRAME_REDIS_PASSWORD_FILE: /run/secrets/redis_node_password
      CFRAME_DB_MIGRATOR: none
      CFRAME_PIPELINE_CONSUMER: node
      CFRAME_BACKUP_SCHEDULER: node
    volumes:
      - chronoframe_data:/app/data
    secrets:
      - redis_node_password
    depends_on:
      migrator:
        condition: service_completed_successfully
      redis:
        condition: service_healthy

  go:
    image: chronoframe-go:<pinned-version>
    expose:
      - '8080'
    environment:
      DATABASE_URL: /app/data/app.sqlite3
      CFRAME_REDIS_URL: redis://redis:6379/0
      CFRAME_REDIS_USERNAME: cf_go
      CFRAME_REDIS_PASSWORD_FILE: /run/secrets/redis_go_password
      CFRAME_DB_MIGRATOR: none
      CFRAME_PIPELINE_CONSUMER: none
      CFRAME_BACKUP_SCHEDULER: none
    volumes:
      - chronoframe_data:/app/data
    secrets:
      - redis_go_password
    depends_on:
      migrator:
        condition: service_completed_successfully
      redis:
        condition: service_healthy

  redis:
    image: redis:<pinned-version>
    command: ['redis-server', '/usr/local/etc/redis/redis.conf']
    configs:
      - source: redis_config
        target: /usr/local/etc/redis/redis.conf
    secrets:
      - redis_acl
      - redis_health_password
    healthcheck:
      test:
        [
          'CMD-SHELL',
          'REDISCLI_AUTH="$$(cat /run/secrets/redis_health_password)" redis-cli --user cf_health ping | grep -q PONG',
        ]
    volumes:
      - redis_data:/data

volumes:
  chronoframe_data:
  redis_data:

configs:
  redis_config:
    file: ./deploy/redis/redis.conf

secrets:
  redis_acl:
    file: ./deploy/redis/users.acl
  redis_health_password:
    file: ./deploy/redis/secrets/health
  redis_router_password:
    file: ./deploy/redis/secrets/router
  redis_node_password:
    file: ./deploy/redis/secrets/node
  redis_go_password:
    file: ./deploy/redis/secrets/go
```

要求：

- Node/Go 位于同一宿主机并打开同一 SQLite 主文件目录，共享对应的 `-wal` 与 `-shm`；运行期间禁止替换数据库文件；
- 两个应用容器使用兼容 UID/GID；
- Redis 不暴露宿主公网端口；
- `redis.conf` 必须启用 ACL file、AOF、选定的 `appendfsync` 和 `maxmemory-policy noeviction`；ACL 密码文件不进入镜像或 Git；
- Go 与 Node 的直接端口不发布到公网；
- 镜像与依赖使用固定版本或 digest；
- healthcheck 不能执行会修改数据的操作。
- Node/Go readiness 必须等待唯一 migrator 记录的 schema version；普通应用进程不执行 migration，Go 迁移也必须作为 one-shot job 运行并退出。
- Compose 启动校验必须拒绝两个 pipeline consumer、两个 scheduler 或两个 migrator owner。

此基础拓扑故意不包含 shadow 服务，所以生产 `allowCompare/allowShadow` 必须保持关闭；离线对照使用 snapshot。生产 live 对照需要另一个受控 Compose profile，显式增加 `node-shadow`/`go-shadow`、shadow ACL secret、query-only DB adapter 与只读 Storage credential，不能复用上述 normal 容器。

### 16.3 Caddy 路由示意

```text
:80 {
    # 公共监听器先删除所有客户端可伪造的内部选择/身份头。
    request_header -X-ChronoFrame-Backend
    request_header -X-ChronoFrame-Mode
    request_header -X-ChronoFrame-Internal-User
    request_header -X-ChronoFrame-Lab-Backend

    # 这里只识别后端路由的大类，精确 method + path 和 capability
    # 由基于 manifest 的 lab-router 决定。
    @backend {
        path /api/* /image/* /storage/* /display/* /thumb/* /og-media/* /share-og/*
    }

    handle @backend {
        reverse_proxy router:8090
    }

    handle {
        reverse_proxy node:3000
    }
}
```

这是结构示意，不是可复制的生产白名单。构建工具必须从 route manifest 生成并验证精确规则，再原子 reload。公共监听器从不接受后端选择 Header；单独的 lab listener 只能绑定宿主机 loopback，或位于 VPN/mTLS 管理网络，才可接受受控选择。Node、Go 和 router 上游端口均不直接发布。响应中的 backend 标识由可信 router/upstream 设置，仅用于诊断，不能反过来作为请求身份或 owner 依据。

## 17. 安全基线

双后端上线前优先修复：

### P0

1. Wizard 写接口在 setup 完成后仍可匿名修改管理员和设置；
2. Wizard schema 可能返回 secret 当前值；当前 Node/Go 已统一在 schema 输出中清空 password/secret 的 `value` 与 `defaultValue`；
3. Local Storage Key 的 `..` 路径穿越；
4. session 保存完整用户行并暴露 password hash；
5. 部分媒体授权可能让普通用户读取其他用户内容；
6. 公开相册与公开照片使用不同可见性谓词；当前 Node/Go 已统一，并由预览外公开相册详情 401 差分固定。

### P1

1. session/access Cookie 固定 `secure: false`；
2. 登录与访问限流不共享；
3. settings 与 storage credential 明文；
4. storage provider 切换只有当前进程知道；
5. 基线分享上传配额存在检查/更新竞态；当前 Node/Go 已使用同一 SQLite 条件更新 + 队列插入事务修复，并由跨端并发 task 验收固定；
6. reaction fingerprint 可逆并保存原始 IP；
7. 基线 queue 曾缺少任务行级 lease/fencing，重试延迟未被 dequeue 尊重；当前已有 runtime lease 防止双消费者进程同时启动，并已通过 `available_at/claimed_by/claim_token/claim_expires_at` 补齐任务行级保护；
8. 未统一可信代理，`X-Forwarded-For` 可能被伪造；
9. 上传全量入内存以及图片解压资源上限不足。

处理原则：

- 安全修复是共同契约，不属于“允许的 Node/Go 差异”；
- 能同步修复 Node 的问题应先修 Node，再让 Go 对照新基线；
- Go 内部端口、debug、metrics、lab 路由不对公网开放；
- 网关覆盖内部身份头；
- mutation 校验 Origin/CSRF；
- secret write-only，读取 API 返回 redacted 值。

## 18. 可观测性

统一字段：

```json
{
  "timestamp": "2026-09-09T08:00:00Z",
  "level": "info",
  "service": "chronoframe-go",
  "backend": "go",
  "backendVersion": "dev",
  "mode": "compare",
  "routeId": "photos.list",
  "requestId": "01...",
  "durationMs": 12
}
```

指标：

- HTTP request count/status/latency/body size，按 backend/route/mode；
- compare/shadow mismatch 与严重度；
- SQLite busy、transaction duration、WAL size；
- Redis latency/error/eviction/session count；
- storage HEAD/GET/PUT/Range；
- queue pending、oldest age、lease expiry、retry/failure；
- worker stage duration、CPU、RSS、temp disk；
- backup last success、duration、size；
- Go goroutine 和 process file descriptors。

健康接口：

- `/health/live`：进程活着；
- `/health/ready`：schema 兼容、DB 可用、必要 Redis/配置可用；
- `/metrics`：仅内网。

Node 与 Go 都提供各自的 SSE 日志读取入口。后续若要在一个页面聚合两边日志，需要增加 adapter，以 service 字段合并两边事件；不要让 Node 和 Go 无锁 append 同一个日志文件。

## 19. 测试策略

### 19.1 测试层级

| 层级                | 必测内容                                                                            |
| ------------------- | ----------------------------------------------------------------------------------- |
| Unit                | parser、validator、权限矩阵、Key sanitizer、Range、cache codec                      |
| Contract            | 每个 route 的 Node/Go status/header/body                                            |
| DB integration      | 真实 SQLite 文件、事务、busy、migration fingerprint                                 |
| Redis integration   | session 互通、TTL、登出、限流、失效                                                 |
| Storage integration | Local、MinIO S3、OpenList 协议 fixture                                              |
| Media golden        | EXIF、方向、尺寸、格式、Live/Motion、视频播放                                       |
| E2E                 | 匿名、用户 A、用户 B、管理员、分享上传                                              |
| Resilience          | Redis 受控 stop/start 已覆盖；继续补 kill -9、网络分区、DB busy、磁盘满、S3 timeout |
| Security            | wizard、越权、路径穿越、伪造 header、CSRF、secret redaction                         |

### 19.2 双栈特有断言

当前相册 mutation 门禁固定了 Node 的原始字符串语义：标题、描述和封面 ID 的非空值不做 trim，字符串长度按 JavaScript UTF-16 code unit 计算；创建时 truthy `coverPhotoId` 必须进入相册照片关系，更新未传 `photoIds` 时保留原关系。Go 在写入基本字段前先完成照片归属校验，并将相册基本字段和关系替换放入同一 SQLite 事务，任何关系写入失败都会整体回滚。`dual:verify-albums:container` 以带首尾空格的文本和“空 photoIds + 单独 coverPhotoId”执行 Node→Go、Go→Node 两轮完整生命周期，并固定 mutation 原始字段集、非法 album id 和 bulk body 的嵌套 Zod 错误形状；生产镜像门禁当前为 88/88 通过。

当前后台用户门禁固定了 Node 的字段转换与异常语义：用户名先 trim 再按 UTF-16 code unit 校验，email 先做格式校验再 trim/lowercase，创建唯一冲突返回 409，而更新唯一冲突保持现有 Node 的 500 `Server Error`；路径参数遵循 JavaScript number coercion，因此范围内十六进制、小数整数和科学计数整数可用，非正数、小数和超出 safe integer 的值拒绝。用户被禁用、删除或 `authVersion` 不匹配后，Go 会像 Node 一样撤销共享 Redis session，并让响应清除 `cf_session`。`dual:verify-admin-users:container` 以 110/110 通过固定上述规则和双向生命周期。

当前照片表态门禁固定了 Node/H3 的可观测 query 与 body 语义：未传 `ids` 或只传一个空值时批量接口返回 400，重复空值形成数组时则保留空字符串键及全零计数；路由中的空白照片 ID 不做 trim。创建接口区分 EOF、空 body、`null`、malformed/trailing JSON、primitive/array/object 和非法 reaction type；`dual:verify-reactions:container` 以 72/72 通过固定这些边界、双向生命周期、匿名指纹隔离和共享 SQLite 每分钟 10 次限流。

`dual:verify-identity:container` 当前固定输出 26 项检查，并要求 Node/Go 对随机不存在邮箱的登录都返回 401、无 session Cookie，以及完全一致的 `statusMessage: "Server Error"` / `message: "Invalid credentials"` 错误语义；两端各签发两组真实 session，并分别通过对端 `/api/logout` 与 `DELETE /api/_auth/session` 撤销。

- Node 处于 identity owner 窗口时产生的 session 可被 Go 使用；
- Go 经交接处于 identity owner 窗口时产生的 session 可被 Node 使用；
- logout 无论经哪个 API upstream 发起，最终都由 identity owner 撤销，随后两端拒绝；
- Node-owned mutation 后 Go 正确读取；Go-owned mutation 只在 capability 交接后执行，Node 随后正确读取；
- settings 变更不会被另一端永久缓存；
- compare/shadow 前后生产 DB 与对象 manifest 相同；
- mutation 只出现一条 execution audit；
- worker、scheduler、migrator active owner 唯一；
- 关闭 Go 后 Node 继续读取所有 Go 已批准写入的数据。

### 19.3 性能基线

每个 capability 在进入 normal 前建立自己的 benchmark profile，至少冻结硬件/容器限额、数据 fixture、并发客户端、持续时间、冷热缓存状态、SQLite/Redis/运行时版本和 Node 基线。验收预算从该基线评审得出并写回 manifest，不能拿一组通用的 QPS、p95 或内存数字套在所有能力上。

- 正确性、权限和幂等门槛不能为了性能预算放宽；
- 上传测试使用当前 `upload.maxFileSize` 的实际配置和多档文件，证明 API RSS 不随完整请求体近似线性增长，再基于容器限额确定预算；
- shadow 分别测量请求复制、序列化、peer 调用和差异存储的开销，基线稳定后再确定主响应 SLO；
- SQLite busy 错误不能静默转换成重复写或成功响应；
- 纯读 owner 回退目标小于 1 分钟；mutation、worker 和 scheduler 按各自经过演练的 quiesce/drain/lease runbook 设定 RTO。

Go CI：

```text
gofmt
go vet
go test ./...
go test -race ./...
govulncheck
contract differential tests
```

夜间运行 fuzz、media corpus 和故障/soak 测试。

## 20. 分阶段实施

本节与产品文档的 M0–M8 一一对应；产品里程碑表是范围和级别的权威来源。

### M0：契约与运行骨架（核心）

交付：

- 完整 API inventory；
- OpenAPI、route manifest、错误契约；
- 权限矩阵和 fixture；
- P0 安全修复；
- Node 行为测试；
- 参数化 schema drift preflight、物理 schema/trigger contract；online backup/restore 演练继续补齐；
- Gateway、Redis 和 `lab-router` 骨架；
- request ID、backend/mode/maturity headers；
- Go skeleton、health、只读 DB adapter 和 schema readiness；
- 共享 Redis 可用，但本阶段不要求 Go 写 session。

退出标准：所有 capability 和内部路由有 owner、side-effect 与 maturity 分类；Node 默认路径不变；Go 可独立启动，schema 不匹配时拒绝 ready；契约测试可运行。

### M1：公共只读（核心）

建议顺序：

1. public settings；
2. canonical visible photos；
3. photo list/detail；
4. albums list/detail；
5. map/reaction counts。

该阶段已完成主要纵切：公开设置、可见照片、公开/管理相册、地图和反应统计都可由 Go 读取。后续新增读接口仍遵循同一规则：先进入 manifest、补 fixture/权限矩阵，再进入 `GO_API_ROUTES`。

### M2：身份与授权（核心）

- Node 先成为 identity owner；当前安全切断要求升级用户重新登录，后续通过有一次性账本的 bridge 才静默兑换旧 sealed Cookie；
- session payload 只保留稳定身份字段和必需的 `authVersion`，敏感用户字段先从旧 payload 清除；
- 两端实现相同 Cookie、CSRF、登出、固定绝对 TTL、active/role recheck 和资源 owner scope；
- 已完成 profile、个人范围查询、站点 access grant、限流互通、Go 登录和 GitHub OAuth callback；`dual:verify-identity:container` 已用真实密码固定 Node/Go 双向 session 签发、跨端读取和跨端撤销，OAuth callback 的 state Cookie、redirect body、query 数组真值和错误语义已由 `dual:verify-oauth:container` 固化，真实 GitHub token/account 成功链路仍需受控 OAuth App 验收；
- identity owner 交接仍需通过维护窗口演练后再提升为 stable。

退出标准：Node/Go 会话互通；任一 owner 登出后两边都拒绝；匿名、用户 A、用户 B、管理员和分享访客权限矩阵通过。

### M3：低风险 CRUD（高级可选）

已在 Go normal-capable HTTP 面实现：

1. reactions；
2. albums 与 album_photos；
3. photos metadata 与 albums 关联；
4. queue add-task(s)、targeted retry 与 batch retry 控制面。

这些 route 可以按 provider 开关代理到 Go；Node 仍保留可切回实现。`dual:verify-queue-control:container` 现对全部 8 条 `pipeline-control` route 执行 124 项生产镜像检查：8 个读取、78 个 Node/Go 成对边界和 38 个双向生命周期/控制检查。成对门禁覆盖共享 worker telemetry、任务列表与过滤、owner 明细、所有鉴权层级、EOF/空/malformed/trailing/primitive JSON、嵌套 Zod、重复 query、Node `Number(taskId)` 的空白/小数 `.0`/科学计数/十六进制语义，以及 clear 的 `parseInt()` 数字前缀；所有成对响应都比较状态码、完整 canonical JSON、Content-Type、backend/request-id 响应头并拒绝 Set-Cookie。生命周期继续覆盖 Node↔Go 单条/批量小数参数入队读回、targeted/batch retry、安全 no-op clear 与 SQLite 白名单前置保护后的真实 clear 删除。8 条路由已晋级为 `verified`；后续仍继续补进程崩溃、磁盘故障和生产 worker handoff 演练。

`photos` metadata 已具备 Go 实现，但仍需特别关注 Node worker 生成字段和用户编辑字段的冲突；Node worker 应继续向列级更新、revision/optimistic guard 方向收敛。

### M4：上传与媒体读取（高级可选）

- stream Storage interface；
- Local/S3/OpenList 读写；
- upload prepare、internal upload 与 queue payload schema；
- media auth；
- Range/ETag/cache；
- 分享上传；
- display/thumb/share image 基础图片变换；
- `dual:verify-route-boundaries:container` 覆盖 85 条 Go-capable 非 runtime operation 的匿名/空 body 基础边界；
- `dual:verify-livephoto:container` 覆盖 Node/Go 各自的 Live Photo `detect`、`process`、`update-photo` 成功写回、对端读取和反向删除，并确认共享 SQLite 与 Local storage 无 fixture 残留；
- `dual:verify-photos-write:container` 覆盖 6 条照片写入路由的动态请求体、真实上传字节、完整 EXIF 与对象哈希、单/批重建、原图/派生图/Live Photo 删除和零残留清理；
- `dual:verify-share-og:container` 覆盖真实图片、视频候选和 fallback 分享图的权限、严格 `.png` 后缀、网关切换、1200×600 响应策略和解码像素 MAE 0；
- `dual:verify-reactions:container` 覆盖 4 条照片表态路由的读取与深层错误边界、Node↔Go 双向生命周期、匿名指纹隔离、共享 SQLite 限流和零残留清理；
- `dual:verify-upload-pipeline:container` 覆盖 Go 本地 PNG prepare、PUT、入队、consumer、thumbnail/display 生成和 media GET/HEAD 读回，以及 Node/Go 公开上传分享匿名 prepare/PUT/task → Go consumer → photo/usage 落库和 maxUploads 429 拒绝；它还会让 Node 与 Go 并发提交同一个 `maxUploads=1` 分享，要求恰好一个 200、一个 429，最终只有一个任务且 `uploadCount=1`。
- `dual:verify-s3-storage:container` 覆盖 MinIO 上 Node/Go 各自的预签名 PUT、Go consumer 派生、22 组跨端媒体响应对比，以及包含 display 对象在内的删除清理。
- `dual:verify-openlist-storage:container` 覆盖 Node/Go owner × 配置下载端点/metadata `raw_url` 的 4 轮完整 OpenList 协议流水线、88 组跨端媒体响应对比、上游忽略 Range 时的客户端 fallback，以及对象、配置和 active provider 恢复清理。
- `dual:verify-redis-outage:container` 覆盖 Redis 停止后的双端私有 profile 一致 503 fail closed、公开照片列表维持服务、readiness 降级，以及重启后 AOF session 被两端继续接受和现场恢复。

Go 已能读取 Node 对象，也能在 normal/go 写共享存储；MinIO S3 的预签名上传、媒体读取和删除，以及 OpenList 的协议级认证、上传、metadata、两种下载、Range fallback 和删除已进入自动化门禁。后续重点是托管云 S3/CDN、真实托管 OpenList、失败注入和大媒体 corpus。

### M5：沙箱媒体处理（核心）

- 自带最小 Local sandbox Storage 和固定 fixture loader，不依赖 M4 的生产 Provider/上传实现；
- 独立 sandbox queue；
- 普通图片导入、HEIC 转 JPEG、EXIF、thumbnail/display/share image、thumbhash、MP4 video、Live Photo 与 Motion Photo 已有 Go 实现；真实媒体 corpus 继续补齐；
- 资源限制、超时和幂等；
- crash recovery 和 media corpus。

本阶段不触碰生产 queue、生产对象前缀或生产 photo rows。退出标准是 golden corpus 达标，且基础设施权限证明 sandbox 无法写入生产状态。

### M6：可切换生产 worker（高级可选）

- 已补齐 pipeline consumer 的 Redis runtime lease、任务行 lease/fencing token、`available_at` 重试调度与 heartbeat，并已用 `dual:verify-upload-pipeline:container` 验证本地 PNG 与 Node/Go 公开上传分享进入 Go consumer 的成功/限额耗尽路径；Node/Go 正常退出已实现 stop-claim、续租 drain、排空后释放 owner lease；继续补真实媒体 corpus、故障注入、资源限制和幂等提交验证；
- 用维护窗口把已有 stop-claim/drain/expire 原语编排为 owner CAS、启动新消费者的完整 runbook；
- crash recovery、长任务超时和重复交付测试通过；
- 本阶段只交接 production pipeline consumer；backup/cron scheduler 已有 Go 实现，但仍必须遵守单 owner 配置和独立验收。

生产中始终只有一个 active consumer。是否切到 Go 是可逆 owner 配置，不是替换 Node。

### M7：控制面（高级可选）

- settings 与 provider reload；
- 用户管理、OAuth provider/callback 管理与 wizard 生命周期；普通 session 消费和可选 identity owner 交接属于 M2；
- backup；
- logs SSE 与 system stats；
- scheduler lease。

这些已登记控制面路由均已复刻并通过独立生产镜像门禁；真实外部 SMTP/OAuth、长期调度与恢复故障仍按 `stable` 标准继续演练。

### M8：长期双栈运营（核心）

- Node/Go 独立版本与发布节奏；
- 每次发布跑 differential suite；
- route manifest 记录兼容版本；
- 保留 compare/shadow；
- 定期演练 Node route 和 Go route 双向回退；
- 不设置“删除 Node”的里程碑。

## 21. 故障处理与回退

### 21.1 Go API 故障

1. 阻止新的 Go mutation；
2. 等待或确认 in-flight 请求；
3. 确认 Node 对当前 schema/写格式兼容；
4. 经审计更新对应 capability manifest，并原子 reload gateway；
5. 用当前共享 DB 做 smoke test；
6. 不恢复数据库快照。

纯读能力可直接回 Node；写能力的耗时取决于 quiesce、事务结束和外部操作补偿，不能承诺统一的秒级回退。

### 21.2 Redis 故障

1. 保持 public preview；
2. 已登录/解锁相关能力 fail closed 或 503；
3. 继续使用最后一个已验证 route manifest，不能因 Redis 故障自动改变 mutation owner；
4. settings 回源 DB；
5. 非 owner worker/scheduler 停止；
6. 恢复后验证 TTL、session 和限流。

`deploy/dual` 冷启动仍要求 Redis healthy，避免在共享身份未就绪时把整套服务标成可用；但对已运行的双栈，`dual:verify-redis-outage:container` 已证明 Redis stop 期间两端公开 `/api/photos/visible` 仍为 200 且 body 一致，私有 profile 则一致返回 503 并由 Go readiness 报告 Redis failed。此结论仅覆盖受控单实例 stop/start，不代表网络分区、容量耗尽、AOF 损坏或集群 failover 已满足生产可用性目标。

### 21.5 数据库恢复或实例替换

当前 Redis key 仅按环境隔离，尚未包含不可变 deployment/database epoch。因此在 epoch 契约落地前，每次 SQLite 恢复、克隆或替换都必须清理对应环境的 session/access key，并强制重新登录，防止旧 AOF 中的身份记录与回退后的 `auth_version` 再次匹配。生产化应把持久 epoch 纳入 key/record，并以受审计的 rotate 流程替代人工前缀清理。

### 21.3 SQLite busy/lock 激增

1. 立即阻止新的 Go mutation；
2. 等待/处置 in-flight 后，按 capability handoff 流程切回 Node；在此之前保留只读或暂时停止 Go；
3. 检查长事务、连接数、WAL 与 checkpoint；
4. 禁止通过无限重试掩盖；
5. 恢复后用固定并发测试再开放。

### 21.4 Worker 切回

停止 producer → 排空/确认 in-flight → 停 Go consumer → 等 lease → 启 Node consumer → 恢复 producer。绝不同时启动两个 consumer 来“加速恢复”。

## 22. 推荐的第一批工作

按优先级：

1. 修复 wizard、session password hash 泄露和 Local path traversal。
2. 从现有 handler 生成完整 API inventory 与权限矩阵。
3. 建立 route manifest 和 Node characterization tests。
4. 在 Node 中加入 Redis client，把 session、access grant 和限流改成共享协议。
5. 给 Node 设置缓存增加 TTL/revision，补 `busy_timeout` 和一致的 FK 策略。
6. 新建 Go skeleton，只做 health、config、Redis codec 和 SQLite 只读。
7. 首个学习接口选择 `GET /api/photos/visible` 或一个更小的 public setting GET。
8. 建 differential harness，通过后再做 albums/public photo list。
9. 所有写能力先在 sandbox。
10. 队列 schema 已支持 lease；生产 worker handoff 的学习仍需基于维护窗口、drain/expire、owner CAS 和故障注入演练。

当前纵切已覆盖独立 Go 服务、共享 SQLite/Redis/对象存储、管理员切换入口、85 个文件/框架 HTTP operation 的 Go registry、3 个独立 Go runtime actor、代表性读请求逐字段差分、85 条 Go-capable 非 runtime operation 的匿名/空 body 基础边界差分，以及各 capability 的深度生产镜像门禁；route manifest 当前为 88 条 `verified`、0 条 `experimental`。生产式浏览器 smoke 必须按上面的安全 fixture 顺序执行：完整 SQLite seed 后重启 Node/Go，随后只刷新 Redis session，再在系统设置页验证 Node.js/Go provider 双向切换，并用 `settings/login/profile` 黑盒请求验证 `X-ChronoFrame-Backend` 随 provider 在 `node`/`go` 间变化。浏览器通过 Node 网关切换 provider，Node 将已登记 Go-capable 路由转发到独立 Go 服务；Go 直接读写共享数据库并通过共享 Redis 校验 session。Local/S3/OpenList、普通图片导入、HEIC 转 JPEG、EXIF、Live/Motion Photo、display/thumb/share image、thumbhash、手动 backup、Go backup scheduler、Go `photo` / `live-photo-video` / `video` / `photo-reverse-geocoding` 与 `photo-erase-location` consumer、pipeline consumer runtime lease、任务行 lease/fencing、worker telemetry 读取已具备真实 Go 实现；public settings/system stats、日志 SSE、7 条 wizard 和分享图都已有专门深度门禁，分享图真实图片/视频候选/fallback 三类输出达到解码像素 MAE 0；手动 backup 成功路径已由 `dual:verify-backup:container` 通过 fake SMTP、加密附件解密和 SQLite header 校验固定；Go backup scheduler owner 已由 `dual:verify-go-backup-scheduler:container` 在 Compose 网络中验证发件源来自 Go 容器且附件可解密；本地 PNG 的 Go prepare → PUT → 入队 → consumer → photo/thumbnail/display → media GET/HEAD 读回链路，以及 Node/Go 公开上传分享匿名成功、maxUploads 耗尽 429 和最后一个额度的跨运行时原子抢占链路已进入 `dual:verify-upload-pipeline:container`；Redis stop/start 已进入 `dual:verify-redis-outage:container`，固定私有请求失败关闭、公开读取维持和 AOF session 跨端恢复。`verified` 仍不等价于 universal `stable`；后续重点转为更大媒体 corpus、外部托管对象存储、大文件/断点、资源限制、Redis 深层故障和生产 pipeline consumer 交接演练。

MinIO S3 纵切也已进入 `dual:verify-s3-storage:container`：Node/Go 分别作为 prepare 和 delete owner，使用真实预签名 PUT，共享 Go consumer 处理任务，并通过两端读取同一对象；删除后 bucket 必须为空。OpenList 纵切已进入 `dual:verify-openlist-storage:container`：隔离协议 fixture 下执行 Node/Go owner × 配置下载端点/metadata `raw_url` 的 4 轮完整流水线和 88 组媒体结果对比，并要求授权失败、意外请求与对象残留均为 0。后续“外部对象存储”范围收敛为托管云 S3/CDN、真实托管 OpenList、跨公网故障和大文件 multipart/断点验收。

## 23. 必须建立的 ADR

- ADR-001：为什么长期双后端而非替换；
- ADR-002：为什么 SQLite 继续保留，以及何时需要 PostgreSQL；
- ADR-003：Redis session JSON 与 TTL；
- ADR-004：route ownership 与禁止双写；
- ADR-005：schema migration 唯一 owner；
- ADR-006：queue consumer handoff；
- ADR-007：media equivalence 标准；
- ADR-008：Redis/SQLite 故障策略；
- ADR-009：密码 hash 双实现兼容；
- ADR-010：compare/shadow 数据隔离。

## 24. 技术 Definition of Done

- Node/Go 共享同一业务 schema、Redis protocol 和 Storage Key contract；
- 任一实现处于 identity owner 窗口时创建的 session 都可由 peer 验证；测试不依赖两个登录 writer 同时在线；
- route manifest 覆盖全部 API、媒体、worker、scheduler 和 migrator；
- 每个 mutation capability 只有一个 owner；
- compare/shadow 的只读性由连接权限证明；
- Go 写入的数据可以由 Node 继续读取和管理；
- SQLite 的 PRAGMA、版本、连接池和备份策略一致；
- Redis 故障不会导致身份绕过或永久脏缓存；
- queue 没有双 consumer；
- gateway、Node、Go、Redis 都有健康与监控；
- differential、权限、并发、媒体和故障测试进入 CI；
- Node 与 Go 可以长期独立升级，没有 Node 退役前提。

## 25. 官方参考

- [SQLite Write-Ahead Logging](https://sqlite.org/wal.html)
- [SQLite PRAGMA](https://sqlite.org/pragma.html)
- [SQLite Foreign Key Support](https://sqlite.org/foreignkeys.html)
- [SQLite Online Backup API](https://sqlite.org/backup.html)
- [Go 1.22 路由增强](https://go.dev/blog/routing-enhancements)
- [sqlc 文档](https://docs.sqlc.dev/)
- [github.com/mattn/go-sqlite3](https://pkg.go.dev/github.com/mattn/go-sqlite3)
- [go-redis](https://github.com/redis/go-redis)
- [Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/)
- [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [AWS SDK for Go v2](https://docs.aws.amazon.com/sdk-for-go/)
- [OpenTelemetry Go](https://opentelemetry.io/docs/languages/go/)
- [FFmpeg / FFprobe](https://ffmpeg.org/documentation.html)
- [ExifTool](https://exiftool.org/exiftool_pod.html)
- [libvips](https://github.com/libvips/libvips)
