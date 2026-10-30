# Hosted Browser endpoint

Some of what Project Σ does needs a real browser: sites behind Cloudflare (JanitorAI and JannyAI among
them) challenge everything else, and the `cf_clearance` cookie that clears the challenge cannot be held
by a server-side request. Normally Project Σ starts one for itself on the machine it runs on, and every
feature that needs a browser shares it. When that machine cannot clear the challenge, or you want the
browser elsewhere, run one here and point Project Σ at it (**Settings → Online → Hosted Browser**,
and choose **Use my own browser endpoint**).

Both files here are reference implementations. Project Σ speaks plain CDP, so a bare
`chrome --remote-debugging-port`, browserless, or your own image work just as well.

## On a desktop

```bash
node run-browser.mjs
```

Node 22+, no dependencies. It finds a Chrome/Chromium/Edge, launches it, publishes a relay, and
prints the addresses to paste. Leave it running.

Env: `PORT` (the port to publish, 9222 by default), `BIND` (the interface, `0.0.0.0` by default;
`127.0.0.1` keeps it off the LAN), `PROFILE` (the profile folder, `.hosted-browser-profile` beside the
script by default), `BROWSER` (an explicit browser binary), `ADVERTISE_HOST` (the address printed as
the one to paste, for containers).

## In a container

`Dockerfile` plus `compose.yaml` run the same script in a Debian image. Assume you will adjust them
for your host; they are a starting point, not a turnkey stack.

```bash
ADVERTISE_HOST=<this host's LAN ip> docker compose up -d --build
```

The gotchas worth knowing before you debug them yourself:

- **`ADVERTISE_HOST`.** From inside the container the only visible address is its private one, which
  no LAN client can reach. Without this the log tells you to paste an address that cannot work.
- **Writable `HOME`.** A uid with no passwd entry gets `HOME=/`, chromium's crashpad dies trying to
  `mkdir` there, and the only symptom is `browser exited 1`.
- **seccomp.** The script keeps chromium's own sandbox (no `--no-sandbox`), which Docker's default
  seccomp profile blocks. Relaxing seccomp is the safer of the two ways to make it start.
- **`shm_size`.** The 64m default kills chromium in ways that look like a driver fault.
- **Codecs.** The browser test requires H.264 and AAC. Debian's `chromium` has them on arm64;
  Playwright's arm64 Chromium does not.
- **The profile is where the logins live.** Keep it on a volume writable by the uid you run as, or
  every redeploy signs the browser out and the failure reads like a Cloudflare problem.
- **GPU passthrough is optional**, and off by default. Software rendering can pass; press **Test**
  rather than assuming either way.

**Sign in once.** The browser starts signed out, and a signed-out endpoint fails in a way that reads
like a Cloudflare problem. Push a site's session into it from Settings, or sign in through it.

## Security

The published CDP port is **unauthenticated full control of a logged-in browser**. Anyone who reaches
it can read the sessions the browser holds and make it fetch anything that host can reach. The relay
drops any request carrying an `Origin` header, so a web page cannot touch it, but on a LAN the LAN is
the trust boundary. Never port-forward it.

Chrome has ignored `--remote-debugging-address` since M113 and always binds CDP to `127.0.0.1`, which
is why the relay exists at all: a published Docker port would otherwise reach nothing. Chrome also
rejects a `Host` header that is neither an IP nor `localhost`, so the relay rewrites it, and the
endpoint advertises its WebSocket as `ws://127.0.0.1:<port+1>/...`. Project Σ rewrites that
host to the endpoint you configured. That is expected, not broken; any hand-rolled client has to do
the same.
