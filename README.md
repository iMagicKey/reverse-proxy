# reverse-proxy

A small Node.js reverse proxy that routes HTTP, HTTPS and WebSocket traffic to backends by the request's `Host` header. It has no runtime dependencies and is configured with one environment variable.

It is a standalone service that you clone and run. It is not an npm package or a library.

## Use cases and limitations

Use it to put several services on one machine behind ports 80 and 443, when you want something small enough to read in one sitting.

- **Fixed ports.** It always listens on 80 and 443, and both listeners always start. TLS files are required even if you only use HTTP.
- **One certificate.** All HTTPS traffic gets the same certificate, there is no per-domain selection (SNI). For browsers, use a certificate that covers all your domains, or a CDN that accepts your certificate.
- **The backend scheme follows the client's.** Requests received over HTTP reach the backend over HTTP, requests received over HTTPS reach it over HTTPS. A backend needs TLS for HTTPS routes to work.
- **Exact hostnames only.** There is no wildcard or path-based routing, and IPv6 addresses are not supported in routes.
- **HTTP/1.1 only.** HTTP/2 is not supported on either side.
- **Not included:** certificate automation, HTTP-to-HTTPS redirects, load balancing, caching, access control, rate limiting and backend timeouts.

## Requirements

- Node.js 20.6 or newer
- Permission to bind ports 80 and 443 (root or `CAP_NET_BIND_SERVICE`)
- Linux with `openssl` and `ip` for `npm run create-certs`, and systemd for `npm run install-service`

## Quick start

Run all commands from the repository root, because paths are resolved against the working directory.

```sh
git clone https://github.com/iMagicKey/reverse-proxy.git
cd reverse-proxy
npm run init            # installs dev tools, creates app/logs, app/config/dev, .env and .env.dev
npm run create-certs    # creates a self-signed certificate in app/config/live/certs
```

Start the two example backends, each in its own terminal:

```sh
node examples/echo-backend.js 3000
node examples/echo-backend.js 3443 app/config/live/certs
```

Start the proxy with the example routes:

```sh
sudo node --env-file=examples/echo.env app/index.js
```

Then check that it works. `-k` is needed because the certificate is self-signed.

```sh
curl -H 'Host: app.example.test' http://127.0.0.1/         # JSON from the backend on port 3000
curl -k -H 'Host: app.example.test' https://127.0.0.1/     # JSON from the backend on port 3443
curl -i -H 'Host: unknown.test' http://127.0.0.1/          # 404 Domain not configured
```

To run your own routes, edit `.env` and start the proxy with `sudo npm run live`.

## Configuration

Environment variables are read from `.env` by `npm run live` and from `.env.dev` by `npm run dev`. See [`.env.example`](.env.example).

| Variable  | Required | Description                                                                                                                           |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV` | Yes      | Directory under `app/config/` to use: `live` or `dev`.                                                                                |
| `DOMAINS` | Yes      | JSON array of `{ "from": "host:port", "to": "host:port" }` routes. Use `[]` for none. The proxy refuses to start on an invalid value. |

```sh
DOMAINS='[{"from":"example.com:80","to":"127.0.0.1:3000"},{"from":"example.com:443","to":"127.0.0.1:3443"}]'
```

A request's `Host` header is matched case-insensitively, in this order:

1. The exact `host:port` from the header.
2. `host:<port of the listener>`, so `:80` for HTTP and `:443` for HTTPS.
3. `host:<the other standard port>`.

Requests that match nothing get a 404. Because of step 3, an HTTP request can use a route that only defines `:443`, and it then reaches the backend over plain HTTP. If that backend only speaks TLS, the client gets a 502.

Files under `app/config/<APP_ENV>/`:

| File             | Required | Description                                                                                                                      |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `certs/key.pem`  | Yes      | TLS private key.                                                                                                                 |
| `certs/cert.pem` | Yes      | TLS certificate. Replace the self-signed one with your own for browser traffic.                                                  |
| `logger.json`    | No       | `{ "output": ["console", "file"] }`. Console only if the file is missing. `app/config/live/logger.json` enables both by default. |

File output goes to `app/logs/<level>.log`.

## Commands

| Command                               | Description                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run live`                        | Start with `.env`.                                                                               |
| `npm run dev`                         | Start with `.env.dev`. Uses the same ports as `live`.                                            |
| `npm run init`                        | Install dev tools and create missing directories and env files. Existing files are kept.         |
| `npm run create-certs [-- dev]`       | Create a self-signed certificate for `live` or `dev`. Existing certificates are not overwritten. |
| `npm run install-service [-- dev]`    | As root: install, enable and start a systemd service named after the repository directory.       |
| `npm run uninstall-service`           | As root: stop and remove the service and delete its `service-*.log` files.                       |
| `npm run clear-logs [-- <level> ...]` | Empty log files, for example `-- error crit`. Without arguments, all levels except `service-*`.  |
| `npm test`                            | Run the tests. Uses high ports only, needs `openssl`.                                            |
| `npm run lint`                        | Run ESLint and Prettier.                                                                         |

## Security considerations

- **Not an open proxy.** Traffic only goes to backends listed in `DOMAINS`, and `Host` cannot select anything else. `CONNECT` and absolute-form targets such as `GET http://other/` are refused.
- **Backend certificates are not verified.** Connections to HTTPS backends use `rejectUnauthorized: false`, so self-signed backends work. Keep backends on loopback or a trusted private network.
- **`X-Forwarded-*` headers are not set or sanitized.** Whatever the client sends reaches the backend unchanged, and the backend sees the proxy as its peer. Backends must not trust these headers for client IPs or for security decisions.
- **Backends must be firewalled.** The proxy adds no authentication, and a backend reachable directly bypasses it.
- **The service runs as root.** The generated systemd unit has no `User=`. Consider running as an unprivileged user with `CAP_NET_BIND_SERVICE`.
- **Logs grow without limit.** Each request for an unknown host adds a line, with content controlled by the client, so scanners can fill a disk. The systemd unit also captures console output, so each line is stored twice. Set up rotation such as `logrotate`, or remove `file` from `logger.json`.
- **Secrets stay local.** `.env` files, `*.pem` files and logs are ignored by Git. Do not commit them.

## Project layout

```text
app/index.js          Entry point: loads config and logger, starts the proxy
app/code/config.js    Parses and validates DOMAINS
app/code/proxy.js     Routing, request forwarding and WebSocket upgrades
app/code/index.js     Reads TLS files and binds ports 80 and 443
app/libs/             Logger and JSON config loader
system/               Scripts behind the npm commands
examples/             Example backend and routes
test/                 Tests (node:test)
```

## License

[MIT](LICENSE)
