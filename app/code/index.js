import http from 'http'
import https from 'https'
import fs from 'fs'
import { resolve } from 'path'
import { DOMAINS } from './config'

/**
 * Multi-domain HTTP/HTTPS proxy server
 * Routes requests based on Host header to configured backend servers
 */
export default async () => {
    const sslOptions = {
        key: fs.readFileSync(resolve(`app/config/${process.env.APP_ENV}/certs/key.pem`)),
        cert: fs.readFileSync(resolve(`app/config/${process.env.APP_ENV}/certs/cert.pem`)),
    }

    // Parse domains config into a map for quick lookup
    const domainMap = new Map()
    DOMAINS.forEach(({ from, to }) => {
        const [fromHost, fromPort] = from.split(':')
        const [toHost, toPort] = to.split(':')
        domainMap.set(`${fromHost}:${fromPort}`, {
            host: toHost,
            port: parseInt(toPort, 10),
        })
    })

    /**
     * Find target backend server based on request host header
     * @param {Object} req - HTTP request object
     * @returns {Object|null} Target server config or null if not found
     */
    const findTarget = (req) => {
        const { host } = req.headers
        if (!host) return null

        // Try exact match first
        if (domainMap.has(host)) {
            return domainMap.get(host)
        }

        // Try with default ports
        const [hostname] = host.split(':')
        const httpsKey = `${hostname}:443`
        const httpKey = `${hostname}:80`

        return domainMap.get(httpsKey) || domainMap.get(httpKey) || null
    }

    /**
     * Handle HTTP/HTTPS requests and proxy them to target servers
     * @param {Object} clientReq - Client request object
     * @param {Object} clientRes - Client response object
     * @param {boolean} isHttps - Whether the incoming request is HTTPS
     */
    const handleRequest = (clientReq, clientRes, isHttps = false) => {
        const target = findTarget(clientReq)

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
            headers: clientReq.headers,
            rejectUnauthorized: false,
        }

        // Use HTTPS for proxy request if incoming request was HTTPS
        const requestModule = isHttps ? https : http
        const proxyReq = requestModule.request(options, (proxyRes) => {
            clientRes.writeHead(proxyRes.statusCode, proxyRes.headers)
            proxyRes.pipe(clientRes, { end: true })
        })

        proxyReq.on('error', (err) => {
            global.logger.error('Proxy error:', err)
            if (!clientRes.headersSent) {
                clientRes.writeHead(502, { 'Content-Type': 'text/plain' })
                clientRes.end('Bad Gateway')
            }
        })

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
        const target = findTarget(req)

        if (!target) {
            global.logger.error(`No target found for WebSocket upgrade: ${isHttps ? 'wss' : 'ws'}://${req.headers.host}:${isHttps ? 443 : 80}`)
            socket.end()
            return
        }

        const options = {
            hostname: target.host,
            port: target.port,
            path: req.url,
            headers: req.headers,
            rejectUnauthorized: false,
        }

        // Use HTTPS for proxy request if incoming request was HTTPS
        const requestModule = isHttps ? https : http
        const proxyReq = requestModule.request(options)

        proxyReq.on('upgrade', (res, targetSocket) => {
            socket.write('HTTP/1.1 101 Switching Protocols\r\n')
            Object.entries(res.headers).forEach(([key, value]) => {
                socket.write(`${key}: ${value}\r\n`)
            })
            socket.write('\r\n')
            targetSocket.pipe(socket)
            socket.pipe(targetSocket)
        })

        proxyReq.on('error', (err) => {
            global.logger.error('WebSocket proxy error:', err)
            socket.end()
        })

        proxyReq.end()
    }

    global.logger.log('Configured domains:', DOMAINS)

    // HTTP Server (port 80)
    const httpServer = http.createServer((req, res) => {
        handleRequest(req, res, false)
    })

    httpServer.on('upgrade', (req, socket, head) => {
        handleUpgrade(req, socket, head, false)
    })

    httpServer.on('error', (err) => {
        global.logger.error('HTTP server error:', err)
    })

    httpServer.listen(80, () => {
        global.logger.log('HTTP proxy server listening on port 80')
    })

    // HTTPS Server (port 443)
    const httpsServer = https.createServer(sslOptions, (req, res) => {
        handleRequest(req, res, true)
    })

    httpsServer.on('upgrade', (req, socket, head) => {
        handleUpgrade(req, socket, head, true)
    })

    httpsServer.on('error', (err) => {
        global.logger.error('HTTPS server error:', err)
    })

    httpsServer.listen(443, () => {
        global.logger.log('HTTPS proxy server listening on port 443')
    })
}
