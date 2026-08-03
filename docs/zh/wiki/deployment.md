# 部署与升级

本文档说明如何把当前 fork 部署到服务器，并覆盖本地存储、S3/腾讯云 COS、OpenList、数据库、备份、反向代理和升级流程。

## 推荐部署方式

生产环境推荐使用 Docker 镜像：

```bash
docker run -d \
  --name chronoframe \
  --restart unless-stopped \
  -p 3000:3000 \
  -e NUXT_SESSION_PASSWORD="replace-with-a-random-secret-at-least-32-chars" \
  -e DATABASE_URL="/app/data/app.sqlite3" \
  -v chronoframe-data:/app/data \
  ghcr.io/swzyt/chronoframe:latest
```

首次启动后访问 `http://服务器地址:3000`，根据初始化向导创建管理员账号、配置站点名称、存储和地图。

## 必备环境变量

| 变量                           | 推荐值                  | 说明                                           |
| ------------------------------ | ----------------------- | ---------------------------------------------- |
| `NUXT_SESSION_PASSWORD`        | 至少 32 位随机字符串    | 用于签名登录会话和访问凭证，生产环境必须固定   |
| `DATABASE_URL`                 | `/app/data/app.sqlite3` | SQLite 数据库路径，Docker 中推荐放在持久化目录 |
| `NUXT_PROVIDER_LOCAL_PATH`     | `/app/data/storage`     | 本地存储目录                                   |
| `NUXT_PROVIDER_LOCAL_BASE_URL` | `/storage`              | 本地存储代理路径                               |
| `NODE_ENV`                     | `production`            | 生产运行模式                                   |

不要在每次部署时更换 `NUXT_SESSION_PASSWORD`。更换后，登录状态和访问密码 Cookie 都会失效。

## docker-compose 示例

```yaml
services:
  chronoframe:
    image: ghcr.io/swzyt/chronoframe:latest
    container_name: chronoframe
    restart: unless-stopped
    ports:
      - '3000:3000'
    environment:
      NUXT_SESSION_PASSWORD: 'replace-with-a-random-secret-at-least-32-chars'
      DATABASE_URL: '/app/data/app.sqlite3'
      NUXT_PROVIDER_LOCAL_PATH: '/app/data/storage'
      NUXT_PROVIDER_LOCAL_BASE_URL: '/storage'
    volumes:
      - ./data:/app/data
```

如果部署在公网域名后面，建议使用 Nginx、Caddy、Traefik 或云厂商负载均衡做 HTTPS 终止。

## 反向代理注意事项

ChronoFrame 需要正确识别 HTTPS 和原始访问地址。反向代理应转发这些头：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

上传大文件时还要增大代理限制：

```nginx
client_max_body_size 1024m;
proxy_read_timeout 300s;
proxy_send_timeout 300s;
```

## 数据持久化目录

生产环境至少需要持久化：

| 路径                    | 内容                         |
| ----------------------- | ---------------------------- |
| `/app/data/app.sqlite3` | SQLite 数据库                |
| `/app/data/storage`     | 本地存储文件                 |
| `/app/data/backups`     | 数据库备份                   |
| `/tmp` 或容器临时目录   | 视频转码、缩略图处理中间文件 |

如果容器日志中出现 `mkdtemp '/tmp/chronoframe-video-XXXXXX' ENOENT`，说明容器内临时目录不可用或镜像不是最新版本。请更新到最新镜像，并确认容器有可写 `/tmp`。

## 初始化流程

首次启动时，站点会进入初始化向导：

1. 创建第一个管理员。
2. 设置站点标题、标语和基础外观。
3. 选择存储提供器。
4. 配置地图和位置服务。
5. 完成初始化，进入后台。

第一个管理员非常重要。历史数据迁移、多用户权限和后台管理都依赖至少一个可用管理员。

## 升级流程

升级 Docker 镜像：

```bash
docker pull ghcr.io/swzyt/chronoframe:latest
docker stop chronoframe
docker rm chronoframe
docker run -d \
  --name chronoframe \
  --restart unless-stopped \
  -p 3000:3000 \
  -e NUXT_SESSION_PASSWORD="原来的密钥" \
  -e DATABASE_URL="/app/data/app.sqlite3" \
  -v chronoframe-data:/app/data \
  ghcr.io/swzyt/chronoframe:latest
```

如果你使用 docker-compose：

```bash
docker compose pull
docker compose up -d
```

升级前建议先手动触发一次数据库备份，或复制整个数据目录。

## 本地开发启动

```bash
pnpm install
pnpm dev
```

默认会启动 Nuxt 开发服务。若只想启动 Nuxt 而不重新构建本地图片查看包，可使用：

```bash
pnpm dev:only
```

## 公开镜像自动构建

当前项目可通过 GitHub Actions 在推送代码后构建 GHCR 镜像。镜像地址：

```text
ghcr.io/swzyt/chronoframe:latest
```

推荐保留：

- `latest`：主分支最新镜像。
- `sha-*`：按提交固定的不可变镜像。
- `semver tag`：正式发布版本。

服务器部署时，如果追求稳定，建议使用固定 tag 或 digest；如果方便测试新功能，可以使用 `latest`。
