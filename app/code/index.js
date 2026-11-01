import fs from 'fs'
import { resolve } from 'path'
import { DOMAINS } from './config.js'
import createProxyServers from './proxy.js'

/**
 * Start listening and treat a failed bind as fatal, a half-started proxy would look healthy
 * @param {Object} server - HTTP or HTTPS server
 * @param {number} port - Port to listen on
 * @param {string} name - Server name for log messages
 */
const listen = (server, port, name) => {
    server.on('error', (err) => {
        global.logger.error(`${name} server error:`, err)
        if (!server.listening) process.exit(1)
    })

    server.listen(port, () => {
        global.logger.log(`${name} proxy server listening on port ${port}`)
    })
}

export default async () => {
    const sslOptions = {
        key: fs.readFileSync(resolve(`app/config/${process.env.APP_ENV}/certs/key.pem`)),
        cert: fs.readFileSync(resolve(`app/config/${process.env.APP_ENV}/certs/cert.pem`)),
    }

    const { httpServer, httpsServer } = createProxyServers(DOMAINS, sslOptions)

    global.logger.log('Configured domains:', DOMAINS)

    listen(httpServer, 80, 'HTTP')
    listen(httpsServer, 443, 'HTTPS')
}
