# ChronoFrame 当前技术架构与业务架构

> 基线：当前仓库 `main` 分支，Node.js + Go 双后端共存阶段。  
> 关联图：[/architecture/chronoframe-current.html](/architecture/chronoframe-current.html)  
> 关联设计：[Node.js + Go 双后端技术设计](/zh/development/dual-backend-technical-design)、[双后端学习模式 PRD](/zh/development/dual-backend-product)

本文用于回答两个问题：

1. 当前系统由哪些技术模块组成，它们如何协作。
2. 当前产品业务能力如何分层，权限、媒体、上传、后台和运维分别由谁负责。

## 1. 总体结论

ChronoFrame 当前是“Nuxt/Node 稳定入口 + Go 可切换后端 + SQLite/Redis/对象存储共享状态”的单仓库双后端系统。

```text
浏览器
  Nuxt 4 页面与 SSR
    Node.js / Nitro 网关
      ├─ 默认直接处理稳定 API、SSR、媒体 fallback、迁移与控制面
      └─ provider=go 时代理已登记 GO_API_ROUTES 到 Go API
            Go API / Workers
              ├─ 处理已迁移 API
              ├─ 可作为 pipeline consumer
              └─ 可作为 backup scheduler

共享状态
  SQLite + WAL      # 业务真相
  Redis             # 会话、访问资格、限流、设置版本、runtime lease
  对象存储           # Local / S3/COS / OpenList 的原图与派生媒体
```

这套结构的核心约束是：

- Node 仍是公网入口和稳定 fallback。
- Go 只能处理显式登记、已验收、且 readiness 通过的 route。
- SQLite、Redis、对象存储可以共享，但 migration、queue consumer、backup scheduler 这类副作用执行权必须单 owner。
- 管理后台切换 `system.backend.readProvider=go` 前，会先检查 Go 的 `/health/ready`，确认 database、Redis、媒体工具链都正常，避免半切换导致登录或列表不可用。

## 2. 技术架构

### 2.1 代码边界

```text
chronoframe/
├── app/                         # Nuxt 4 前端、页面、组件、composables、stores
├── backend/
│   ├── contracts/               # Node / Go 共享契约：routes、OpenAPI、schema、settings defaults
│   ├── nodejs/                  # Nitro serverDir：默认后端、网关、Node 服务
│   └── go/                      # 独立 Go module：API、worker、scheduler、storage adapters
├── deploy/dual/                 # 本地双栈 Compose、Caddy、Go owner 覆盖配置
├── docs/                        # VitePress 文档与 Wiki
├── packages/webgl-image/        # 本地 WebGL 图片查看/缩放能力包
└── scripts/                     # 契约生成、差分验证、双后端验收脚本
```

### 2.2 运行时组件

| 组件 | 责任 | 当前定位 |
| --- | --- | --- |
| Nuxt 4 前端 | 首页、相片/相簿页面、后台、访问密码页、访客上传页、多语言 | 用户可见 UI |
| Node.js / Nitro | SSR、默认 API、网关分流、DB migration、稳定 fallback、Node worker/scheduler | 默认 owner |
| Go API | 已迁移 API、媒体读取、设置/用户/照片/相簿/队列等能力、Go worker/scheduler | 可切换 owner |
| SQLite + WAL | 用户、照片、相簿、反应、上传分享、设置、任务队列 | 业务真相 |
| Redis | session、站点访问凭证、限流、设置版本、runtime lease、worker telemetry | 跨进程运行态 |
| 对象存储 | 原图、缩略图、展示图、Live Photo、视频播放文件 | Local / S3/COS / OpenList |
| 媒体工具链 | EXIF、缩略图、HEIC、MP4、Live/Motion Photo、分享图 | ExifTool / FFmpeg / Sharp/Vips / ImageMagick |
| GitHub Actions + GHCR | Node/Go 多架构镜像构建发布 | 部署供应链 |

### 2.3 请求分流

```text
request
  Node middleware 01.backend-dispatch
    match method + path in GO_API_ROUTES
      no  -> Node handles request
      yes -> read system.backend.readProvider directly enough for dispatch
        provider=node -> Node handles request
        provider=go   -> proxy to CFRAME_GO_UPSTREAM
```

关键文件：

- `backend/nodejs/middleware/01.backend-dispatch.ts`
- `backend/nodejs/utils/backend-routing.ts`
- `backend/go/internal/app/app.go`
- `backend/contracts/routes.yaml`

这次迁移收尾新增了切换保护：

```text
save backend.readProvider=go
  resolve CFRAME_GO_UPSTREAM
  GET /health/ready
  require:
    status == ready
    checks.database == ok
    checks.mediaTools == ok
    checks.redis == ok
  pass -> persist setting
  fail -> reject switch
```

单项设置接口和批量设置接口都会执行同一检查，避免 API 直调绕过 UI。

### 2.4 共享契约

`backend/contracts` 是 Node/Go 共存的中立权威层。

| 契约 | 作用 |
| --- | --- |
| `routes.yaml` | route id、method/path、owner、能力分组、鉴权类别、成熟度 |
| `openapi.yaml` | 对外 API 结构描述 |
| `schema.json` | SQLite schema、migration ledger、必需表/索引/trigger |
| `settings-defaults.json` | Go 侧 settings 默认值和 UI metadata 的生成来源 |

所有新增 Go 能力都应该先进入契约或验证脚本，再进入运行时切换。

### 2.5 数据与状态

```text
SQLite
  users
  photos
  albums / album_photos
  photo_reactions
  upload_shares
  settings / settings_storage_providers
  pipeline_queue

Redis
  cf_session / shared session
  site access entitlement
  rate limit windows
  settings version
  pipeline consumer runtime lease
  worker telemetry

Object storage
  users/<userId>/...
  original object
  display object
  thumbnail object
  live-photo video
  video playback object
```

SQLite 是最终业务真相；Redis 是运行时协作层；对象存储只保存媒体字节，不作为权限判断的唯一依据。

### 2.6 媒体处理链路

```text
upload prepare
  choose active storage provider
  generate isolated object key
  direct/object PUT
  create pipeline_queue task

pipeline consumer
  claim task with token fencing
  read original object
  parse EXIF / GPS / camera metadata
  generate thumb / display / video playback when needed
  reverse geocode when configured
  persist photo row and derived keys
```

当前支持：

- 图片：JPEG、PNG、HEIC 等；
- 视频：MP4，包含 HEVC 转码到可浏览器播放的 H.264 路径；
- Live Photo / Motion Photo；
- 缩略图、展示图、分享预览图；
- 地图与地球仪数据；
- 高德、MapLibre/Mapbox 等地图/位置配置。

### 2.7 部署形态

```text
生产推荐
  reverse proxy / host
    Node container: ghcr.io/swzyt/chronoframe:latest
    Go container: ghcr.io/swzyt/chronoframe-go:latest
    Redis
    /app/data mounted volume
    optional S3/COS/OpenList storage

本地双栈验证
  docker compose -f deploy/dual/compose.yaml up --build -d
```

GitHub Actions 的 `publish-images.yml` 会为 Node 和 Go 分别构建 amd64/arm64 镜像，并发布多架构 manifest。

## 3. 业务架构

### 3.1 角色与访问边界

| 角色 | 能力 |
| --- | --- |
| 匿名访客 | 可看公开内容；未通过访问密码时受预览数量限制；可使用有效访客上传链接上传 |
| 普通用户 | 登录后台；管理自己的相片和相簿；不能操作他人数据；只看到允许的菜单 |
| 管理员 | 全站管理；用户管理；设置；队列；日志；备份；所有相片/相簿 |
| 分享上传访客 | 通过 token 页面上传媒体；不获得后台身份 |

权限原则：

- 越权资源尽量返回 404，避免泄露资源存在性。
- 普通用户只能管理自己的照片、相簿、上传任务关联数据。
- 管理员角色变更由数据库实时确认，不依赖旧 session 中的角色缓存。
- 禁止停用/删除/降级自己或最后一个可用管理员。

### 3.2 公开访问与预览额度

```text
anonymous visits public site
  if access protection disabled
    allow full public content
  if access protection enabled and no valid signed cookie
    allow configured preview count
    require access password for more
  if password verified
    issue signed HttpOnly cookie
    allow full public content
```

后台可配置：

- 是否需要访问密码；
- 访问密码；
- 未验证时可见相片数量；
- 未验证时可见相簿数量。

### 3.3 照片业务

照片是核心业务实体，包含：

- 所有者 `ownerUserId`；
- 存储 key；
- EXIF、GPS、相机信息；
- 缩略图、展示图、分享图；
- 相簿关系；
- 反应数据；
- 隐藏/公开相关显示规则。

后台照片库支持：

- 管理员看全站，普通用户看自己；
- 上传、删除、编辑元数据；
- 批量设置相簿；
- 查看所属相簿；
- 检测重复内容；
- 触发 EXIF 重建；
- 通过分享上传链接收集访客媒体。

### 3.4 相簿业务

相簿负责组织照片：

- 可公开或隐藏；
- 有 owner；
- 有封面图；
- 后台列表展示隐藏状态和用户信息；
- 普通用户只能操作自己的相簿；
- 匿名未通过访问密码时，相簿内照片也受预览数量限制。

### 3.5 分享上传业务

```text
logged-in user
  create upload share
  copy token link
  send to visitor

visitor
  open /upload/:token
  select files
  prepare upload
  PUT object
  create processing task

system
  count quota atomically
  process task under share owner
  generated photo belongs to link creator
```

重点约束：

- token 不等于后台 session；
- 上传 quota 必须原子消费；
- 生成的照片归属创建链接的登录用户；
- 访客页面需要处理长文件名、多文件完成状态、复制链接等 UI 边界。

### 3.6 后台管理业务

管理员后台包括：

- 仪表盘；
- 照片管理；
- 相簿管理；
- 队列管理；
- 用户管理；
- 系统日志；
- 设置：站点、隐私、分析、地图、存储、系统、备份等。

普通用户后台只保留：

- 仪表盘；
- 照片；
- 相簿。

### 3.7 运维业务

运维能力包括：

- Docker 镜像发布；
- 本地/服务器容器部署；
- Go/Node provider 切换；
- Redis 健康与 session 恢复；
- 数据库备份到邮箱；
- 系统日志 SSE；
- 队列重试、清理和统计；
- 双后端差分验证脚本。

## 4. 当前 Go 迁移状态

当前系统不是“完全替换 Node”，而是“Node 默认稳定，Go 可按 route/actor 逐步接管”。

已迁移并进入 route registry 的能力包括：

- 访问密码；
- 用户管理；
- 身份登录/登出/session；
- 照片、相簿、反应；
- 上传准备和访客上传分享；
- 设置与存储配置；
- 队列控制；
- 系统统计、日志、备份；
- wizard 初始化；
- 媒体读取、展示图、缩略图、分享图；
- pipeline consumer 的图片、视频、Live Photo、反向地理编码等任务；
- backup scheduler。

仍需持续关注：

- 更大真实媒体 corpus 的 Node/Go 字节级差分；
- 托管云 S3/COS/CDN 与真实 OpenList 的网络边界；
- 大文件、断点、失败重试、磁盘满、kill -9、Redis 网络分区等故障注入；
- 深层业务错误分支继续补齐差分。

## 5. 关键工程原则

1. Node 是稳定入口，不因 Go 迁移破坏现有功能。
2. Go route 必须先登记、再验证、再可切换。
3. 共享数据不等于共享执行权。
4. 所有副作用 actor 必须单 owner。
5. 切换 Go 前必须 readiness 通过。
6. 验证脚本比口头确认更可信。
7. 文档、契约、代码和部署配置要同步更新。

## 6. Review 清单

本次文档基于以下代码事实整理：

- `backend/README.md`
- `backend/go/README.md`
- `backend/nodejs/utils/backend-routing.ts`
- `backend/nodejs/middleware/01.backend-dispatch.ts`
- `backend/go/internal/app/app.go`
- `backend/contracts/routes.yaml`
- `backend/contracts/schema.json`
- `deploy/dual/compose.yaml`
- `.github/workflows/publish-images.yml`
- `package.json`

生成的 archify 图通过：

- `validate architecture --quality showcase`
- `deliver architecture --quality showcase`
- `visual-check`：1440×900、1600×1000、1920×1080、2048×1320 均通过，无溢出，可读性通过。
