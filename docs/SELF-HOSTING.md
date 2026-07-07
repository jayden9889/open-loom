# Self-hosting the share server

`openloom-server` is a small Hono and SQLite service that delivers the full Open Loom share loop:
hosted watch pages, timestamped comments, emoji reactions, viewer analytics and password protection.
It is a single container with one data volume, and it is the provider to choose when you want more
than a static link.

## Run it (two commands)

```bash
cd packages/server
API_KEY=$(openssl rand -base64 24) BASE_URL=https://videos.example.com docker compose up -d
```

The first command generates a creator API key; the second sets the public URL that share links are
built from. Keep the API key safe: it is what the desktop app uses to upload and manage videos.
Anonymous viewers never need it.

Without Docker, run it directly with Node 20 or newer:

```bash
cd packages/server
npm install
npm run build
API_KEY=your-key BASE_URL=https://videos.example.com npm start
```

Or from a published package, `npx openloom-server`.

## Configuration

All configuration is environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `DATA_DIR` | `./openloom-data` | Where SQLite and video files live. In Docker this is the `openloom-data` volume mounted at `/data` |
| `API_KEY` | generated on first boot and stored in `DATA_DIR` | Creator authentication for the desktop app |
| `BASE_URL` | `http://localhost:3000` | Public origin used to build share and watch URLs |
| `MAX_UPLOAD_MB` | `2048` | Reject uploads larger than this |
| `CREATOR_NAME` | empty | Optional name shown on watch pages |

Health check: `GET /healthz` returns 200 when the server is up.

## Behind a reverse proxy

Terminate TLS at a proxy (Caddy, nginx, Traefik) and forward to the container port. Set `BASE_URL` to
the public HTTPS origin so links are correct. A minimal Caddy example:

```
videos.example.com {
    reverse_proxy localhost:3000
}
```

Make sure the proxy allows request bodies at least as large as `MAX_UPLOAD_MB`, since uploads are
chunked PUTs through the proxy.

## Backups

Everything the server stores, the SQLite database and the video files, lives under `DATA_DIR`, which
is the `openloom-data` Docker volume. Backing up the server is backing up that volume. To move to
another host, stop the container, copy the volume, and start it there with the same `API_KEY` and
`BASE_URL`.

## Connecting the app

In the desktop app, Settings, then Sharing, choose OpenLoom Server, enter the `BASE_URL` and the
`API_KEY`, and press Test. From then on, sharing a video uploads it here and the watch page carries
the full comment, reaction and analytics loop.
