# Docker 镜像发布

这个 fork 会自动把 Docker 镜像发布到 GitHub Container Registry。

## 镜像地址

默认镜像是：

```text
ghcr.io/swzyt/chronoframe:latest
```

当代码推送到 `main`、推送 `v1.0.0` 这类 tag，或者手动从 GitHub Actions
触发工作流时，都会自动构建并推送镜像。

生成的 tag 包括：

- 默认分支的 `latest`。
- 分支名，例如 `main`。
- Git tag，例如 `v1.0.0`。
- 提交 tag，例如 `sha-abcdef0`。

镜像同时支持 `linux/amd64` 和 `linux/arm64`。

## 设置为公开镜像

第一次工作流成功推送后，需要到 GitHub 页面把 Package 设置为公开：

```text
仓库页面 → Packages → chronoframe → Package settings → Change visibility → Public
```

这个步骤通常只需要做一次。设置公开后，服务器就可以不登录 GitHub 直接拉取镜像。

## 服务器部署

可以直接使用仓库里的 `docker-compose.yml`：

```yaml
services:
  chronoframe:
    image: ghcr.io/swzyt/chronoframe:latest
    container_name: chronoframe
    restart: unless-stopped
    ports:
      - '3000:3000'
    volumes:
      - ./data:/app/data
    env_file:
      - .env
```

每次新镜像发布后，在服务器执行：

```bash
docker compose pull
docker compose up -d
docker compose logs -f --tail=100 chronoframe
```

