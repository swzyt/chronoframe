FROM golang:1.27.1-alpine AS build

WORKDIR /src/backend/go
ENV PATH=/usr/local/go/bin:$PATH
RUN apk add --no-cache gcc musl-dev
COPY backend/go/go.mod backend/go/go.sum ./
ENV GOPROXY=https://goproxy.cn,direct \
    GOSUMDB=off
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY backend/go ./
COPY backend/contracts /src/backend/contracts
RUN --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=1 go build -trimpath -ldflags="-s -w" -o /out/chronoframe-go ./cmd/api

FROM build AS test
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go test ./... \
    && go vet ./...

FROM alpine:3.23.3 AS runtime
RUN apk add --no-cache ca-certificates exiftool ffmpeg font-noto font-noto-cjk imagemagick imagemagick-heic rsvg-convert tzdata vips-tools \
    && addgroup -S -g 10001 chronoframe \
    && adduser -S -D -H -u 10001 -G chronoframe chronoframe

WORKDIR /app
COPY --from=build /out/chronoframe-go /usr/local/bin/chronoframe-go

USER 10001:10001
EXPOSE 8080
ENV CFRAME_GO_ADDR=:8080 \
    CFRAME_BACKEND_VERSION=dev \
    CFRAME_GO_MATURITY=experimental \
    CFRAME_GO_MODE=sandbox \
    CFRAME_DB_MIGRATOR=none \
    CFRAME_GO_MIGRATE_ONLY=false \
    CFRAME_PIPELINE_CONSUMER=none \
    CFRAME_BACKUP_SCHEDULER=none \
    DATABASE_URL=/app/data/app.sqlite3

ENTRYPOINT ["/usr/local/bin/chronoframe-go"]
