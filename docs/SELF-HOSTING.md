# Self-hosting the share server

`openloom-server` is a small Hono and SQLite service that delivers the full Open Loom share loop:
hosted watch pages, timestamped comments, emoji reactions, viewer analytics and password protection.
It is a single container with one data volume, and it is the provider to choose when you want more
than a static link.

A share link is only as credible as its domain. `http://203.0.113.4:3000/v/abc123` reads as a random
server; `https://videos.example.com/v/abc123` reads as real infrastructure. Point a domain at the box
and put a reverse proxy in front of it before sending a link to anyone outside your own machine. The
recommended setup, with Caddy, is below.

## Run it

### Docker Compose (recommended)

```bash
cd packages/server
echo "API_KEY=$(openssl rand -base64 24)" > .env
echo "BASE_URL=https://videos.example.com" >> .env
docker compose up -d
```

`API_KEY` is required: `docker-compose.yml` refuses to start without it, by design, so an upload
endpoint never ends up live without a key on record. Setting it this way, in a `.env` file Compose
reads automatically, means the key lives somewhere that can be checked again later (`cat .env`)
rather than only in scrolled-past terminal output. Keep it safe: it is what the desktop app uses to
upload and manage videos, and anonymous viewers never need it. `.env` is already covered by the
repo's `.gitignore`.

If the `.env` file is lost while the container is still running, the key is still readable from its
live environment:

```bash
docker compose exec openloom-server printenv API_KEY
```

`BASE_URL` here is the domain intended for this server. Compose already publishes the container on
port 3000 on the box itself, so `http://<box-ip>:3000` works the moment it starts. That bare-IP link
is exactly what the next section says not to share, so treat this command as step one, not the
finished setup.

To let the server generate its own key instead of choosing one, run the container directly rather
than through Compose. `docker-compose.yml` is what requires `API_KEY`; the server itself does not:

```bash
docker build -t openloom-server .
docker run -d --name openloom-server -p 3000:3000 -v openloom-data:/data openloom-server
docker logs openloom-server
docker exec openloom-server cat /data/api-key.txt
```

The generated key is printed once, in the logs, on first boot, and saved to `/data/api-key.txt`
inside the container so it can be read again later even if that first line was missed.

### From source, without Docker

```bash
cd packages/server
npm install
npm run build
API_KEY=$(openssl rand -base64 24) BASE_URL=https://videos.example.com node bin/openloom-server.js
```

This runs the same server outside a container, which is useful for development or a host without
Docker. There is no published `openloom-server` npm package to `npx`. `packages/server` is a
workspace package: built from source as above, or run as the Docker image above, and not published
anywhere else.

Leaving `API_KEY` unset here too makes the server generate one on first boot, print it once to the
console, and save it to `DATA_DIR/api-key.txt` (`./openloom-data/api-key.txt` by default), so a
missed line on screen is not the only copy:

```bash
node bin/openloom-server.js
cat openloom-data/api-key.txt
```

## Put a domain and HTTPS in front

This is the recommended setup, not an optional extra: it is what turns the server above into a link
worth sending someone.

1. **Point a subdomain at the box.** Create an A (or AAAA) record, for example `videos.example.com`,
   at the server's public IP. Open ports 80 and 443 to it; Caddy needs both to issue and renew a
   certificate.
2. **Put Caddy in front of the container.** Install Caddy on the same box and use this Caddyfile:

   ```
   videos.example.com {
       request_body {
           max_size 16MB
       }
       reverse_proxy localhost:3000
   }
   ```

   Caddy provisions and renews a Let's Encrypt certificate for the domain the first time it runs,
   with nothing else to configure for HTTPS. The `request_body` block caps every request the proxy
   will forward: the desktop app uploads in fixed 8 MB chunks, so 16 MB comfortably covers every real
   upload while rejecting an oversized one at the proxy, before it reaches the server process.
3. **Set `BASE_URL` to the HTTPS domain**, not the container's bare port (see the Docker Compose
   command above). Every share link is built from `BASE_URL`, which is what makes the minted link
   `https://videos.example.com/v/...` instead of `http://localhost:3000/v/...`.
4. **Set `TRUST_PROXY=true`** once Caddy (or nginx/Traefik) is in front. The server ignores
   `X-Forwarded-For` by default, so without a proxy every visitor looks like `localhost` and a
   client cannot forge the header to escape the per-IP rate limits (including the password
   brute-force lockout). Behind a proxy, `TRUST_PROXY=true` makes the limits key on each visitor's
   real IP again. Leave it unset for a directly-exposed server.
5. **Confirm it.** `https://videos.example.com/healthz` should return `{"ok":true}`.

nginx or Traefik work the same way if either is already running: terminate TLS at the proxy, forward
to `localhost:3000`, and cap the request body size there instead.

**Do not share a link that points at a bare IP or `localhost`.** It works locally, but it reads as
untrustworthy to anyone else, and it breaks the moment the IP changes or the machine goes offline. If
`BASE_URL` is not yet a domain someone else can resolve, treat the setup as unfinished.

## Configuration

All configuration is environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `DATA_DIR` | `./openloom-data` | Where SQLite and video files live. In Docker this is the `openloom-data` volume mounted at `/data` |
| `API_KEY` | generated on first boot and stored in `DATA_DIR`; required explicitly in Docker Compose (see above) | Creator authentication for the desktop app |
| `BASE_URL` | `http://localhost:3000` | Public origin used to build share and watch URLs. Set this to your HTTPS domain |
| `MAX_UPLOAD_MB` | `2048` | Reject uploads larger than this |
| `CREATOR_NAME` | empty | Optional name shown on watch pages |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For`/`X-Real-IP` for the client IP behind a reverse proxy. Leave `false` when the server is exposed directly, or a client can spoof the header and bypass per-IP rate limits |

Health check: `GET /healthz` returns 200 when the server is up.

## Backups

Everything the server stores, the SQLite database and the video files, lives under `DATA_DIR`, which
is the `openloom-data` Docker volume. Backing up the server is backing up that volume. To move to
another host, stop the container, copy the volume, and start it there with the same `API_KEY` and
`BASE_URL`.

## Connecting the app

In the desktop app, Settings, then Sharing, choose OpenLoom Server, enter the `BASE_URL` and the
`API_KEY`, and press Test. From then on, sharing a video uploads it here and the watch page carries
the full comment, reaction and analytics loop.
