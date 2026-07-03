# Celagem Hermes Dashboard deployment

Celagem runs Paperclip and the native Hermes dashboard side by side on the VPS.

## Runtime layout

- Paperclip app: public service on port `3100`.
- Hermes dashboard: private loopback service on `127.0.0.1:9119` inside the VPS host network.
- Shared Hermes home: Docker volume `paperclip-data` mounted at `/paperclip`, with Hermes state under `/paperclip/.hermes`.
- Static dashboard bundle: `./hermes-web_dist`, mounted read-only into the image at `/usr/local/lib/hermes-agent/hermes_cli/web_dist`.

## Deploy/update

```bash
cd /opt/paperclip
docker compose -f docker-compose.celagem.yml up -d --build
curl -fsS http://127.0.0.1:9119/api/status
curl -fsS http://127.0.0.1:3100/api/health
```

## Access from a workstation

Keep the dashboard private and use an SSH tunnel:

```bash
ssh -N -L 9120:127.0.0.1:9119 root@<celagem-vps>
open http://127.0.0.1:9120
```

Do **not** publish port `9119` to the internet unless Hermes dashboard password/OAuth auth is configured first.
