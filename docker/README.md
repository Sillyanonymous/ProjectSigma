# Running Project Σ with Docker

An image and a compose file for running Project Σ in a container. From the repository root:

```bash
docker compose -f docker/compose.yaml up -d
```

Then open `http://<this machine>:7788`. The first start builds the image, which takes a minute or two.

## Where things live

| Volume | Holds |
|---|---|
| `sigma-data` (`/data`) | Every library, the settings, the accounts and the scheduled backups |
| `sigma-extensions` (`/extensions`) | Extensions you install from a git URL or a zip |

Both survive rebuilds and updates. To back them up, copy the volumes, or use the app's own backups (they land in the
data volume). `docker compose -f docker/compose.yaml down` stops the app and keeps the volumes; `down -v` deletes them.

## Updating

Pull the new version of the repository, then rebuild:

```bash
docker compose -f docker/compose.yaml up -d --build
```

The libraries upgrade themselves on the first start.

## Settings

The server's settings (`server.yaml`) are written into the data volume on the first start. The usual way to change one
is an environment variable in `compose.yaml`; the README's configuration table lists them (`CL_MULTI_USER`, `CL_CORS`,
`CL_HOSTS` and the rest). `CL_PORT`, `CL_HOST`, `CL_DATA_DIR` and `CL_EXTENSIONS_DIR` are set by the image; change
the published port in `ports:` instead.

## Bringing a SillyTavern library across

Mount the SillyTavern user folder read-only (the commented line under `volumes:` in `compose.yaml`), restart, and give
the wizard (**Settings** > **Account** > **Bring your SillyTavern library**) the path `/sillytavern`. The terminal tool
works too:

```bash
docker compose -f docker/compose.yaml exec sigma npm run migrate -- /sillytavern --user <handle> --dry-run
```

Checking a library: `docker compose -f docker/compose.yaml exec sigma npm run verify`.

## The Hosted Browser

JanitorAI and JannyAI sit behind Cloudflare, which only a real browser gets past. The image has no browser of its own,
so **Run one for me** does not work inside it. Start the optional browser beside the app instead:

```bash
docker compose -f docker/compose.yaml --profile browser up -d
```

Then set **Settings** > **Online** > **Hosted Browser** to **Use my own browser endpoint**, with the endpoint
`http://browser:9222`, and press the test button. The browser is reachable only by the app, over the compose network.
Whether a site lets a browser without a graphics card through varies from host to host; if it will not, run the
browser on a desktop instead (see `tools/hosted-browser/`).

## Notes

- The image is built for amd64 and arm64; other platforms would need a compiler for the database driver.
- The server runs as the image's `node` user (uid 1000). A bind mount in place of a volume must be writable by it.
