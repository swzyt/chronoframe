# Request and job lifecycles

Interactive diagrams:

- [Public access and media authorization](/architecture/access-media.html)
- [Media upload and derivation data flow](/architecture/media-pipeline.html)
- [System architecture overview](/architecture/chronoframe-current.html)

## Backend dispatch

```text
request -> Node gateway
  route not registered for Go -> Node handler
  route registered -> read backend.readProvider
    node -> Node handler
    go -> proxy to CFRAME_GO_UPSTREAM
```

The gateway preserves method, body, cookies, relevant headers and request identity. Backend choice is never accepted from the browser.

## Public access and media

Logged-in users bypass the site access password. Anonymous visitors receive configured public preview quotas until a valid signed HttpOnly entitlement cookie is present. Photo lists, album contents, maps, the globe and album flow must all use the same visible-photo policy. Media endpoints authorize again, resolve private object keys on the server and support caching, conditional requests and Range delivery.

## Upload pipeline

An authenticated upload derives `ownerUserId` from the session. A visitor upload derives it from the validated share token. Upload preparation chooses the active storage provider, allocates a `users/<owner>/...` key and enqueues a durable task. The single Node or Go pipeline owner claims work with lease and token fencing, parses metadata, creates derivatives and commits the final photo row.

Duplicate detection uses content hashes within an owner scope; filenames are not photo identity.

## Share preview

`/share-og/:photoId.png` authorizes visibility, signs a short-lived `/og-media/:photoId` request, loads display/original media through that signed route and renders a cached PNG. Production should set a stable, dedicated `NUXT_OG_IMAGE_SECRET` shared by Node and Go.

## Backup

A manual or scheduled backup has one scheduler owner, creates a consistent SQLite artifact, stores it below `CFRAME_BACKUP_DIR` and optionally sends it through SMTP. It does not back up remote media objects.
