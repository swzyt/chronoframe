# 开发者参考

本文为二次开发和维护当前 fork 的速查文档。

## 技术栈

| 层     | 技术                                        |
| ------ | ------------------------------------------- |
| 前端   | Nuxt 4、Vue 3、Nuxt UI、Tailwind CSS、Pinia |
| 后端   | Nuxt Server Routes、SQLite、Drizzle ORM     |
| 媒体   | Sharp、ExifTool、FFmpeg/FFprobe、HEIC 转换  |
| 地图   | Mapbox、MapLibre、高德地图                  |
| 存储   | 本地文件、S3 兼容存储、OpenList             |
| 文档   | VitePress                                   |
| 包管理 | pnpm workspace                              |

## 常用命令

```bash
pnpm install
pnpm dev
pnpm lint
pnpm fmt:check
pnpm build
pnpm docs:build
pnpm db:check
pnpm db:generate
pnpm db:migrate
```

## 目录速览

| 路径                    | 说明                              |
| ----------------------- | --------------------------------- |
| `app/`                  | Nuxt 应用页面、组件、composables  |
| `server/`               | API、数据库、存储、队列、媒体处理 |
| `packages/webgl-image/` | 自研 WebGL 图片查看组件           |
| `docs/`                 | VitePress 文档                    |
| `drizzle/`              | 数据库迁移                        |
| `.github/workflows/`    | CI 和镜像构建                     |

## 权限开发原则

新增接口或页面时必须先回答三个问题：

1. 匿名访客是否允许访问？
2. 普通用户是否只能访问自己的数据？
3. 管理员是否可以访问全站数据？

后台接口默认应要求登录。涉及系统设置、队列、日志、用户管理的接口必须要求管理员。

资源越权访问建议返回 404，而不是暴露 403，以避免泄露资源存在性。

## 数据归属

照片、相簿和异步任务都应有 `ownerUserId`。新增数据时必须从当前登录用户继承归属。

普通用户查询时需要附加 `ownerUserId = currentUser.id` 条件。管理员查询时可以不加所有者限制。

公开查询应只返回非隐藏、可公开的内容，并叠加访问密码预览限制。

## 公开访问密码开发原则

访问密码不是前端本地判断，而是服务端校验。

实现相关功能时需要保证：

- 登录用户绕过访问密码。
- 匿名访客未验证时只能访问预览范围。
- API、页面和媒体代理使用同一套判断。
- 验证成功后使用签名 HttpOnly Cookie。
- Cookie 中携带密码版本，密码变更后旧凭证失效。
- 失败尝试需要限流。

## 媒体开发原则

不要把底层存储 Key、S3 直链、OpenList 直链直接暴露给客户端作为最终访问地址。客户端应访问应用提供的代理路由。

媒体代理需要支持：

- 鉴权。
- 缓存头。
- 条件请求。
- Range 请求。
- 缩略图和原图。
- 视频播放资源。
- Live Photo 资源。

## 新增设置项

新增设置项时请同步处理：

1. 数据库默认值或迁移。
2. 服务端 schema。
3. 后台设置页面。
4. i18n 文案。
5. 文档。
6. 如果影响公开访问，补充匿名/登录/管理员三类验收。

可参考[新增设置项指南](/development/how-to-add-setting)。

## 多语言要求

新增 UI 文案必须同步中英文。测试时如果页面出现类似 `settings.location.provider.options.auto`、`common.owner admin` 这样的原始 key，说明多语言缺失或调用路径不对，需要补齐 locale 文件。

## 建议验收清单

功能变更完成后至少检查：

- `pnpm lint`
- `pnpm fmt:check`
- `pnpm build`
- `pnpm docs:build`
- 管理员登录。
- 普通用户登录。
- 匿名访问。
- 访问密码预览限制。
- 上传图片。
- 上传 MP4/MOV。
- S3/COS 或本地存储读取。
- 地图和地球仪。
- 移动端图片缩放、旋转和全屏。
