# Deployment and Upgrades

Production deployments should use the public GHCR image:

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

Open `http://your-server:3000` after the first start and complete onboarding.

## Required environment variables

| Variable                       | Recommended value                         | Notes                                    |
| ------------------------------ | ----------------------------------------- | ---------------------------------------- |
| `NUXT_SESSION_PASSWORD`        | Random string with at least 32 characters | Used to sign sessions and access cookies |
| `DATABASE_URL`                 | `/app/data/app.sqlite3`                   | SQLite database path in Docker           |
| `NUXT_PROVIDER_LOCAL_PATH`     | `/app/data/storage`                       | Local media storage path                 |
| `NUXT_PROVIDER_LOCAL_BASE_URL` | `/storage`                                | Local media proxy base path              |

Keep `NUXT_SESSION_PASSWORD` stable across restarts. Changing it invalidates login sessions and public access cookies.

## docker-compose example

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

## Reverse proxy

When using Nginx or another reverse proxy, forward the original host and protocol:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
client_max_body_size 1024m;
```

## Upgrade

```bash
docker compose pull
docker compose up -d
```

Before upgrading, run or copy a database backup. After upgrading, verify admin login, anonymous preview, uploads, media loading, albums, and the globe page.
