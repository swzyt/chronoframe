# Docker image publishing

This fork publishes Docker images to GitHub Container Registry automatically.

## Image

The default image is:

```text
ghcr.io/swzyt/chronoframe:latest
```

The publish workflow runs when code is pushed to `main`, when a tag such as
`v1.0.0` is pushed, or when the workflow is started manually from GitHub
Actions.

Generated tags include:

- `latest` for the default branch.
- The branch name, such as `main`.
- The git tag, such as `v1.0.0`.
- A commit tag such as `sha-abcdef0`.

Images are built for both `linux/amd64` and `linux/arm64`.

## Make the package public

After the first successful publish, open the package page in GitHub and set the
package visibility to public:

```text
Repository → Packages → chronoframe → Package settings → Change visibility → Public
```

This only needs to be done once. After that, servers can pull the image without
GitHub authentication.

## Server deployment

Use the repository `docker-compose.yml`:

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

Update the server after each publish:

```bash
docker compose pull
docker compose up -d
docker compose logs -f --tail=100 chronoframe
```

