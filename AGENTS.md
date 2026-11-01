# Agent instructions

A small, standalone Host-based reverse proxy for HTTP, HTTPS and WebSocket traffic. Usage and configuration are in `README.md`, this file covers working on the code.

## Architecture

- `app/index.js`: entry point. Sets `global.config` and `global.logger`, registers the process error handlers, starts the proxy.
- `app/code/config.js`: parses and validates `DOMAINS` when imported, so importing it requires that variable to be set.
- `app/code/proxy.js`: all proxy behavior. Creates the servers without binding, which is what makes it testable.
- `app/code/index.js`: reads TLS files, binds ports 80 and 443, exits if a bind fails.
- `app/libs/`: logger and JSON config loader. `system/`: scripts behind the npm commands.

## Commands

```sh
npm ci          # dev tools only, there are no runtime dependencies
npm test        # node:test, high ports only, needs openssl
npm run lint    # ESLint and Prettier
```

The proxy itself needs ports 80 and 443 and valid certs, see the README. Run everything from the repository root.

## Conventions

- ES modules with explicit `.js` extensions in relative imports. No semicolons, 4 spaces, 150 columns. Prettier and ESLint are authoritative.
- Node built-ins only at runtime. Do not add a runtime dependency without approval.
- JSDoc on functions in the existing style. Comments explain why, not what.
- Code that runs in a request must not throw or leave a client waiting: every failure path ends in a response or a closed socket.

## Behavior to preserve

These look like mistakes or easy cleanups, but are deliberate:

- `rejectUnauthorized: false` on backend requests: backends commonly use self-signed certificates.
- `transfer-encoding` stays on forwarded requests: Node uses it to frame piped bodies. Removing it sends chunked `GET` and `DELETE` bodies unframed, which is a request smuggling risk. A test covers this.
- Only a fixed list of hop-by-hop headers is removed. Names listed in `Connection` are not, because that would let clients strip headers such as `Host`.
- `X-Forwarded-*` headers pass through unchanged. Changing this affects deployments behind a CDN, so it needs approval.
- Ports 80 and 443 are fixed, and the backend scheme follows the client's.
- The process error handlers log and keep the proxy running.

## Security constraints

- Backends come only from `DOMAINS`. Nothing in a request may select or influence the target address.
- Never commit or print `.env*` (except `.env.example`), `*.pem` or `app/logs/*`. These may be real on a working machine, so do not overwrite or delete them.
- Every variable in `.env.example` and the README must be read by the code.

## Making changes

- Keep changes small and targeted. Fix what was asked and report anything else you notice instead of changing it.
- Do not add features, refactors, config options, dependencies, Docker or CI without approval.
- Do not change existing behavior unless it is demonstrably wrong. Add a regression test for each bug fix in `test/`.
- Update `README.md` when user-visible behavior changes.

## Verifying changes

Before reporting work as done, run `npm test` and `npm run lint`, and exercise any changed command for real. Report what you ran and what you could not run.

## Approval required

Get explicit approval from the repository owner before any commit, push, tag, release, pull request, package publication or other external change. Installing or removing the systemd service also requires approval, because it changes the host.
