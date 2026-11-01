import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import tls from 'node:tls'
import createProxyServers from '../app/code/proxy.js'

const listen = async (server) => {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    // Early Node 20 releases only run a root-level after hook once nothing keeps the event loop alive
    server.unref()
    return server.address().port
}

const waitFor = async (condition) => {
    for (let i = 0; i < 100; i += 1) {
        if (condition()) return
        // eslint-disable-next-line no-await-in-loop
        await new Promise((done) => {
            setTimeout(done, 20)
        })
    }
    assert.fail('condition was not met in time')
}

let ports
let servers
const backendClosed = { slow: 0, upgraded: 0 }
let unansweredUpgrades = 0
const openSockets = new Set()
const uncaught = []
const onUncaught = (err) => uncaught.push(err)

const backendHandler = (name) => (req, res) => {
    if (req.url === '/die-mid-response') {
        res.writeHead(200, { 'content-length': '100' })
        res.write('partial')
        setTimeout(() => req.socket.destroy(), 20)
        return
    }
    if (req.url === '/slow') {
        res.on('close', () => {
            backendClosed.slow += 1
        })
        return
    }
    if (req.url === '/early') {
        res.writeHead(401, { 'content-length': '0' })
        res.end()
        return
    }
    if (req.url === '/streamed') {
        res.write('a')
        res.end('b')
        return
    }
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
        res.setHeader('set-cookie', ['a=1', 'b=2'])
        res.end(JSON.stringify({ backend: name, method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }))
    })
}

const backendUpgradeHandler = (req, socket, head) => {
    socket.on('error', () => {})
    if (req.url === '/half-close') {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
        socket.on('end', () => socket.end('BYE'))
        socket.resume()
        return
    }
    // The HTTP server allows half-open sockets, so a FIN from the proxy does not close this side by itself
    socket.on('end', () => socket.destroy())
    socket.on('close', () => {
        backendClosed.upgraded += 1
    })
    if (req.url === '/never') {
        unansweredUpgrades += 1
        return
    }
    if (req.url === '/rejected') {
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope')
        return
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\nFIRST`)
    if (head.length) socket.write(`[${head}]`)
    socket.on('data', (data) => socket.write(`[${data}]`))
}

before(async () => {
    const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reverse-proxy-test-'))
    const opensslArgs = [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-x509',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-keyout',
        'key.pem',
        '-out',
        'cert.pem',
    ]
    execFileSync('openssl', opensslArgs, { cwd: certDir, stdio: 'ignore' })
    const sslOptions = { key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) }
    fs.rmSync(certDir, { recursive: true })

    global.logger = { log() {}, error() {}, crit() {} }
    process.on('uncaughtException', onUncaught)

    const httpBackend = http.createServer(backendHandler('http'))
    const httpsBackend = https.createServer(sslOptions, backendHandler('https'))
    httpBackend.on('upgrade', backendUpgradeHandler)
    httpsBackend.on('upgrade', backendUpgradeHandler)
    const httpBackendPort = await listen(httpBackend)
    const httpsBackendPort = await listen(httpsBackend)

    // Reserve a port nothing listens on
    const unused = net.createServer()
    const unusedPort = await listen(unused)
    unused.close()

    const { httpServer, httpsServer } = createProxyServers(
        [
            { from: 'both.test:80', to: `127.0.0.1:${httpBackendPort}` },
            { from: 'both.test:443', to: `127.0.0.1:${httpsBackendPort}` },
            { from: 'Mixed.Test:80', to: `127.0.0.1:${httpBackendPort}` },
            { from: 'down.test:80', to: `127.0.0.1:${unusedPort}` },
        ],
        sslOptions
    )
    ports = { http: await listen(httpServer), https: await listen(httpsServer) }
    servers = [httpBackend, httpsBackend, httpServer, httpsServer]
    servers.forEach((server) => {
        server.on('connection', (socket) => {
            openSockets.add(socket)
            socket.on('close', () => openSockets.delete(socket))
        })
    })
})

after(() => {
    process.off('uncaughtException', onUncaught)
    servers.forEach((server) => server.close())
    // Upgraded sockets are not tracked by the servers, a leftover one would keep the test process alive
    openSockets.forEach((socket) => socket.destroy())
})

/**
 * Open a raw connection, so tests control the exact bytes and can observe hangs
 */
const connect = async (text, { secure = false, allowHalfOpen = false } = {}) => {
    const socket = secure
        ? tls.connect({ port: ports.https, host: '127.0.0.1', rejectUnauthorized: false, servername: 'localhost' })
        : net.connect({ port: ports.http, host: '127.0.0.1', allowHalfOpen })
    const connection = { socket, output: '', ended: false, closed: false }
    socket.on('data', (data) => {
        connection.output += data
    })
    socket.on('end', () => {
        connection.ended = true
    })
    socket.on('error', () => {})
    socket.on('close', () => {
        connection.closed = true
    })
    await once(socket, secure ? 'secureConnect' : 'connect')
    connection.localPort = socket.localPort
    socket.write(text)
    return connection
}

const request = async (text, options) => {
    const connection = await connect(text, options)
    await waitFor(() => connection.closed)
    const [head, ...body] = connection.output.split('\r\n\r\n')
    return { head, status: Number(head.split(' ')[1]), body: body.join('\r\n\r\n') }
}

const get = (host, options) => request(`GET /path?q=1 HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`, options)

const upgrade = (urlPath, extra = '') => `GET ${urlPath} HTTP/1.1\r\nHost: both.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n${extra}`

test('routes by the port of the listener when Host has no port', async () => {
    const overHttp = await get('both.test')
    assert.equal(JSON.parse(overHttp.body).backend, 'http')
    const overHttps = await get('both.test', { secure: true })
    assert.equal(JSON.parse(overHttps.body).backend, 'https')
})

test('matches hostnames case-insensitively', async () => {
    assert.equal((await get('MIXED.test')).status, 200)
    assert.equal((await get('both.TEST:80')).status, 200)
})

test('forwards method, path, body and repeated response headers', async () => {
    const response = await request('POST /submit?x=1 HTTP/1.1\r\nHost: both.test\r\nConnection: close\r\nContent-Length: 5\r\n\r\nhello')
    const { method, url, body, headers } = JSON.parse(response.body)
    assert.deepEqual([method, url, body, headers.host], ['POST', '/submit?x=1', 'hello', 'both.test'])
    assert.equal(response.head.match(/set-cookie:/gi).length, 2)
})

test('keeps chunked bodies framed for methods that are not chunked by default', async () => {
    const chunked = 'DELETE /item HTTP/1.1\r\nHost: both.test\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n'
    const response = await request(chunked)
    assert.equal(JSON.parse(response.body).body, 'hello')
})

test('does not forward hop-by-hop headers', async () => {
    const headers = 'Proxy-Authorization: Basic c2VjcmV0\r\nKeep-Alive: timeout=9\r\nTE: trailers\r\nX-Custom: kept\r\n'
    const response = await request(`GET / HTTP/1.1\r\nHost: both.test\r\nConnection: close\r\n${headers}\r\n`)
    const received = JSON.parse(response.body).headers
    assert.equal(received['proxy-authorization'], undefined)
    assert.equal(received['keep-alive'], undefined)
    assert.equal(received.te, undefined)
    assert.equal(received['x-custom'], 'kept')
})

test('does not send chunked framing to an HTTP/1.0 client', async () => {
    const response = await request('GET /streamed HTTP/1.0\r\nHost: both.test\r\n\r\n')
    assert.doesNotMatch(response.head, /transfer-encoding/i)
    assert.equal(response.body, 'ab')
})

test('is not an open proxy', async () => {
    assert.equal((await get('unknown.test')).status, 404)

    const absolute = await request('GET http://other.test/admin HTTP/1.1\r\nHost: both.test\r\nConnection: close\r\n\r\n')
    assert.equal(absolute.status, 400)

    const connectMethod = await connect('CONNECT other.test:443 HTTP/1.1\r\nHost: other.test:443\r\n\r\n')
    await waitFor(() => connectMethod.closed)
    assert.equal(connectMethod.output, '')
})

test('responds 502 when the backend is unreachable', async () => {
    assert.equal((await get('down.test')).status, 502)
})

test('closes the client connection when the backend dies mid-response', async () => {
    const response = await request('GET /die-mid-response HTTP/1.1\r\nHost: both.test\r\n\r\n')
    assert.equal(response.status, 200)
    assert.equal(response.body, 'partial')
})

test('aborts the backend request when the client disconnects', async () => {
    const closedBefore = backendClosed.slow
    const connection = await connect('GET /slow HTTP/1.1\r\nHost: both.test\r\n\r\n')
    await new Promise((done) => {
        setTimeout(done, 50)
    })
    connection.socket.destroy()
    await waitFor(() => backendClosed.slow > closedBefore)
})

const testUpgradeRelay = (secure) => {
    test(`relays an upgraded connection in both directions (secure: ${secure})`, async () => {
        const connection = await connect(upgrade('/socket', 'EARLY'), { secure })
        await waitFor(() => connection.output.includes('FIRST') && connection.output.includes('[EARLY]'))
        assert.match(connection.output, /^HTTP\/1\.1 101 /)
        assert.match(connection.output, /Set-Cookie: a=1\r\nSet-Cookie: b=2\r\n/)

        connection.socket.write('LATER')
        await waitFor(() => connection.output.includes('[LATER]'))
        connection.socket.destroy()
    })
}

testUpgradeRelay(false)
testUpgradeRelay(true)

test('relays the response when the backend declines an upgrade', async () => {
    const response = await request(upgrade('/rejected'))
    assert.equal(response.status, 403)
    assert.equal(response.body, 'nope')
})

test('answers instead of hanging on an upgrade request with a body', async () => {
    const body = 'POST /p HTTP/1.1\r\nHost: both.test\r\nConnection: Upgrade\r\nUpgrade: h2c\r\nContent-Length: 5\r\n\r\nhello'
    assert.equal((await request(body)).status, 501)
})

test('closes the connection when the backend answers before the request body arrived', async () => {
    const response = await request('POST /early HTTP/1.1\r\nHost: both.test\r\nContent-Length: 1000\r\n\r\npartial')
    assert.equal(response.status, 401)
    assert.match(response.head, /connection: close/i)
})

test('keeps the connection reusable when the backend answers after the request body arrived', async () => {
    const connection = await connect('POST /early HTTP/1.1\r\nHost: both.test\r\nContent-Length: 5\r\n\r\nhello')
    await waitFor(() => connection.output.includes('401'))
    assert.doesNotMatch(connection.output, /connection: close/i)

    connection.socket.write('GET / HTTP/1.1\r\nHost: both.test\r\nConnection: close\r\n\r\n')
    await waitFor(() => connection.closed)
    assert.match(connection.output, /HTTP\/1\.1 200 /)
})

const isProxySocketOpen = (connection) => [...openSockets].some((socket) => socket.remotePort === connection.localPort)

const refusedUpgrades = {
    'an unknown host': 'GET /socket HTTP/1.1\r\nHost: unknown.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    'an absolute-form target': 'GET http://other.test/ HTTP/1.1\r\nHost: both.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    'a request body': 'POST /p HTTP/1.1\r\nHost: both.test\r\nConnection: Upgrade\r\nUpgrade: h2c\r\nContent-Length: 5\r\n\r\nhello',
    'an unreachable backend': 'GET /socket HTTP/1.1\r\nHost: down.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
}

Object.entries(refusedUpgrades).forEach(([name, text]) => {
    test(`releases the socket of a refused upgrade with ${name} when the client never closes`, async () => {
        const connection = await connect(text, { allowHalfOpen: true })
        await waitFor(() => connection.ended)
        await waitFor(() => !isProxySocketOpen(connection))
        connection.socket.destroy()
    })
})

test('a client leaving before the upgrade completes releases both sides', async () => {
    const closedBefore = backendClosed.upgraded
    const unansweredBefore = unansweredUpgrades
    const connection = await connect(upgrade('/never'), { allowHalfOpen: true })
    await waitFor(() => unansweredUpgrades > unansweredBefore)

    connection.socket.end()
    await waitFor(() => backendClosed.upgraded > closedBefore)
    await waitFor(() => !isProxySocketOpen(connection))
    connection.socket.destroy()
})

test('a client half-close after the upgrade still delivers what the backend sends', async () => {
    const connection = await connect(upgrade('/half-close'), { allowHalfOpen: true })
    await waitFor(() => connection.output.includes('101'))

    connection.socket.end()
    await waitFor(() => connection.output.includes('BYE'))
    connection.socket.destroy()
})

test('a client reset closes the backend socket without an uncaught exception', async () => {
    const closedBefore = backendClosed.upgraded
    const connection = await connect(upgrade('/socket'))
    await waitFor(() => connection.output.includes('FIRST'))
    connection.socket.resetAndDestroy()
    await waitFor(() => backendClosed.upgraded > closedBefore)
    assert.deepEqual(uncaught, [])
})
