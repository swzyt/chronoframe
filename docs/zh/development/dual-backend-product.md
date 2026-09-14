# ChronoFrame Node.js + Go 双后端学习模式：产品需求文档

> 状态：已实现同仓库独立 Go 服务、Node/Go API 网关切换和共享 SQLite/Redis/对象存储；本地双栈默认用 Docker named volume 共享 SQLite/WAL，并提供容器化 fixture seed；Go one-shot migrator 已能复用同一份 Drizzle SQL ledger 从空库启动，并初始化同一份默认 settings metadata；Go readiness 已覆盖 SQLite schema preflight、Redis ping 和媒体工具链 preflight，并已纳入网关 runtime 路由与 Go 服务直连双面容器验收；Go wizard 已对齐 Node 的初始化表单 schema、完整 24 项 storage 字段、环境变量默认值、secret redaction、Map provider 选择器和首个用户冲突规则；Go 后台用户管理已对齐 email 规范化、用户 CRUD 和最后活跃管理员保护；Go 存储配置 create/update 已按 Node Zod schema 对 Local/S3/OpenList 配置执行必填校验、provider literal、默认值补齐和未知字段剥离；Go 已按 Node 语义提供照片上传准备、S3 非 COS 预签名直传 URL、真实内部对象 PUT、MIME 白名单/最大文件限制、重复检测、前缀感知对象上传授权、公开上传分享 Key 生成/授权和队列入队 payload 规范化；Go Local provider 写入已接入请求 context，取消/中断时只清理临时文件、不发布半成品且不覆盖旧对象；Go S3/OpenList 上传 body 也通过 context-aware reader 传播取消，避免请求取消后继续从上游读取完整 payload；`dual:verify-route-boundaries:container` 已在 Compose tools 网络中覆盖 85 条 Go-capable 非 runtime HTTP operation 的匿名/空 body 基础边界差分，固定登录/访问验证 Zod 错误、匿名 session、logout 与 reaction 缺参等响应形状；`dual:verify-upload-pipeline:container` 已验证本地 PNG 的 Go prepare → PUT → 入队 → Go consumer 消费 → photo/缩略图/display 生成 → Go media GET/HEAD 读回链路，并覆盖 Node/Go 公开上传分享从匿名 prepare/PUT/task 到 Go consumer 消费、Go 读回 photo、`upload_count/last_used_at` 落库和 `maxUploads` 耗尽后 429 拒绝继续 prepare 的链路；`dual:verify-media-parity:container` 已对同一张本地 PNG 的 `/image`、`/storage`、`/display`、`/thumb`、HEAD、Range 与 stale If-Range 样本执行 Node/Go 稳定响应头和字节 SHA-256 一致性验收；`dual:verify-queue-control:container` 已用临时 SQLite 队列行验证 Node/Go 单任务 retry、Go 批量 retry、跨端 stats 读回、invalid clear 400、安全 no-op clear，以及经 SQLite 前置保护的真实 clear 删除响应一致，并在 finally 精确删除临时行；`dual:verify-runtime-owners:container` 已在默认双栈和 Go consumer override 双栈中证明队列 worker telemetry 与期望 owner 匹配，默认栈返回 `worker-*`，Go owner 栈返回 `go-worker-*`；`dual:verify-all:container` 已加入本地 Compose `Node owner → Go owner → Node owner` 的 pipeline consumer 回切阶段；`dual:verify-backup:container` 已通过 fake SMTP 验证 Node/Go 手动 database backup 都能从共享 SQLite 生成加密备份附件、返回一致字段并恢复备份设置；`dual:verify-go-backup-scheduler:container` 已在 Go backup scheduler owner override 下验证定时备份由 Go 服务发出、附件可解密为 SQLite、且 Node scheduler 被 owner 配置跳过；`dual:verify-redis-outage:container` 已用受控 Redis stop/start 验证私有接口一致 fail closed、公开照片继续可读、readiness 降级和 AOF 会话跨端恢复；Go pipeline consumer 已支持普通图片导入、HEIC 转 JPEG、Live/Motion Photo、MP4 视频处理、反向地理编码和位置擦除切片，并通过 Redis runtime lease 防止共享 Redis 模式下 Node/Go 双消费者同时启动，启动期遇到残留 lease 会等待重试；当前 route manifest 的 88 条 Go 路由均已通过对应生产镜像专项门禁，`experimental=0`，其中 85 条为可切换 HTTP operation、3 条为独立 Go runtime actor；生产维护窗口、其余故障注入和全量真实媒体迁移演练仍需继续验证
> 文档类型：产品需求文档（PRD）
> 目标读者：项目维护者、Go 学习者、前后端开发者、测试人员
> 基线日期：2026-09-14

Node/Go pipeline consumer 现已采用同一退出原则：先停止新的 claim，再排空已领取任务并继续刷新 runtime/task lease；只有全部在途任务完成后才主动释放 runtime lease。Node 等待超时时会保留 owner lease 直到进程退出和 TTL 到期，Go 收到正常退出信号时不会再取消已经领取的任务。Go 行为测试固定了“任务完成前 lease 不释放、任务 context 不取消、完成后清理 claim 并释放 lease”，Node 源级回归测试固定了超时分支不得无条件释放 lease。真实长任务、kill -9、磁盘满和维护窗口编排仍需通过容器故障注入演练。

## 1. 产品决策

ChronoFrame 不把 Go 版本定义为 Node.js 后端的替代品，而是在同一个仓库中维护两套可以独立启动、独立发布、独立处理 HTTP 请求的后端：

- Node.js/Nuxt 是初始稳定基线，继续承载现有用户和行为参照。
- Go 按业务模块复刻同一份接口与规则，允许被选择、观察、比较和独立调试。
- “实现语言”和“能力成熟度”分别记录：`implementation=node|go`，`maturity=experimental|verified|stable`。Go 能力通过验收后可以是 stable，Node 新能力也可能处于 experimental。
- 两个后端共享同一业务数据库、共享会话与协调缓存、共享对象存储；业务真相不复制，执行权不双写。
- 同一个生产请求只能由一个后端产生最终结果；不做应用层双写。
- Node.js 不以退役为目标。Go 完成全部能力后，两套实现仍可长期运行和对照。

这不是“重写项目”，而是在现有产品旁边增加一条可控、可回退、可验证的 Go 学习路径。

### 1.1 当前交付边界

队列新增、批量新增与重试接口现在按 Node 的 Zod 数值语义接受范围内小数；Node 写入的 SQLite `REAL` 值可由 Go 无损读取，Go 写入后也可由 Node 读取。`dual:verify-queue-control:container` 对 8 条 `pipeline-control` 路由执行 124 项生产镜像检查，其中包含 8 个确定性读取、78 个 Node/Go 成对边界和 38 个双向生命周期/控制检查；它覆盖全局 telemetry、任务列表、所有鉴权层级、JSON/Zod 边界、JavaScript `Number()` 路径 ID、`parseInt()` 清理参数、单条与批量任务的双向跨运行时写读、重试和有 SQLite 前置保护的真实清理，并在结束时精确删除登记过的临时任务。

后台用户创建与更新接口都已对齐 Node 的 Zod 字段顺序、trim/小写转换时机、UTF-16 长度、null/错误类型、空更新 refine 以及非法路由参数错误形状；管理员自降级、停用自己和最后一个活跃管理员保护保持不变。

截至 2026-09-14，仓库已经交付：

- `backend/go`：独立 Go 模块化单体，可单独构建、启动、健康检查和访问 SQLite/Redis；
- Node 网关：按 `HTTP method + path` 将已登记接口转发到 Go，未登记接口继续由 Node 处理；
- 管理后台：`系统设置 → 后端实现`，通过 `system:backend.readProvider` 在 `node` / `go` 之间切换；
- 共享状态：SQLite 业务表、Redis session/access/rate-limit 协议、Local/S3/OpenList 对象存储 Key；本地学习栈默认通过 Docker named volume 共享 SQLite/WAL；
- Go HTTP 能力：公开/管理读取、登录会话、GitHub OAuth callback、后台用户管理、相册 CRUD、照片元数据写入、EXIF 重建、Live Photo 管理、反应、队列任务读写、设置、存储配置、上传分享、向导、系统统计、日志 SSE、媒体读取与基础图片变换等 Go-capable operation；其中 Go wizard schema 已完整返回 Node 的 admin/storage/map/general namespace 字段并清空 secret，wizard 写接口已按 Node schema 收紧必填字段、provider union、storage 默认值和首个用户冲突处理，Go 登录与访问密码验证已对齐 Node 的 body 校验和共享 Redis 限流 key contract，GitHub OAuth 已对齐 `nuxt-auth-state` Cookie、8-byte state、生产 Secure 属性、H3 redirect body、重复 query 真值与错误文案，Go 后台用户管理已补齐 email 规范化和最后活跃管理员保护，Go 存储配置管理已补齐 Local/S3/OpenList 的 create/update schema 默认值与未知字段剥离；
- 可验证性：Node 与 Go 的响应差分脚本、Go 单元测试、契约检查、Go mux 注册覆盖测试、S3/OpenList mock 测试、运行时媒体 smoke、双容器 Compose、`dual:verify-go-readiness:container` Go readiness 双面验收、`dual:verify-all:container` 一键容器化总验收、`dual:verify-go-migrator` 隔离空库迁移与默认 settings 初始化验收、`dual:verify-switch:container` 自动切换与 Go 服务直连 settings 写入验收、`dual:verify-route-surface:container` 全量 Go-capable operation 网关分流与 Go lab 直连双面探针、`dual:verify-route-boundaries:container` 全量 Go-capable operation 匿名/空 body 基础边界差分、`dual:verify-mutations:container` 基础数据库写接口、公开 reaction create/update/delete、照片上传准备/active S3 预签名 URL/对象 PUT/重复检测与后台用户 CRUD 验收、`dual:verify-photos-read:container` 全部 5 条照片读取路由的查询、权限、地图聚类与 owner scope 验收、`dual:verify-photos-write:container` 全部 6 条照片写入路由的动态请求体、真实对象、EXIF、重建和删除验收、`dual:verify-livephoto:container` Node/Go Live Photo 探测、成功写回、跨端读取与反向删除验收、`dual:verify-system-reads:container` public settings 与 system stats 的 22 项类型/权限/运行态验收、`dual:verify-system-logs:container` 管理后台日志 SSE 初始查询、实时追加和响应头验收、`dual:verify-wizard:container` 全部 7 条初始化路由的 70 项 schema、校验、持久化、跨端 session 与精确恢复验收、`dual:verify-share-og:container` 分享图真实图片/视频候选/fallback、权限、后缀、响应策略和像素级验收、`dual:verify-queue-control:container` 全部 8 条队列控制路由的 124 项读、边界与双向生命周期验收、`dual:verify-settings-control:container` 全部 11 条设置与存储配置路由的 185 项契约、边界和跨端生命周期验收、`dual:verify-media-read:container` 全部 8 条媒体读取路由的 89 项协议、缓存、签名、权限与字节级验收、`dual:verify-upload-shares:container` 全部 8 条上传分享路由的权限、跨端生命周期、S3 预签名、匿名对象上传、Go consumer 和原子配额验收、`dual:verify-runtime-owners:container` 默认 Node owner 与 Go consumer override 的实际 worker owner 验收、`dual:verify-backup:container` 手动数据库备份 fake SMTP 验收、`dual:verify-go-backup-scheduler:container` Go 定时备份 owner/fake SMTP 发件源验收、`dual:verify-authz:container` 鉴权/错误边界验收、`dual:verify-oauth:container` GitHub OAuth 协议验收、`dual:verify-identity:container` Node/Go 双向登录签发、跨端读取与跨端登出撤销验收、`dual:verify-access-control:container` 访问配置、预览、跨端授权 Cookie、版本失效和共享限流验收、`dual:verify-redis-outage:container` Redis 受控中断/恢复验收、`dual:verify-media-parity:container` 本地 PNG 媒体响应头/字节级 parity 验收、`dual:verify-upload-pipeline:container` Go 本地上传和 Node/Go 公开上传分享流水线验收、`dual:verify-openlist-storage:container` OpenList 协议级完整存储流水线验收，以及已覆盖 onboarding → 管理后台 → Node/Go provider 双向切换的生产式浏览器 smoke。
- S3 实链路：`deploy/dual/compose.s3.yaml` 提供临时 MinIO，`dual:verify-s3-storage:container` 会由 Go 创建并启用共享 S3 配置，再分别让 Node、Go 执行预签名上传、入队、Go consumer 派生、`/image`/`/storage`/`/display`/`/thumb` GET/HEAD/Range/If-Range 字节级对比和照片删除；每轮都要求 MinIO bucket 为空，最终恢复原 storage/provider 并删除临时 bucket。
- OpenList 协议级链路：`dual:verify-openlist-storage:container` 在 Compose tools 网络内启动隔离的 OpenList 协议 fixture，由 Go 创建并启用临时配置，再按 Node/Go owner 与配置下载端点/metadata `raw_url` 两个维度执行 4 轮完整上传、入队、Go consumer 派生、媒体读取与反向删除，共比较 88 组 Node/Go 媒体结果；fixture 会故意忽略上游 Range，以验证两端客户端切片 fallback。验收要求授权失败、意外请求、对象残留均为 0，并在 finally 恢复原 backend/storage provider、删除临时配置。它是协议级本地门禁，不代表真实托管 OpenList、CDN 或公网条件已经覆盖。
- Redis 故障恢复链路：`dual:verify-redis-outage:container` 在宿主机严格限定的 loopback Compose 栈中停止并重新启动 Redis，要求 Node/Go 已认证 profile 都以相同的 503 `Shared identity service unavailable` 失败关闭，公开照片列表继续 200 且响应体一致，Go readiness 准确报告 Redis failed；恢复后原固定 session 必须从 AOF 被 Node/Go 同时接受，脚本最终恢复 provider=node。该门禁不覆盖网络分区、容量/驱逐、AOF 损坏、主从或集群 failover。
- 访问控制深度门禁：`dual:verify-access-control:container` 会分别由 Node/Go 更新访问配置并签发 `cf_access`，验证两种 Cookie 都能被对端接受；随后由 Go 递增 `access.version`，要求两端拒绝旧 grant、输出完全相同的清 Cookie header，并对损坏 Cookie 做同样处理。脚本还会把 5 次错误密码请求交替发送给 Node/Go，要求两端随后共同返回 429，证明限流桶确实共享；finally 会恢复配置、只读版本号和 provider，并精确清理本次 Redis key。该门禁通过后，route manifest 中 4 条 `access-control` Go operation 的成熟度为 `verified`，尚未提升为 `stable`。
- Go-primary 独立运行模式：`deploy/dual/compose.go-primary.yaml` 把 schema migration、pipeline consumer 和 backup scheduler 三个单例 actor 全部交给 Go，Node 只保留前端页面和随时切回的控制面；Go 服务不再依赖 Node 健康状态，并通过 loopback 直连端口独立暴露。`dual:verify-go-standalone` 会在 Node 与网关都停止后检查 3 条 runtime route、全部 85 条非 runtime Go 路由、10 条真实认证读取、设置写回，以及 Go 登录、session 读取和撤销。该门禁通过后，3 条 `backend-runtime` 路由为 `verified`。
- 身份能力深度门禁：`dual:verify-identity:container` 现在同时覆盖 `/api/logout` 与框架兼容的 `DELETE /api/_auth/session`。Node 签发的两组动态 session 分别由 Go 的两个撤销入口失效，Go 签发的两组 session 则由 Node 对称撤销；每次撤销后两端都必须返回 401。配合 8 组 OAuth callback 协议差分，6 条 `identity` 路由已标记为 `verified`。
- 相册能力深度门禁：`dual:verify-albums:container` 对 9 条 `albums-read` / `albums-write` 路由执行 88 项生产镜像检查，包括 5 组确定性读取、42 组匿名/所有权/参数/请求体/缺失资源边界，以及 Node 创建→Go 写读删和 Go 创建→Node 写读删两轮完整生命周期。门禁精确比较状态码、Content-Type、backend/request-id 响应头、无意外 Set-Cookie、完整业务响应和嵌套 Zod `data`，仅忽略动态 `url` / `stack`；结束时恢复照片关系与 provider 并删除临时相册。9 条相册路由现已标记为 `verified`。
- 后台用户能力深度门禁：`dual:verify-admin-users:container` 对 4 条 `users-admin` 路由执行 110 项生产镜像检查，包括用户列表确定性读取、49 组认证/请求体/Zod/唯一冲突/JavaScript 数值路径/自操作保护边界，以及 Node 创建→Go 管理、Go 创建→Node 管理两轮完整生命周期。两轮都验证跨端登录与改密、角色与启用状态即时生效、用户相册在删除后转移给执行管理员、失效 session 被两端拒绝并清 Cookie；finally 删除临时用户、相册和 session 并恢复 provider。4 条后台用户路由现已标记为 `verified`。
- 照片表态能力深度门禁：`dual:verify-reactions:container` 对 4 条 `reactions-read` / `reactions-write` 路由执行 72 项生产镜像检查，覆盖公开与隐藏照片读取、单个和批量查询、单个空 `ids` 与重复空值的 H3 query 语义、空白照片 ID、完整 JSON 解析/类型/错误边界、Node 创建→Go 读写→Node 删除与 Go 创建→Node 读写→Go 删除的双向生命周期、匿名指纹隔离，以及由真实网关请求捕获指纹后写入共享 SQLite 的双端 429 限流。finally 精确删除临时表态并恢复 provider。4 条照片表态路由现已标记为 `verified`。
- 队列控制能力深度门禁：`dual:verify-queue-control:container` 对 8 条 `pipeline-control` 路由执行 124 项生产镜像检查。86 个成对请求逐项比较完整 JSON、状态码、Content-Type、backend/request-id 响应头和无意外 Set-Cookie；读取覆盖共享 worker telemetry、全量/过滤任务列表和 owner 明细，边界覆盖匿名/成员/管理员、body 解析、Zod 字段、任务隔离、重复 query、JavaScript 数值路径与 `parseInt()` 前缀。另有 Node↔Go 入队/读回、单/批重试、安全 no-op 和经 SQLite 白名单前置检查的真实 clear 生命周期。8 条路由现已标记为 `verified`。
- 设置控制能力深度门禁：`dual:verify-settings-control:container` 对 11 条 `settings-control` 路由执行 185 项生产镜像检查，包括 13 个确定性读取、104 个成对边界和 68 个跨运行时生命周期检查。门禁固定 settings namespace/key/schema/fields、readonly/type/enum、单项与批量更新、Local/S3/OpenList storage config union/default/未知字段剥离、JavaScript `parseInt(..., 10)` 路径 ID，以及 Node 写→Go 读写和 Go 写→Node 读写删；所有成对响应比较完整 JSON、状态码、Content-Type、backend/request-id 和 Cookie 副作用，finally 恢复原设置、active storage 与 provider。11 条路由现已标记为 `verified`。
- 媒体读取能力深度门禁：`dual:verify-media-read:container` 对 8 条 `media-read` 路由执行 89 项生产镜像检查、43 组成对结果比较，覆盖 `/image` 与 `/storage` 的完整 GET/HEAD、closed/open/suffix Range、If-Range、If-None-Match、If-Modified-Since、ETag/Last-Modified，`/display` 条件缓存，`/thumb` 显式键和 URL 回退，OG dedicated/derived/legacy 三代签名与 Range 忽略语义，Live Photo JSON、匿名原图权限、未知对象、反斜杠和 traversal 边界；所有二进制响应比较稳定头、字节长度和 SHA-256，finally 删除 SQLite/对象夹具并恢复 provider。8 条路由现已标记为 `verified`。
- 上传分享能力深度门禁：`dual:verify-upload-shares:container` 对全部 8 条 `upload-shares` 路由执行 35 项权限/请求边界、228 项跨运行时 mutation 套件，以及真实 Local 对象上传、匿名分享读取、Node/Go prepare/PUT/task、Go consumer、额度耗尽和并发争抢。S3 分支还固定两端公开上传 prepare 的预签名字段，分享 URL 必须使用外部网关 origin；生产镜像门禁稳定包含 14 项公开流水线检查、2 项耗尽检查和 6 项原子配额检查，并在 finally 删除临时照片、分享、队列任务、对象与设置。管理界面也已在 Go 模式完成分享列表、创建、删除及 Node 回切验证。8 条路由现已标记为 `verified`。
- 照片读取能力深度门禁：`dual:verify-photos-read:container` 对全部 5 条 `photos-read` 路由执行 38 项有效检查，覆盖公开/管理照片列表、普通用户 owner scope、分页、meta-only、搜索、媒体类型、重复 query、照片状态和重复检测的认证/JSON/空数组/内容哈希/文件名/存储 Key 语义。门禁临时写入 530 个跨日期变更线的地理照片，固定验证未授权预览即使旧设置大于 500 也必须封顶、超过 520 点时的低缩放聚类、高缩放直出、普通/跨日期变更线 bounds，并比较 Node/Go 完整 canonical JSON；finally 恢复预览设置、删除 532 条临时照片并把 provider 恢复为 Node。浏览器也已在 Go 模式验证后台照片表格、公共图库和地图标记后回切 Node。5 条路由现已标记为 `verified`。
- 照片写入能力深度门禁：`dual:verify-photos-write:container` 对全部 6 条 `photos-write` 路由执行 53 项主检查，并复用 26 项 Live Photo 检查。它覆盖 JavaScript 动态请求体边界、真实 raw upload 字节、完整照片元数据更新、EXIF 精确字段和对象 SHA-256、单张与批量重建、原图/派生图/Live Photo 删除及相册关系级联；finally 恢复 provider=node，并确认 SQLite、对象和队列夹具零残留。6 条路由现已标记为 `verified`。
- 系统读取与日志深度门禁：`dual:verify-system-reads:container` 对 public settings 和 system stats 执行 22 项生产镜像检查，固定公开设置各类型解码、私密值排除、管理员全局统计、普通用户 owner scope 与 runtime 隐藏；`dual:verify-system-logs:container` 固定 SSE 响应策略、`initial` 的缺失/空值/十六进制/科学计数/小数/重复参数语义、2 MiB 初始读取上限与实时追加。3 条相关路由均已标记为 `verified`。
- 向导能力深度门禁：`dual:verify-wizard:container` 对全部 7 条 wizard 路由执行 70 项生产镜像检查，覆盖完整 schema、Node Zod 错误形状、Local/S3/OpenList、Mapbox/MapLibre/AMap、complete/submit 跨端可见性、submit session 互认，以及 SQLite、设置 cache version 和 provider 的精确恢复。7 条路由均已标记为 `verified`。
- 分享图深度门禁：`dual:verify-share-og:container` 对真实图片、视频缩略图候选和缺失媒体 fallback 执行 14 个请求与 8 组比较，覆盖 preview/admin 权限、缺失照片、严格小写 `.png` 后缀、网关 Node→Go 切换、响应策略与 1200×600 输出；三类图片在统一解码后的像素 MAE 均为 0，并在 finally 清理照片、对象、设置、序列和 Redis version。`media.share-og` 已标记为 `verified`。
- 当前 route manifest 中 88 条 Go 路由均为 `verified`，`experimental` 为 0；其中 85 条为可切换 HTTP operation，3 条为 Go runtime actor。刻意保持 Node-only 的 `system.backend.status` 不属于 Go route，也不参与代理。

切换到 Go 后，`GO_API_ROUTES` 中登记且在 route manifest 标记 `maturity.go` 的读写请求由 Go 返回，并带有 `X-ChronoFrame-Backend: go`；切换开关本身仍由 Node 持有，避免把管理者锁在无法切回的后端。测试会将 `GO_API_ROUTES` 与 Go `http.ServeMux` 注册归一化比对，参数名大小写或命名差异不会误报，但 `/share-og/{photoId}.png` 这类静态后缀会严格保留，Node 网关和 Go 直连访问无 `.png` 后缀或使用大写 `.PNG` 时都返回 404。分享图由两端按相同 SVG 模板、libvips cover/centre/autoorient 和 fallback 规则输出 1200×600 PNG；网关在响应未编码时保留上游 `Content-Length`，专项门禁对真实图片、视频候选和 fallback 的解码像素比较均为 MAE 0。Node/Go 媒体读取已共用 closed/open-ended/suffix byte range 语义，`/storage` 也已收敛到与 `/image` 一致的原图授权、private cache policy 和 `Vary: Cookie`；直读对象路由 `/image`、`/storage` 已登记 GET/HEAD 双端契约，HEAD 复用同一套鉴权、Range/If-Range/ETag/Last-Modified/Content-Length/私有缓存/Vary 逻辑但不返回 body；Node 直读媒体会从请求/响应生命周期生成 abort signal，并传入 Local/S3/OpenList 的元数据、整读和 Range 读取，Go 直读媒体则通过 request context 与 context-aware body/local file read helper 取消上游对象读取；Go Local provider 写入同样接入 request context，内部上传或派生图写入被取消时只清理临时文件，不会 rename 发布半成品，也不会覆盖已存在的旧对象；Go S3/OpenList 上传 body 也会在复制过程中感知取消，把取消错误交回 HTTP/S3 上传链路；Node/Go S3/OpenList provider 源级测试都已覆盖“上游忽略 Range 返回 200 全量对象时按请求范围切片”的 fallback 语义；Go 上传准备在 S3 provider 且 endpoint 不是 Tencent COS 时会像 Node 一样返回 PutObject 预签名 URL，COS、Local 与 OpenList 仍返回内部上传 URL；`display` 已按 Node 规则要求隐藏/私有照片只能由 owner/admin 访问，非管理者必须先满足公开照片谓词再进入站点访问校验；`display`、`thumb`、`og-media`、`share-og` 的私有媒体响应也已统一设置 Cookie Vary，Node 生成缩略图会显式返回 JPEG 内容类型和长度；`dual:verify-upload-pipeline:container` 会额外验证 Go media route 的 HEAD 原图探针、stale If-Range 回落 200 和 suffix Range 206 读回。网关分流判断会对 `system:backend.readProvider` 直读 SQLite，不复用普通 settings L1 TTL 缓存，确保管理后台刚保存 `node`/`go` 后的下一次已登记请求立即按新 provider 路由。`deploy/dual` 将 Go 设为 `normal`，直接运行 Go 镜像的安全默认值仍是 `sandbox`。Node 仍是默认实现和默认 schema owner；Go 已支持 `CFRAME_DB_MIGRATOR=go` + `CFRAME_GO_MIGRATE_ONLY=true` 的 one-shot migrator，用于学习和验证 Go 独立空库启动，且复用同一份 Drizzle SQL ledger，不维护第二套迁移历史。Go 还会从 Node 的 `DEFAULT_SETTINGS` 生成默认 settings contract，并在启动时同步 metadata；这一步只补缺省项和 schema metadata，不覆盖用户已保存的设置值。任一时刻 migration、全量 pipeline worker、backup scheduler 等生产后台单例 actor 都必须只有 `node|go|none` 中的一个 owner。Go pipeline consumer 目前可安全 claim `photo`、`live-photo-video`、`video`、`photo-reverse-geocoding` 与 `photo-erase-location` 任务，用于学习普通图片导入、HEIC 转 JPEG、Live/Motion Photo 配对与提取、MP4 视频处理、地理位置反查和媒体隐私清理。共享 Redis 配置下，Node 与 Go pipeline consumer 会竞争同一个 `cf:v1:<env>:lease:pipeline-consumer` runtime lease；Go 启动期如果看到旧进程残留的 lease，会保持后台等待并重试，直到拿到 lease 或进程退出，运行中 lease 丢失则停止 claim。`pipeline_queue` 也已具备 `available_at`、`claimed_by`、`claim_token`、`claim_expires_at` 任务行级 lease/fencing 字段，Node/Go worker 的 claim、stage、complete、fail/retry 和 heartbeat 均以 token 条件更新落库。`dual:verify-upload-pipeline:container` 已在生产式双容器栈中验证本地 PNG 的 Go 上传流水线：Go 生成上传 URL、Go 写入共享 local storage、Go 入队、Go consumer 生成 photo/缩略图/display，并由 Go media route 读回原图和派生图；脚本还会分别在 provider=`node` 与 provider=`go` 下创建公开上传分享，用匿名请求完成 prepare、对象 PUT 和 task 入队，再由 Go consumer 消费，并通过 Go 读回生成的 photo 与分享的 `uploadCount/lastUsedAt`，随后复用同一 token 验证额度耗尽后再次匿名 prepare 必须返回 429。验证脚本会在 Go worker 已配置但尚未 active 时等待 runtime lease 交接完成。完整 drain/handoff runbook、更大的真实媒体 corpus、真实外部对象存储和故障注入验收仍需继续补齐。全局 worker 状态通过共享 Redis telemetry 或 Go 本地 worker stats 暴露给 HTTP 接口读取。

队列任务行 fencing 已有源级防漂移测试：Node 侧共享 SQLite 契约测试验证旧 claim token 不能写回 stage/complete，Go `queue.Repository` 测试验证旧 claim token 不能写回 stage、refresh lease 或 complete；正确 token 才能继续推进并在完成时清理 `claimed_by/claim_token/claim_expires_at`。正常退出的 stop-claim/drain/lease-release 顺序也已有双端回归测试。这证明共享数据库与进程退出策略不会接受过期 worker 的结果或主动制造双 owner 窗口，但不替代真实长任务、进程崩溃和生产交接演练。

`display` 按需生成派生图时，Go 会和 Node 一样要求对象写入与 `photos.display_key` 更新都成功后才返回；任一落地步骤失败都会返回 500，避免临时 body 与共享状态不一致。删除照片时，Node 与 Go 都会清理原图、HEIC 转换 JPEG、thumbnail、display、Live Photo 视频和视频播放对象，避免共享 S3 中留下派生文件。

公开上传分享入队成功后，Go 会和 Node 一样更新 `upload_shares.upload_count`、`last_used_at` 与 `updated_at`；DB 写入失败时请求返回 500，不把未落地的配额/使用时间状态伪装成成功。

上传分享管理接口也已收敛到 Node 的 Zod 与写入语义：创建和更新都先按 JavaScript `trim()` 处理标签、按 UTF-16 code unit 执行 80 字符上限，创建时区分“未提供”和非法 `null`，`maxUploads` 则保留可空语义；更新可以用显式 `null` 清空标签或上限，空对象仍刷新 `updatedAt` 并返回完整分享对象。路径 ID 与 Node 的 `Number()` 行为一致，接受 `42.0`、科学计数法等整数表达，非法值返回相同 400。创建 token 哈希冲突时两端都会最多重试 5 次；通过 Node 网关代理 Go 创建分享时，Go 使用转发的原始 URL 生成外部可访问链接，不泄漏容器内部 host。当前双向 mutation 实跑共 228 项检查，临时分享和其他验证数据均已清理。

照片元数据更新的 body 校验已在 Go 中前移到数据库与对象存储读取之前，避免非法请求因照片是否存在而改变结果。标题、描述、标签采用 JavaScript trim 与 UTF-16 长度上限，location/rating 保留“缺省、显式 null、实际值”三态，未知字段剥离，标签仍按忽略大小写去重。当前 Node 对这条路由直接抛出的 ZodError 会表现为 500 `Server Error`，Go 在兼容阶段保持相同外部契约；畸形 JSON 仍为 400 `Bad Request`，空对象或仅未知字段仍为 400 `No changes to apply`。若后续要把 Node 修正为 400，应在两端和契约验证器中同时升级。

队列任务重试/清理接口也已收敛到 Node 响应契约：Go 单任务 retry 会返回 `payload.type/storageKey` 摘要，批量 retry 会拆分 `retriedTasks` 与 `skippedTasks` 并返回一致的 `message/retriedCount/skippedCount`；非 `retryAll` 且没有 `taskIds` 时返回 400，SQLite 重置状态失败时返回 500，不把未落地的任务状态伪装成已重试。Go clear 会按 Node 规则解析 `includeCompleted/includeFailed/olderThanDays`，先统计再删除，并返回 `message/deletedCount/breakdown/filter`。`dual:verify-queue-control:container` 需要显式传入 SQLite 路径或在容器工具环境中运行，它只创建高位临时 task id，使用 HTTP 分别经 Node/Go 执行 targeted retry/batch retry，并通过对端 stats 读回；clear 会先验证 invalid/no-op 分支，再直查 SQLite 确认 `olderThanDays=1` 会命中的 completed/failed 行全部属于本次临时 task id，前置条件满足后才分别经 Go/Node HTTP 执行真实删除。

手动数据库备份接口也已加入双端验收：Node 与 Go 都从同一份 SQLite 生成备份文件，经同一 fake SMTP 发送加密附件，并返回一致的 `success/result.fileName/filePath/size/encrypted/sentTo/createdAt` 字段。`dual:verify-backup:container` 会临时写入 SMTP 与加密配置、分别切换 provider 执行 `/api/system/backup/run`、解析邮件附件、解密并 gunzip 校验 SQLite header，最后恢复原备份设置和 provider；Node 侧备份目录也已和 Go 一样支持 `CFRAME_BACKUP_DIR`，默认仍是 `data/backups`。定时备份 owner 也有独立验收：`dual:verify-go-backup-scheduler:container` 会在 `compose.go-backup-scheduler.yaml` 下运行，临时启用 Go scheduler、等待 fake SMTP 捕获第一封定时备份邮件、校验邮件来源地址解析到 Go 容器而不是 Node 容器，并恢复备份设置。

系统统计接口也按 Node 的成员/管理员边界收敛：普通用户只看到自己的照片、存储与趋势统计，并固定隐藏 runtime 信息；Go 侧聚合查询失败会返回 500，不把数据库错误伪装成 0 统计。

面向管理后台可切换能力，已登记 Go 路由不再用 `501 Not Implemented` 作为运行时保护；如果 Go 进程缺少必需依赖，会按服务不可用处理并通过 readiness/preflight 暴露，而不是让使用者误以为该接口尚未实现。

当前仍需持续扩展的严格一致性边界：

- 已实现的 Local/S3/OpenList、EXIF、Live Photo、展示图、缩略图与分享图需要继续用更大的真实媒体 corpus 做差分；
- 更大的真实媒体 corpus、生产级 pipeline consumer 长任务超时、资源限制、kill -9/磁盘满/重复执行故障注入和交接演练仍属于后续里程碑；受控 Redis stop/start、私有接口 fail closed、公开读取维持和 AOF session 恢复已进入自动化门禁，但网络分区、容量/驱逐、AOF 损坏及 failover 尚未覆盖；
- Go 与 Node 的全部深层业务错误分支、超时、权限矩阵、资源限制，以及更完整的真实媒体上传（大文件/断点/托管云对象存储/异常重试）等高副作用路径仍需持续差分；其中 85 条 Go-capable 非 runtime HTTP operation 的匿名/空 body 基础边界已由 `dual:verify-route-boundaries:container` 固化，上传准备、active S3 provider 预签名 URL 稳定字段、内部对象 PUT、默认 MIME/大小限制与重复检测已进入当前 mutation/单测验收，Go Local provider 取消写入不发布半成品且保留旧对象、context-aware upload reader 传播取消已由源级单测固定，认证后的上传准备/重复检测错误语义和公开上传分享 prepare/task/upload 负向边界已由 `dual:verify-authz:container` 固化，队列入队 payload schema 与授权已在 Go 单测中按 Node 语义固定，队列 retry/batch retry 与受保护 clear 删除边界已由 `dual:verify-queue-control:container` 固化，手动 database backup 成功链路已由 `dual:verify-backup:container` fake SMTP 固化，Go 定时备份 owner 已由 `dual:verify-go-backup-scheduler:container` 的 fake SMTP 发件源校验固化，本地 PNG 的 prepare → PUT → 入队 → Go consumer → 原图/缩略图/display GET/HEAD 读回，以及 Node/Go 公开上传分享匿名成功链路已由 `dual:verify-upload-pipeline:container` 固化；MinIO S3 上 Node/Go 各自的预签名上传、媒体读取和全对象删除已由 `dual:verify-s3-storage:container` 固化，OpenList 的认证上传、metadata、配置端点/`raw_url` 下载、删除与 Range fallback 已由 `dual:verify-openlist-storage:container` 的隔离协议 fixture 固化，但托管云 S3/CDN、真实托管 OpenList 和生产网络条件尚未覆盖。

因此当前产品承诺是“同仓库两套可切换后端、共享数据、已登记能力可回退”，而不是在未完成上述差分前宣称 Go 已经对所有边界 100% 等价。`deploy/dual` 是本地学习和验收栈，默认只绑定 `127.0.0.1`，并默认用 Docker named volume 承载共享 SQLite/WAL；当前生产式浏览器 smoke 已验证系统设置页中 Node.js/Go 选项双向切换保存，`dual:verify-switch:container` 已把该链路固化为可重复脚本：在 Compose tools 网络里先直连 `http://go:8080` 调用 Go 服务自己的 settings 写接口，把 provider 写为 `go`，再直连 Go 写入临时 `app.slogan`，随后切回 provider=`node` 并由 Node 立即读回这次 Go 直连写入的值；之后脚本会继续经网关反复执行 `node → go → node`，验证后续已登记 API 的 `X-ChronoFrame-Backend` 响应头随 provider 在 `node`/`go` 间变化，并在 provider=`go` 时经网关写入临时 `app.slogan`、切回 Node 后读回同一值，最后恢复原状态。`dual:verify-go-readiness:container` 会先证明网关 `/health/ready` runtime 路由与 Go 直连 `/health/ready` 都返回 Go backend、DB/Redis/mediaTools ready 和 schema 摘要；`dual:verify-route-surface:container` 会证明 85 条 Go-capable 非 runtime HTTP operation 在 provider=go 时没有经网关悄悄回落到 Node，并且同一批 operation 也能通过 `/__lab/go` 直连 Go API 面返回 `X-ChronoFrame-Backend: go`；脚本 summary 会稳定输出 `surfaceCounts.gateway=85`、`surfaceCounts.lab=85` 和 `probeCount=170`，便于直接审计两个表面都被覆盖；`dual:verify-route-boundaries:container` 会在同一 route set 上用匿名/空 body 探针比较 Node 与 Go 的 status、Content-Type、backend/request-id header、redirect、Set-Cookie 有无和规范化 body；`dual:verify-mutations:container` 进一步验证设置值、照片上传准备、内部对象 PUT、照片重复检测、后台用户创建/交叉读取/跨端更新/删除、相册、照片-相册关系、公开 reaction create/update/delete、照片元数据更新、存储配置和上传分享等接口在 Node/Go 之间写后可读或响应形状一致，并已把上传准备固定返回字段、active S3 provider 预签名 URL 稳定字段、上传 PUT 响应字段、重复检测结果顺序、后台用户与上传分享 create/update 的响应字段集、公开 reaction mutation 响应字段、存储配置 Local/S3/OpenList 默认值/未知字段剥离，以及上传分享毫秒级 UTC 时间格式纳入防漂移校验；`dual:verify-system-logs:container` 会在共享日志文件追加可识别事件，然后验证 provider=node/go 时 `/api/system/logs?initial=all` 都返回 SSE、`no-cache` 和同一 `data:` 事件行；`dual:verify-queue-control:container` 对全部 8 条队列控制路由执行 124 项生产镜像检查，覆盖共享 telemetry、任务列表/详情、鉴权和 JSON/Zod/数值边界，以及 Node↔Go 入队、重试和受保护 clear 生命周期；其中照片元数据切片使用真实 local storage object 覆盖原图 EXIF 重写、对象覆盖、重新抽取 EXIF 和 DB 更新链路；Go 单元测试同时固定了“不能降级或禁用最后一个活跃管理员”、队列入队 payload schema 剥离/拒绝规则、存储配置 Local/S3/OpenList schema 归一化、非管理员 storage/photo 访问授权、公开 reaction 60 秒/10 次 fingerprint 限流与 POST 缺失照片 404、照片删除时的 HEIC 转换 JPEG/displayKey 副作用列表，以及公开上传分享 Key 前缀隔离。

`dual:verify-authz:container` 使用管理员与普通用户固定 session 覆盖 145 条代表性权限/错误边界和 8 条成功响应（7 条 Live Photo 管理与 1 条普通用户 system stats），包括匿名 401、普通用户访问管理员资源 403、普通用户访问隐藏 display 派生媒体 404、访问保护开启时匿名访问预览外公开相册详情 401、设置路由参数校验 400、设置字段 query 校验/未知 namespace 404、重复 query 的 Zod/队列/上传错误语义、设置单项/批量 body 校验 400、空/null/malformed/尾随多段 JSON、相册创建/更新空值与缺失字段的 Zod detail、上传分享管理 create/update 的 null、类型、trim 后长度、整数上下界和非法/可转换路径校验、照片元数据更新的缺 body/null/字段类型/UTF-16 长度/标签/location/rating/畸形 JSON/空对象/空白 ID 校验、EXIF/LivePhoto 管理 action 校验、照片-相册关系 body/缺失资源校验、认证后照片上传准备空/null body 400、重复检测缺 body/null body Zod 校验、重复检测缺少全部输入时的 `data.title/data.message` 与 JSON 字段顺序、重复检测数组字段/元素类型 Zod 校验、公开上传分享 prepare/task 的 Zod 校验、公开上传分享 upload 缺 key 与不支持 MIME 校验、公开 reaction 缺失删除 404、照片更新缺失原图文件 404、缺失资源 404，以及普通用户系统统计 runtime 隐藏/照片聚合 body 对比，要求错误 envelope 关键字段、成功 body 关键字段、响应头和无 `Set-Cookie` 副作用一致。

`dual:verify-oauth:container` 会临时启用测试 GitHub OAuth 配置，对 Node 与 Go 执行 8 组无外部账号依赖的协议差分：初始跳转、空 code、重复/空 error、缺失或重复 state、重复 code、已有 state Cookie 的重定向。验收会逐项比较 302/401、`Location` 原始编码、H3 HTML body、11 字符 base64url state、`nuxt-auth-state` 的 Max-Age/Path/HttpOnly/Secure/SameSite 属性、清理 Cookie 和错误文案；脚本在 `finally` 中恢复原 OAuth 设置与 provider。

`dual:verify-upload-pipeline:container` 在 Go consumer owner override 下固定了本地 PNG 上传链路，要求 provider 切到 Go 后，prepare、内部 PUT、入队、任务完成、photo 记录、缩略图/display 生成、media 完整读回、HEAD 原图探针、stale If-Range 回落 200 和 suffix Range 读回都由 Go 响应头与 206/`Content-Range` 证明；同时要求 provider=`node` 与 provider=`go` 的公开上传分享都能由匿名访客完成 prepare、对象 PUT 和 task 入队，最终由 Go consumer 生成 photo，并持久化 `uploadCount=1` 与非空 `lastUsedAt`，且达到 `maxUploads` 后继续匿名 prepare 会返回 429。Node/Go 的公开分享任务提交都在同一 SQLite 事务内执行条件额度更新和队列插入；脚本还会并发直打 Node 网关与 Go lab 面，证明一个 `maxUploads=1` 的分享只产生一个成功任务，另一端稳定收到 429，且最终计数仍为 1。脚本会输出稳定的 `publicChecks: 14`、`exhaustedShareChecks: 2` 和 `atomicQuotaChecks: 6`；总 `checkCount` 会随任务轮询次数变化。照片元数据和本地 PNG pipeline 验证已经证明 Node/Go 的 API 与共享状态关键字段一致，但仍不等价于对 EXIF list 标签、真实相机 corpus、大文件或外部对象存储的字节级回归矩阵。

其中 S3 协议已不再只依赖 mock：`dual:verify-s3-storage:container` 已在 MinIO 上完成两轮真实预签名 PUT、Go consumer 派生、22 组跨端媒体对比和 Node/Go 各自的全对象删除。这里仍未覆盖的“外部对象存储”特指托管云 S3/CDN、真实 OpenList、跨公网网络条件和大文件 multipart/断点场景。

公开照片 reaction POST 的兼容矩阵也已进入自动差分：缺少请求体或 JSON `null` 时，两端都保留现有 Node 的 500 `Server Error`；基础类型、空对象、缺失字段或错误字段类型返回 400 `Invalid reaction type`；malformed/trailing JSON 返回 400 `Bad Request`。这是为保持现有客户端可观测行为而保留的兼容规则，未来若修正 Node 的状态码，需要同步升级两端契约。

Live Photo 管理接口已进一步从“路由存在”推进到行为差分：Go 的 `scan` 返回与 Node 相同的 `{ processed, matched, errors }` 结构，`detect` 对非数组、空数组、数字/null 数组元素及非法 SQLite binding 保持 Node 行为，`process` 对不存在对象和非字符串但 truthy 的 `videoKey` 返回同样的 `success:false` 结果，`update-photo` 的缺失资源与无匹配视频结果也已固定。请求根值同时覆盖缺 body、`null`、primitive/array、空白或数字 action、malformed JSON；Go 在检测和处理时会像 Node 一样真实读取视频对象，并按 `.HEIC → .heic → .HEIF → … → .jpeg` 的顺序确定同名照片，避免仅查 metadata 或无序 SQL `IN` 带来的假阳性和匹配漂移。`dual:verify-livephoto:container` 还会创建 4 组临时 photo + MOV，分别让 Node/Go 执行 `detect` 与 `process`/`update-photo` 成功写回，由另一端读取共享 SQLite 结果并反向删除，最后直接确认照片行和 MOV 对象均无残留。

## 2. 背景与现状

ChronoFrame 当前是一套 Nuxt 4 前后端一体应用，主要能力包括：

- 匿名公开画廊、访问密码和预览额度；
- 普通用户、管理员和分享上传访客；
- 照片、相册、反应、地图和地球视图；
- 图片、视频、Live Photo、Motion Photo；
- 本地、S3 和 OpenList 存储；
- EXIF、缩略图、展示图、转码和反向地理编码；
- SQLite 任务队列、定时备份、系统设置和日志。

基线审计时，后端约有 69 个 API 文件和 6 个媒体路由，API 文档尚未形成可执行契约，也没有现成的自动化测试。当前仓库已经补充 route manifest、OpenAPI、schema contract、Node/Go 单元测试和差分工具；设置缓存改为有界 TTL，会话、站点 access 和安全限流使用 Redis 共享协议。revision/outbox 与更广的跨进程缓存治理仍需按里程碑推进。因此，双后端建设继续以契约和共享状态为先，不以机械搬运代码量衡量进度。

共享 session、站点 access、限流和 pipeline consumer runtime lease 已经使用 Redis 协议；Go normal 请求也直接读写共享 SQLite/Redis。登录与访问密码限流使用同一 Redis Lua 协议、同一 `cf:v1:<env>:ratelimit:<purpose>:<digest>:<window>` key 规则和同一 HMAC secret 派生规则，因此在 Node/Go provider 间切换不会重置攻击者的登录或站点解锁尝试次数。默认双栈仍由 Node 执行 schema migration；若显式使用 Go one-shot migrator，则 Node 只等待该迁移 job 完成并跳过自己的 Drizzle migrator。backup scheduler 可以通过 owner 环境变量交给 Go；Go pipeline consumer 仅在显式 owner=go 的学习配置中消费已实现的 `photo`、`live-photo-video`、`video`、`photo-reverse-geocoding` 与 `photo-erase-location` 切片，启动时如果 runtime lease 被旧实例短暂占用会等待重试，但不能因为 HTTP 切换而启动第二个 worker、migration 或 scheduler。

### 2.1 用户价值

- 现有用户继续稳定使用照片、相册、上传和浏览，不需要理解双栈内部结构。
- 被授权用户可以提前体验已验收的 Go 能力，并清楚看到当前后端。
- compare/shadow 失败不会改变 primary 的用户可见结果；shadow 不增加主请求等待，compare 会明确展示对照耗时或超时。
- Go 出现故障时可以回到 Node，继续读取同一份数据，不丢失资源归属。
- 开发者获得一条从只读 API 到并发 worker 的渐进式 Go 学习路径，同时保留真实产品反馈。

## 3. 目标

### 3.1 产品目标

1. Node.js 稳定路径不因 Go 学习实验而中断。
2. 每项 Go 能力都有对应的 Node 行为基线、测试夹具和差异报告。
3. 管理员可以按业务能力组选择 Node/Go；纯读能力可快速回到 Node，写能力可按受控流程安全交接。
4. 登录身份、资源归属、站点访问资格、设置和队列状态在两套后端中一致。
5. Go 学习过程覆盖真实工程主题：HTTP、认证、数据库、缓存、事务、存储、流式 I/O、并发、任务队列、媒体处理、可观测性和测试。
6. 已复刻能力可以长期保持兼容，而不是在一次迁移完成后停止维护。

### 3.2 成功定义

双后端模式成功，不等于“Go 接口数量达到 100%”，而是同时满足：

- 可选择：明确知道每条请求由哪个后端处理；
- 可比较：同一输入可以得到结构化差异；
- 可隔离：实验性写操作不会污染生产数据；
- 可回退：关闭 Go 不需要恢复数据库；
- 可学习：每个阶段都有可运行成果和可验证知识点；
- 可维护：数据库 schema、能力归属和 API/缓存协议都有唯一权威版本。

## 4. 非目标

本项目不包含：

- 退役 Node.js 后端或强制全站迁往 Go；
- 同时改写 Nuxt 前端；
- 为学习 Go 而立即迁移 PostgreSQL 或移动现有媒体对象；
- 在生产库上同时执行 Node 与 Go 的同一写请求；
- 对 `POST`、`PUT`、`PATCH`、`DELETE` 做影子双写；
- 在没有权限和资源隔离的情况下开放 Go 调试接口；
- 把“Go 必须比 Node 快”作为唯一成功标准；
- 一开始就拆成微服务；
- 静默改变隐藏相册、公开访问、所有权等现有产品语义；
- 为追求覆盖率而复刻没有真实行为的占位功能。

## 5. 用户与角色

### 5.1 管理员

管理员可以：

- 查看 Node、Go、各能力成熟度、Redis、SQLite 和对象存储健康状态；
- 启用或停用 Go 实验入口；
- 为可选择的纯读能力设置默认实现，并通过受控流程变更生产 capability owner；
- 按“公共读取、照片浏览、相册管理、上传链路、媒体读取、队列消费者”等能力组配置归属；
- 允许指定用户参与 Go 实验；
- 将上传、删除、用户管理、设置、备份等高风险功能固定到 Node；
- 查看响应差异、延迟、错误率和 Go 版本；
- 创建、重置和销毁 Go 写入沙箱；
- 使用全局开关立即阻止新的 Go 请求，并发起安全回切流程。

管理员不能启用会造成双写、双任务消费或跨用户数据泄露的组合。

### 5.2 普通用户

普通用户只有在管理员授权时才可以：

- 在个人会话中为可选择的纯读能力选择 Node 或 Go；
- 查看当前请求实际使用的后端；
- 在属于自己的隔离沙箱内体验 Go 写能力；
- 查看只与自己请求相关、且已经脱敏的差异摘要。

普通用户不能修改全局路由策略、查看其他用户的诊断信息或绕过管理员设置的后端归属限制。

当前实现的选择规则固定为：Node 是全局默认；管理员在系统设置中选择 `node` 或 `go`；选择结果对 `GO_API_ROUTES` 中登记的 HTTP operation 生效；切换设置的单项写接口始终由 Node 处理。未登记的接口以及未迁移的后台 actor 继续由 Node 处理；全局 worker pool telemetry 使用共享 Redis 供两端读取。未来增加用户级选择或 capability 级 owner 时，必须保持同一聚合只有一个生产 writer。

### 5.3 匿名访客

匿名访问始终遵循系统默认策略，不能通过公开请求头随意选择后端。公开照片、公开相册、访问密码和预览限制必须在两套后端中保持相同。

### 5.4 开发者

本地开发者可以通过受控请求头、开发 Cookie 或测试 CLI 明确选择 Node/Go，运行契约对照，并查看完整诊断数据。此能力默认只在开发环境开放。

## 6. 后端与运行模式

“后端实现”和“运行模式”是两个独立维度：

| 维度 | 可选值        | 含义                                                |
| ---- | ------------- | --------------------------------------------------- |
| 后端 | `node` / `go` | 实际执行业务能力的实现                              |
| 模式 | `normal`      | 只有选定后端执行并返回                              |
| 模式 | `compare`     | 当前 owner 返回主结果，另一个实现同步对照           |
| 模式 | `shadow`      | 当前 owner 返回主结果，另一个实现异步观察           |
| 模式 | `sandbox`     | 选定的实验实现（初期为 Go）在隔离状态中执行真实写入 |

### 6.1 Normal

- 每个能力组有唯一活动后端，内部路由必须整体服从该归属。
- 生产默认值为 Node。
- 已验收的能力可以切到 Go。
- Go 失败后，写请求不能自动重放到 Node；是否重试由用户明确决定。

### 6.2 Compare

- 当前 capability owner 的结果是用户可见的唯一结果。
- peer implementation 接收等价输入并生成比较结果。
- 首期仅允许经过白名单确认的纯读接口。
- 比较状态码、错误语义、JSON、排序、分页、权限结果和必要响应头。
- 时间、请求 ID、签名 URL 等非确定字段使用字段级规则规范化。
- peer implementation 不得写生产数据库、Redis 会话、对象存储或任务队列。

### 6.3 Shadow

- primary 请求不等待 shadow，shadow 的延迟和故障不影响用户。
- 只镜像明确声明无副作用的请求。
- 输入日志必须脱敏；不保存密码、Cookie、存储密钥和完整媒体内容。
- 记录 primary/peer 的实现、成熟度、耗时、资源消耗和结果摘要。
- 不能把所有 `GET` 都当成纯读：当前登出接口和按需生成展示图等请求具有副作用。

### 6.4 Sandbox

- 用于练习创建、修改、删除、上传和任务处理。
- 使用生产数据的脱敏快照或固定 fixture，不直接使用生产业务表。
- 使用独立 SQLite 文件、Redis namespace 和对象存储前缀，例如 `sandbox/<sandboxId>/`。
- 支持一键重置、导出差异和销毁。
- 沙箱结果不得自动合并回生产数据。

## 7. 后端选择规则

后端选择按以下优先级执行：

1. 全局安全开关；
2. 能力组级强制归属；
3. 管理员分配的用户或用户组策略；
4. 已授权用户的会话选择；
5. 系统默认值 `node`。

需要满足：

- 管理员选择覆盖已登记且通过验收的 Go HTTP 能力；高风险后台 actor（migration、worker、scheduler）始终服从唯一 owner；
- 选择结果对同一上传、登录或媒体处理链路保持稳定；
- 匿名请求不能通过伪造 `X-ChronoFrame-Backend` 绕过策略；
- 网关移除外部同名内部请求头，再写入可信的路由结果；Node 转发到 Go 时会补充受信的 `X-ChronoFrame-Original-*` 上下文，确保 reaction fingerprint、原始 URL 和诊断字段不被内部 hop 改写；
- 每个响应都能识别实际后端；
- 每个队列任务都记录创建它的后端，但任务消费者仍只有一个。

建议响应头：

```text
X-ChronoFrame-Backend: node | go
X-ChronoFrame-Mode: normal | compare | shadow | sandbox
X-ChronoFrame-Backend-Version: <version>
X-ChronoFrame-Maturity: experimental | verified | stable
X-Request-Id: <id>
```

## 8. 产品界面

建议新增管理员页面 `/dashboard/system/backend-lab`，包含：

1. **运行状态**：Node、Go、Redis、SQLite、存储和 worker 健康状态。
2. **全局控制**：Go 总开关、纯读默认实现、阻断新 Go 请求和安全回切状态。
3. **能力矩阵**：能力组、当前 owner、支持模式、各实现成熟度和最近差异；需要诊断时可展开内部路由。
4. **差异报告**：按时间、接口、用户、请求 ID、版本和严重度筛选。
5. **学习进度**：模块、知识点、测试覆盖和验收状态。
6. **沙箱管理**：创建、重置、导出和销毁。

主要页面为登录用户显示低干扰状态标识：

| 状态         | 推荐文案                                |
| ------------ | --------------------------------------- |
| 当前实现状态 | `<implementation> · <maturity>`         |
| 同步对照     | `Compare · <owner> primary`             |
| 异步观察     | `Shadow · <owner> primary`              |
| 隔离实验     | `Sandbox · <implementation> · Isolated` |
| 已安全回退   | `Fallback · Node`                       |

例如，Go 学习能力可以显示为 `Go · Experimental`，验收后显示为 `Go · Verified` 或 `Go · Stable`；同一规则也适用于 Node，界面不把成熟度永久绑定到语言。

匿名访客无需看到内部版本、路由策略或诊断数据。

## 9. 功能需求

### FR-01：能力所有权

- 系统必须维护版本化的能力归属清单。
- 面向管理员只暴露业务能力组，避免拆散上传、相册、身份或队列等完整链路。
- 内部清单再把能力组展开为 HTTP 方法与路径模板，并声明是否纯读、是否允许 compare/shadow 和最低契约版本。
- 未配置的纯读请求默认回到 Node。
- 未匹配的 mutation 必须使用清单中的显式 Node owner 或返回 503，不能在能力已经交接后隐式落到另一个 writer。

验收：任意请求都能从响应头和日志确认最终后端；关闭 Go 并按 capability 完成安全回切后，所有业务路由可继续由保持兼容的 Node 提供。

### FR-02：共享业务数据

- Node 与 Go 在 normal 模式读取同一 SQLite 数据库；当前支持边界是同一宿主机上的本地共享数据卷，本地双容器学习栈默认使用 Docker named volume。
- 不支持把 SQLite 放在 NFS、SMB 或跨主机共享卷上。
- 两边使用相同表、字段、时间、JSON、布尔值和事务语义。
- 数据库 schema 只能由一个迁移器管理。
- 禁止两套迁移工具在服务启动时竞争执行。

验收：任一后端完成的已批准写操作，另一后端下一次读取可正确理解。

### FR-03：共享会话与访问资格

- Node 与 Go 使用同一 opaque session Cookie 和共享会话记录。
- 会话只保存最小身份信息，不包含密码哈希、存储凭据或用户完整数据行。
- 用户被停用后，两套后端均立即拒绝其会话。
- 站点访问密码的授权版本在两套后端同步失效。
- 目标方案通过带 Redis 一次性兑换账本的 Node bridge 将有效旧 Cookie 迁到共享 session；无账本的 stateless 兑换禁止上线，因为旧 Cookie 可在 logout 后重放。
- 当前 M0/M1 安全切断策略是：只要配置共享 Redis，就禁用 legacy-only session fallback，升级用户需要重新登录一次；业务数据不受影响。无感迁移属于后续 M2 交付，不能以恢复不安全 fallback 实现。
- 当前双栈共享 Redis 模式同样不在公开读取时兑换旧站点 access Cookie；升级用户需要重新输入一次站点密码，随后使用新的 `cf_access` 共享授权。带一次性兑换账本的无感迁移属于后续 M2。
- 兑换失败时只要求该用户重新登录或重新输入站点密码，不修改其业务数据。
- 回退到 Node 时，Node 继续识别新的共享 session，不能因后端回退再次注销用户。

目标验收：在 Node 成为 identity owner 时登录后无需再次登录即可访问 Go 授权路由；Go 经受控交接成为 identity owner 后，反向亦然；登出会同时使两边失效；上线一次性兑换账本后，正常迁移和路由回退不造成批量掉线。当前 `dual:verify-identity:container` 已用真实密码登录固定双向证明：Node 签发的共享 session 可被 Go 读取并由 Go 撤销，Go 签发的共享 session 可被 Node 读取并由 Node 撤销，撤销后两端都立即返回 401；升级前 legacy sealed Cookie 的一次性无感兑换账本仍未实现。

### FR-04：共享缓存与限流

- 正确性所依赖的跨进程临时状态迁到 Redis。
- 至少包含会话、站点访问授权、访问密码限流和配置失效通知。
- Redis 不替代 SQLite 成为业务数据真相来源。
- Redis 不可用时，每类能力必须有明确的 fail-open 或 fail-closed 策略。

验收：两端对已提交状态遵循同一份一致性契约；共享 session、登出和限流状态在 Redis 提交后立即可见，Node/Go 设置写入通过共享 Redis 版本键触发 Node L1 设置缓存失效，且 TTL 兜底保证不会永久陈旧；其中 `system:backend.readProvider` 是网关控制面，分流判断必须直读 SQLite 并在保存后的下一跳立即生效；持久化 revision/outbox 属于后续增强。反向写入仅在对应能力的 owner 已完成受控交接后成立。

### FR-05：共享对象存储

- 两套后端理解同一对象 Key、Provider 配置和 URL 规则。
- normal 模式可以读写共享对象存储，但每个写请求只有一个执行者。
- compare/shadow 禁止落盘；sandbox 使用隔离前缀。

验收：Node 上传的照片可由 Go 正确读取，Go 正常模式上传的已验收对象可由 Node 正确读取；对已验收本地 PNG 样本，Node/Go 的稳定媒体响应头和响应字节 SHA-256 一致。

### FR-06：权限一致

- 匿名、普通用户、管理员、分享上传访客的行为矩阵一致。
- 普通用户不能访问其他用户的私有原图、缩略图、视频、相册或任务。
- 越权资源保持 404 隐藏语义。
- 公开照片的唯一规则固定为“该照片不属于任何隐藏相册”；未加入相册的照片公开，同时属于公开与隐藏相册的照片不公开。
- 公开相册的封面和详情也必须逐张应用上述规则，不能因位于公开相册而绕过。
- 站点密码只解锁公开集合的预览限制，不授予他人私有/隐藏媒体权限。
- 用户是否 active 暂不改变其既有照片的公开性；如需改变必须另立产品决策。

验收：权限矩阵契约测试 100% 通过，跨用户越权成功数为 0。

### FR-07：对照与差异

- compare/shadow 为每次执行生成关联请求 ID。
- 差异按“批准差异、待确认、兼容性错误、安全错误”分类。
- 用户可见结果永远来自 primary。
- 安全差异立即阻止涉及的 implementation/capability 进入或继续处于 normal 模式。

验收：每项差异能定位到接口、请求摘要、两个版本和字段路径。

### FR-08：写入安全

- 生产模式不双写。
- 高风险写接口只有通过完整契约、事务和恢复测试后才允许归 Go。
- 不对写请求做失败自动 fallback，避免重复创建或删除。
- 客户端重试必须使用共同的幂等规则。

验收：故障注入下不产生重复相册关系、重复照片记录、超额分享上传或重复媒体任务。

### FR-09：任务队列

- Node 与 Go 可以实现同一任务处理能力，但生产队列任一时刻只有一种 worker 消费。
- 管理员可以查看当前消费者和切换状态。
- Go worker 学习阶段先使用沙箱队列。
- 生产消费者切换必须先停止入队、排空运行中任务，再交接所有权。

验收：两个消费者不能同时处于 active；崩溃恢复不丢任务、不重复产生用户可见记录。

### FR-10：可观测性

- Node 和 Go 使用相同请求 ID。
- 日志、指标和差异报告必须包含 backend、mode、version、routeId。
- 监控数据库忙、Redis 错误、队列堆积、媒体耗时和对象存储错误。
- 管理员日志不得泄露 Cookie、密码、Token 和存储密钥。

### FR-11：安全回退

- 提供全局和能力组级 Go kill switch；触发后立即阻止新的 Go mutation。
- 纯读能力可以秒级或分钟级切回 Node。
- 写能力必须先 quiesce、等待或处置 in-flight、更新唯一 owner，再启用 Node writer；每项能力单独定义 RTO。
- Worker 回切时间至少包含 drain 和 lease timeout。
- 正常回退继续使用当前共享数据库，不恢复旧快照。
- Node 若要作为长期回退实现，必须持续兼容 Go 已批准写入的 schema 和数据格式。

验收：纯读能力恢复 Node 小于 1 分钟；写能力在各自 runbook 的 RTO 内完成，且回切期间没有双 writer。

### FR-12：学习记录

每个 Go 模块必须附带：

- 要学习的 Go 概念；
- 对应 Node 源代码位置；
- API 与数据契约；
- 单元、集成和差异测试；无副作用读接口的差异测试范围必须从路由契约派生，不能靠脚本里的零散路径白名单；
- 性能与错误处理复盘；
- 可以独立运行的最小示例或测试。

## 10. 保持不变的产品契约

第一阶段必须保持：

- URL、HTTP 方法、query/body、状态码和 JSON 字段；
- 登录成功当前使用的状态语义；
- 用户、照片、相册、队列与上传分享的所有权；
- 普通用户只管理自己的数据，管理员管理全局数据；
- 隐藏相册和公开照片的既定语义，除非另立产品变更；
- 默认匿名预览额度；
- 本地/S3/OpenList Key 结构；
- 视频 Range、ETag、缓存与条件请求；
- 任务状态和前端轮询可理解的字段；
- 备份格式和恢复能力。

允许但必须显式批准的差异：

- 修复安全漏洞；
- 更严格的非法路径、MIME 和大小验证；
- 更安全的 Cookie 与会话内容；
- 非字节级相同但视觉等价的派生媒体；
- 新增诊断响应头，不改变响应体。

## 11. 基线问题与不应复刻的行为

以下列表来自基线审计；其中部分 Node 基线已经在 M0/M1 整改，但仍保留在这里，明确 Go 实现和双栈基础设施不得为了“行为一致”重新引入这些行为：

1. 首次启动写接口在初始化完成后仍可匿名调用；
2. 登录会话保存完整用户行并可能暴露密码哈希；
3. 登录和站点访问 Cookie 固定 `secure: false`；
4. 本地存储 Key 未彻底拒绝 `..` 路径穿越；
5. 普通用户可能通过部分媒体路由读取其他用户媒体；
6. 公开相册详情与公开照片谓词不一致；当前 Node/Go 已同步修复，并由访问保护开启、`albumLimit=1`、预览外公开相册详情 401 的 fixture 差分固定；
7. 基线的访问密码限流仅存在单个 Node 进程内；当前已改为 Redis 原子共享限流；
8. 基线的设置缓存会永久陈旧；当前默认最多缓存 5 秒，并已通过共享 Redis 版本键在 Node/Go 设置写入后主动清理 Node L1，revision/outbox 仍属于后续路线；
9. 基线的分享上传配额检查与计数不是同一原子操作；当前 Node/Go 已改为在同一 SQLite 事务中通过条件更新抢占额度并插入队列任务，插入失败会整体回滚，并由跨端并发验收固定 `maxUploads=1` 时只能成功一次；
10. 基线队列的重试时间曾经不会真正阻止任务立即再次被获取；当前已改为 `available_at` 调度；
11. 基线两个 worker 缺少 lease 时可能重复消费；当前已加入 Redis runtime lease 防止 Node/Go 双消费者同时启动，并在 `pipeline_queue` 增加任务行级 lease/fencing token。

这些差异应标记为 `approved-security-fix`，并同步修复 Node 基线或在契约中明确新行为。

## 12. 学习里程碑

| 阶段              | 级别   | Go 交付能力                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 主要学习内容                           | 退出标准                                         |
| ----------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------ |
| M0 契约与运行骨架 | 核心   | 健康检查、网关、OpenAPI、共享 Redis、SQLite WAL                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 模块、`net/http`、配置、Docker、观测   | Node 默认路径不变；Go 可独立启动；契约测试可运行 |
| M1 公共只读       | 核心   | public settings、可见照片、公开相册与地图                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | SQL、JSON、分页、错误映射              | Node/Go 代表性差分 100% 通过                     |
| M2 身份与授权     | 核心   | 共享 session、profile、用户范围查询、Go 登录与权限中间件；`dual:verify-identity:container` 已固定 Node/Go 双向签发、跨端读取和跨端撤销，`dual:verify-redis-outage:container` 已固定 Redis 中断时的一致失败关闭与 AOF 会话恢复                                                                                                                                                                                                                                                                                      | Cookie、Redis、密码校验、授权中间件    | 两端创建的 session 均可被对端校验并跨端撤销      |
| M3 低风险 CRUD    | 已实现 | 相册 CRUD、反应、照片元数据、队列写入和 targeted retry/batch retry/clear 控制；`dual:verify-queue-control:container` 用临时队列行覆盖 Node/Go retry 响应、跨端 stats 读回、安全 no-op clear 与前置保护后的真实 clear 删除                                                                                                                                                                                                                                                                                          | 事务、幂等、乐观冲突                   | Go owner 写入后 Node 可读；失败可回切            |
| M4 上传与媒体读取 | 已实现 | Local/S3/OpenList 读写、Range、直读对象 HEAD、媒体授权、上传准备、内部对象 PUT、重复检测、上传分享、队列入队 payload 规范化、展示图/缩略图/share image；本地 PNG 的 Go prepare → PUT → 入队 → consumer → 原图/派生图 GET/HEAD 读回、Node/Go 公开上传分享匿名完整链路，以及 Node/Go 并发争抢单次分享额度时仅一个任务提交成功，已由 `dual:verify-upload-pipeline:container` 覆盖；本地 PNG 的 `/image`、`/storage`、`/display`、`/thumb` 入口稳定响应头和字节 SHA-256 已由 `dual:verify-media-parity:container` 覆盖 | `io.Reader`、流式 I/O、HTTP Range、SDK | Provider 与真实媒体 corpus 差分通过              |
| M5 媒体处理       | 进行中 | 普通图片导入、EXIF 重建、基础图片变换、HEIC 转 JPEG、MP4 视频处理、thumbhash、Live Photo 探测/关联和 Motion Photo XMP 提取已实现；真实媒体 corpus 继续补齐                                                                                                                                                                                                                                                                                                                                                         | goroutine、进程控制、资源限制          | golden corpus 达标；不依赖 M4；不触碰生产队列    |
| M6 可切换 worker  | 进行中 | Go consumer 已支持 `photo` 导入、HEIC 转 JPEG、`live-photo-video` 配对、Motion Photo XMP 提取、`video` MP4 处理、`photo-reverse-geocoding` 反向地理编码和 `photo-erase-location` 位置擦除切片；Redis runtime lease 已保护消费者启动互斥，`pipeline_queue` 已补齐任务级 lease/fencing token 与 `available_at` 重试调度；Node/Go 正常退出均先 stop-claim、保持续租并 drain，排空后才主动释放 owner lease；生产故障注入与维护窗口交接演练继续推进                                                                     | 并发、租约、at-least-once、幂等        | 可在维护窗口切换消费者且无丢失                   |
| M7 控制面         | 已实现 | settings/storage、用户管理、OAuth/向导、public settings、system stats、手动 backup、logs、Go backup scheduler 均已实现并通过各自生产镜像专项门禁                                                                                                                                                                                                                                                                                                                                                                    | 缓存失效、加密、SSE、定时任务          | 已登记控制面路由门禁通过；外部恢复演练继续       |
| M8 长期运营       | 核心   | 能力矩阵、差异面板、版本策略                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 兼容性治理、性能分析                   | 两套后端可持续独立发布                           |

M8 的终点是“双后端稳定共存”，不是删除 Node。

当前已完成 M0-M4 的主要纵切与 M7 已登记控制面路由，并覆盖了 M5/M6 的后台 actor 与媒体处理能力；默认双栈仍由 Node 承担 migration 和生产默认 pipeline worker，但 Go 已能作为显式 one-shot migrator 复用同一份 Drizzle SQL ledger 从空库启动，并同步初始化默认 settings metadata，backup scheduler 可配置为 Node 或 Go 单 owner，Go consumer 已能处理 `photo` 导入、HEIC 转 JPEG、`live-photo-video` 配对、`video` MP4 处理、Motion Photo XMP 提取、`photo-reverse-geocoding` 反向地理编码和 `photo-erase-location` 位置擦除切片，Go 可在管理员选择后成为全部已登记 HTTP operation 的 normal owner。共享身份的受控 Redis 中断/恢复也已纳入 M2 容器门禁；后续继续补齐真实媒体 corpus、生产 worker 交接和外部恢复演练。

M1/M2 已完成共享身份和主要权限路径；已通过差分的读写 operation 可以在 normal/go 运行。Local/S3/OpenList、ExifTool/ImageMagick/rsvg 依赖已进入 Go 运行时镜像，但仍需通过更大的真实 corpus、错误矩阵和资源限制测试后再标记为 stable。

## 13. 验收指标

### 13.1 行为一致性

相册切片已把“字段相同”推进到写入语义相同：Go 不再裁剪 Node 会保留的标题、描述和封面 ID，按 JavaScript UTF-16 长度校验；创建时自动把非空封面加入相册照片关系，更新未提供照片列表时保持原关系，并将基本字段和关系替换置于同一事务。`dual:verify-albums:container` 以 88 项检查覆盖两轮双向交叉生命周期、5 组读取和 42 组深层边界，并精确校验 mutation 返回字段、嵌套 Zod 错误、响应头和无 Cookie 副作用；Go 单测同时固定关系失败时整笔更新回滚。

身份门禁当前包含 26 项检查，除 Node/Go 双向 session 签发、跨端读取和两个撤销入口外，还固定随机不存在邮箱登录的 401、无 session Cookie 与无效凭据错误 envelope 一致。

- 已进入 normal 的 Go 能力：状态码、权限和确定性字段一致率 100%；
- 固定 fixture/snapshot 上的确定字段一致率为 100%；
- `dual:compare:container` 在固定 fixture session 下从 route contract 派生全部可比较读样本，当前覆盖 40 个数据获取场景，并已纳入照片管理搜索/分页/媒体类型和地图范围的重复 query、后台 `queue.stats` 与管理员 `system.stats`，要求 Node/Go 状态码、响应体、关键响应头和无 Cookie 副作用一致；时间戳、进程 uptime、worker uptime 与内存 used 这类天然运行态字段只通过显式 normalizer 忽略；
- `dual:verify-switch:container` 在固定 fixture session 下从 Compose tools 网络连续执行 `node → go → node` 切换成功率 100%，且会先直连 Go 服务自己的 settings 写接口证明 Go 可独立写入 provider 设置和真实 `app.slogan`；切回 provider=`node` 后，Node 必须立即读回 Go 直连写入的 slogan；切换后的已登记读请求响应头必须与目标 provider 一致；脚本还会在 provider=`go` 时经网关写入临时 `app.slogan`，切回 provider=`node` 后读回同一值，并在结束时恢复原 slogan 和 provider；
- `dual:verify-mutations:container` 覆盖的上传准备、内部对象 PUT、重复检测、公开 reaction create/update/delete 和可逆数据库 mutation 切片通过率 100%，临时数据清理成功率 100%；
- `dual:verify-albums:container` 固定输出 88 项检查，完整覆盖 9 条相册路由的读取、深层错误边界、双向跨运行时生命周期和 finally 清理；当前通过率与临时数据清理成功率均为 100%；
- `dual:verify-admin-users:container` 固定输出 110 项检查，完整覆盖 4 条后台用户路由的读取、49 组深层错误边界、双向跨运行时生命周期、用户数据归属转移、失效 session 清理和 finally 清理；当前通过率与临时数据清理成功率均为 100%；
- `dual:verify-reactions:container` 固定输出 72 项检查，完整覆盖 4 条照片表态路由的读取、query/JSON/权限/缺失资源边界、双向跨运行时生命周期、匿名指纹隔离、共享 SQLite 限流和 finally 清理；当前通过率与临时数据清理成功率均为 100%；
- `dual:verify-livephoto:container` 固定输出 26 项 HTTP 检查，Node/Go 各自执行 `detect`、`process`、`update-photo` 成功写回，并由对端读回和删除；4 组临时照片行与 MOV 对象清理成功率 100%；
- `dual:verify-openlist-storage:container` 固定执行 4 轮完整流水线（Node/Go owner × 配置下载端点/metadata `raw_url`），共比较 88 组 Node/Go 媒体结果；认证上传、metadata、下载、删除、上游忽略 Range 时的客户端 fallback 和临时对象/配置清理通过率 100%；
- `dual:verify-redis-outage:container` 固定输出 74 项行为检查和 3 项清理检查：Redis 中断时 Node/Go 已认证 profile 均返回相同 503 错误契约，公开照片读取均为 200 且 body 一致，Go readiness 为 503 并标记 Redis failed；Redis 恢复后原 AOF session 被两端接受，readiness 恢复且 provider 回到 Node；不把机器相关耗时作为验收指标；
- `dual:verify-system-logs:container` 覆盖的管理后台日志 SSE provider 切换、响应头和事件行读取通过率 100%，最终 provider 恢复为 Node；
- `dual:verify-authz:container` 覆盖的 145 条匿名/普通用户/管理员/公开上传分享错误边界与 8 条成功响应通过率 100%，且 401/403/400/404/415/500 的关键错误字段、Zod 风格校验 detail、空/null/malformed/多段 JSON、成功 body 关键字段、JSON 字段顺序和响应头一致；
- `dual:verify-oauth:container` 覆盖的 8 条 GitHub OAuth 初始化、回调 query、state Cookie、redirect 与错误协议样本通过率 100%，并在结束时恢复 OAuth 设置和 provider；
- `dual:verify-media-parity:container` 覆盖的本地 PNG `/image`、`/storage`、`/display`、`/thumb`、HEAD、Range、stale If-Range 的 Node/Go 稳定响应头和字节 SHA-256 parity 通过率 100%，最终 provider 恢复为 Node；
- `dual:verify-upload-pipeline:container` 覆盖的 Go 本地 PNG 上传流水线和 Node/Go 公开上传分享匿名成功/限额耗尽链路通过率 100%，且普通上传的 prepare、对象 PUT、队列入队、任务完成、photo 记录、缩略图/display 生成和媒体 GET/HEAD 读回都必须由 Go 响应头证明；公开上传分享必须证明匿名 prepare/PUT/task、Go consumer 消费、Go photo 读回、`uploadCount/lastUsedAt` 落库和 `maxUploads` 耗尽后 429 响应，并证明 Node/Go 并发提交同一个单次额度分享时恰好一个 200、一个 429、一个队列任务和一次计数；
- 在线 shadow 必须记录数据 revision、两次读取时差和并发变更，先排除假差异，再建立真实 mismatch SLO；
- 安全与权限差异必须为 0；
- 所有允许差异都有字段级原因、负责人和到期时间；
- API 契约覆盖所有显式 API、媒体路由和隐式认证路由。

### 13.2 数据安全

- compare/shadow 对生产 SQLite、Redis 业务状态和对象存储的写入数为 0；
- 跨用户私有资源读取成功数为 0；
- 双写导致的重复记录数为 0；
- 同一生产队列同时存在 Node 与 Go active consumer 的时间为 0；
- sandbox 跨环境写入成功数为 0。

### 13.3 可用性

- Go 故障不影响仍归 Node 的路由；
- 纯读能力回退小于 1 分钟；
- 写能力回退满足各自经过演练的 drain/lease RTO；
- shared-state 服务异常有清晰提示，不静默产生不一致状态。

### 13.4 学习效果

- 每个里程碑至少包含一份设计记录和一次复盘；
- 每个 Go 模块都有 Node 对照入口；
- 每个生产写能力先在 sandbox 完成故障测试；
- 学习进度用通过的契约而不是代码行数衡量。

## 14. 发布门槛

一个 Go 能力组进入 normal 模式前，必须满足：

1. OpenAPI 契约和示例已冻结；
2. 匿名、用户 A、用户 B、管理员权限矩阵通过；
3. Node/Go differential test 无未批准差异；
4. SQLite 和 Redis 故障行为已验证；
5. 写路由的事务、幂等和并发测试通过；
6. 日志中无敏感字段；
7. 有能力组级 kill switch；
8. owner 切换不会启动第二个 worker 或 scheduler；
9. 对应文档与学习复盘完成。

## 15. 默认决策与待确认项

本文采用以下默认值：

| 事项           | 默认决策                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| 稳定生产默认   | Node                                                                                                  |
| 公网入口       | 单一反向代理网关                                                                                      |
| 业务数据库     | 继续共享本机 SQLite                                                                                   |
| 跨进程缓存     | 新增 Redis                                                                                            |
| Schema 所有者  | 默认由 Node/Drizzle 唯一管理；Go 可作为 one-shot job 执行同一 SQL ledger                              |
| 会话           | 迁到 Redis opaque session，Node/Go 共用                                                               |
| Go 选择权      | 管理员通过 `system:backend.readProvider` 全局选择；网关分流直读该控制项；未登记 operation 仍回到 Node |
| compare/shadow | 只对白名单纯读请求开放                                                                                |
| 写能力学习     | 已登记写 operation 由 Go normal owner 执行；migration/worker/scheduler 仍单 owner                     |
| 任务消费       | Node 或 Go 二选一，不并发                                                                             |
| 最终状态       | Node 与 Go 长期并存                                                                                   |

继续进入生产化前仍需确认：

- 差异报告保存期限和脱敏等级；
- 生产环境是否启用 shadow，还是只在本地/测试环境启用；
- 是否存在需要长期保持单一实现归属的特殊写操作。

## 16. Definition of Done

双后端学习模式整体完成时：

- Node 和 Go 都能独立启动并通过健康检查；
- 两边共享业务数据、会话缓存和对象存储契约；
- 所有能力与内部路由都有 owner 和兼容状态；
- compare、shadow、sandbox 的隔离边界被自动化测试证明；
- 管理员能看到实际后端、差异和运行状态；
- 所有生产写请求只有一个执行者；
- 数据库迁移、worker、scheduler 都只有一个 owner；
- 关闭 Go 后，Node 可以继续使用当前数据无损运行；为此 Node 必须长期保持对共享 schema 与已批准写格式的兼容；
- 项目文档明确保留两种实现，不再将 Go 描述为替换路径。

## 17. 相关资料

- [项目总览](/zh/wiki/overview)
- [开发者参考](/zh/wiki/development)
- [API 文档](/zh/development/api)
- [Node.js + Go 双后端技术设计](/zh/development/dual-backend-technical-design)
