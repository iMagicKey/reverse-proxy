// A dependency-free backend that answers every request with what it received.
//
//   node examples/echo-backend.js 3000                     plain HTTP, for requests the proxy receives on port 80
//   node examples/echo-backend.js 3443 app/config/live/certs   HTTPS, for requests the proxy receives on port 443
import fs from 'fs'
import http from 'http'
import https from 'https'

const port = Number(process.argv[2]) || 3000
const certsDir = process.argv[3]

const handler = (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(`${JSON.stringify({ method: req.method, url: req.url, headers: req.headers }, null, 2)}\n`)
}

const server = certsDir
    ? https.createServer({ key: fs.readFileSync(`${certsDir}/key.pem`), cert: fs.readFileSync(`${certsDir}/cert.pem`) }, handler)
    : http.createServer(handler)

server.listen(port, '127.0.0.1', () => {
    console.log(`Echo backend listening on ${certsDir ? 'https' : 'http'}://127.0.0.1:${port}`)
})
