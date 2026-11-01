import http from 'http'
import https from 'https'
import { pipeline } from 'stream'

// Hop-by-hop headers apply to a single connection and must not be forwarded.
// transfer-encoding is handled separately: on requests Node needs it to frame the piped body,
// without it a chunked GET or DELETE body would reach the backend unframed.
const HOP_BY_HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'upgrade']

const withoutHeaders = (headers, names) => {
    const filtered = { ...headers }
    names.forEach((name) => delete filtered[name])
    return filtered
}

/**
 * Only origin-form ("/path") and asterisk-form targets are valid for a reverse proxy.
 * An absolute-form target ("GET http://other/") could make a backend route differently from the proxy.
 * @param {string} url - Request target
 * @returns {boolean} Whether the target can be forwarded
 */
const isForwardableTarget = (url) => url.startsWith('/') || url === '*'

/**
 * Serialize a response head for writing to a raw socket
 * @param {string} statusLine - Status line without line ending
 * @param {Array} rawHeaders - Flat [name, value, ...] list, keeps repeated headers such as Set-Cookie separate
 * @returns {string} Response head
 */
const formatHead = (statusLine, rawHeaders) => {
    const lines = [statusLine]
    for (let i = 0; i < rawHeaders.length; i += 2) {
        lines.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`)
    }
    return `${lines.join('\r\n')}\r\n\r\n`
}

/**
 * Multi-domain HTTP/HTTPS proxy servers
 * Routes requests based on Host header to configured backend servers
 * @param {Array} domains - Validated { from, to } entries
 * @param {Object} sslOptions - TLS key and certificate for the HTTPS server
 * @returns {Object} Servers that are not listening yet: { httpServer, httpsServer }
 */
export default (domains, sslOptions) => {
    // Parse domains config into a map for quick lookup
    const domainMap = new Map()
    domains.forEach(({ from, to }) => {
        const [toHost, toPort] = to.split(':')
        domainMap.set(from.toLowerCase(), {
            host: toHost,
            port: parseInt(toPort, 10),
        })
    })

    /**
     * Find target backend server based on request host header
     * @param {Object} req - HTTP request object
     * @param {boolean} isHttps - Whether the incoming request is HTTPS
     * @returns {Object|null} Target server config or null if not found
     */
    const findTarget = (req, isHttps) => {
        const host = req.headers.host?.toLowerCase()
        if (!host) return null

        // Try exact match first
        if (domainMap.has(host)) {
            return domainMap.get(host)
        }

        // Try with default ports, preferring the port of the listener that received the request
        const [hostname] = host.split(':')
        const httpsKey = `${hostname}:443`
        const httpKey = `${hostname}:80`

        return (isHttps ? domainMap.get(httpsKey) || domainMap.get(httpKey) : domainMap.get(httpKey) || domainMap.get(httpsKey)) || null
    }

    /**
     * Handle HTTP/HTTPS requests and proxy them to target servers
     * @param {Object} clientReq - Client request object
     * @param {Object} clientRes - Client response object
     * @param {boolean} isHttps - Whether the incoming request is HTTPS
     */
    const handleRequest = (clientReq, clientRes, isHttps = false) => {
        if (!isForwardableTarget(clientReq.url)) {
            clientRes.writeHead(400, { 'Content-Type': 'text/plain' })
            clientRes.end('Bad Request')
            return
        }

        const target = findTarget(clientReq, isHttps)

        if (!target) {
            global.logger.error(`No target found for host: ${isHttps ? 'https' : 'http'}://${clientReq.headers.host}:${isHttps ? 443 : 80}`)
            clientRes.writeHead(404, { 'Content-Type': 'text/plain' })
            clientRes.end('Domain not configured')
            return
        }

        const options = {
            hostname: target.host,
            port: target.port,
            path: clientReq.url,
            method: clientReq.method,
            headers: withoutHeaders(clientReq.headers, HOP_BY_HOP_HEADERS),
            rejectUnauthorized: false,
        }

        // Use HTTPS for proxy request if incoming request was HTTPS
        const requestModule = isHttps ? https : http
        const proxyReq = requestModule.request(options, (proxyRes) => {
            const headers = withoutHeaders(proxyRes.headers, [...HOP_BY_HOP_HEADERS, 'transfer-encoding'])
            // The rest of an unfinished request body will not be read once the response ends, so the connection can't serve another request
            if (!clientReq.complete) headers.connection = 'close'
            clientRes.writeHead(proxyRes.statusCode, headers)
            // Unlike pipe, pipeline destroys clientRes when the backend fails mid-response, so the client does not wait forever
            pipeline(proxyRes, clientRes, () => {})
        })

        proxyReq.on('error', (err) => {
            // The client is gone and proxyReq was destroyed on purpose
            if (clientRes.destroyed) return

            global.logger.error('Proxy error:', err)
            if (!clientRes.headersSent) {
                clientRes.writeHead(502, { 'Content-Type': 'text/plain' })
                clientRes.end('Bad Gateway')
            } else {
                clientRes.destroy()
            }
        })

        clientRes.on('close', () => proxyReq.destroy())

        clientReq.pipe(proxyReq, { end: true })
    }

    /**
     * Handle WebSocket upgrade requests
     * @param {Object} req - Upgrade request object
     * @param {Object} socket - Client socket
     * @param {Buffer} head - First packet of upgraded stream
     * @param {boolean} isHttps - Whether the incoming request is HTTPS
     */
    const handleUpgrade = (req, socket, head, isHttps = false) => {
        // The HTTP server no longer handles errors on an upgraded socket, a reset would reach uncaughtException
        socket.on('error', () => socket.destroy())

        // An upgraded socket has no server timeouts and allows half-open connections, so a client that ignores
        // our FIN or leaves before the upgrade completes would hold it forever. destroySoon closes both sides.
        const onClientEnd = () => socket.destroySoon()
        socket.on('end', onClientEnd)

        if (!isForwardableTarget(req.url)) {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            socket.destroySoon()
            return
        }

        // The request body is not forwarded here, a backend that ignores the upgrade would wait for it forever
        if (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding']) {
            socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            socket.destroySoon()
            return
        }

        const target = findTarget(req, isHttps)

        if (!target) {
            global.logger.error(`No target found for WebSocket upgrade: ${isHttps ? 'wss' : 'ws'}://${req.headers.host}:${isHttps ? 443 : 80}`)
            socket.destroySoon()
            return
        }

        const options = {
            hostname: target.host,
            port: target.port,
            path: req.url,
            method: req.method,
            headers: {
                ...withoutHeaders(req.headers, HOP_BY_HOP_HEADERS),
                connection: req.headers.connection,
                upgrade: req.headers.upgrade,
            },
            rejectUnauthorized: false,
        }

        // Use HTTPS for proxy request if incoming request was HTTPS
        const requestModule = isHttps ? https : http
        const proxyReq = requestModule.request(options)

        socket.on('close', () => proxyReq.destroy())

        proxyReq.on('upgrade', (res, targetSocket, targetHead) => {
            // From here on a client FIN is an ordinary half-close, the pipes below pass it to the backend
            socket.off('end', onClientEnd)

            targetSocket.on('error', () => targetSocket.destroy())
            targetSocket.on('close', () => socket.destroy())
            socket.on('close', () => targetSocket.destroy())

            socket.write(formatHead('HTTP/1.1 101 Switching Protocols', res.rawHeaders), 'latin1')

            // Bytes that arrived together with the handshake are not emitted by the sockets again
            if (targetHead.length) socket.write(targetHead)
            if (head.length) targetSocket.write(head)

            targetSocket.pipe(socket)
            socket.pipe(targetSocket)
        })

        // The backend declined the upgrade: relay its response, otherwise the client would wait forever
        proxyReq.on('response', (res) => {
            const hopByHop = [...HOP_BY_HOP_HEADERS, 'transfer-encoding']
            const rawHeaders = res.rawHeaders.flatMap((value, i, all) => {
                if (i % 2 === 1 || hopByHop.includes(value.toLowerCase())) return []
                return [value, all[i + 1]]
            })
            socket.write(formatHead(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`, [...rawHeaders, 'Connection', 'close']), 'latin1')
            pipeline(res, socket, () => socket.destroy())
        })

        proxyReq.on('error', (err) => {
            // The client is gone and proxyReq was destroyed on purpose
            if (socket.destroyed) return

            global.logger.error('WebSocket proxy error:', err)
            socket.destroySoon()
        })

        proxyReq.end()
    }

    // HTTP Server
    const httpServer = http.createServer((req, res) => {
        handleRequest(req, res, false)
    })

    httpServer.on('upgrade', (req, socket, head) => {
        handleUpgrade(req, socket, head, false)
    })

    // HTTPS Server
    const httpsServer = https.createServer(sslOptions, (req, res) => {
        handleRequest(req, res, true)
    })

    httpsServer.on('upgrade', (req, socket, head) => {
        handleUpgrade(req, socket, head, true)
    })

    return { httpServer, httpsServer }
}
