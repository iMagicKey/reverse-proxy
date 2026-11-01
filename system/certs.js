import { existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { exit } from 'process'
import { exec, execSync } from 'child_process'

const ROOT_PATH = resolve()
const environment = process.argv[2] === 'dev' ? 'dev' : 'live'
const CERTS_DIR_PATH = `${ROOT_PATH}/app/config/${environment}/certs`

if (existsSync(`${CERTS_DIR_PATH}/key.pem`) || existsSync(`${CERTS_DIR_PATH}/cert.pem`)) {
    console.log(`Certs already exist in ${CERTS_DIR_PATH}. Remove them first to generate new ones.`)
    exit(0)
}

mkdirSync(CERTS_DIR_PATH, { recursive: true })

exec(
    `ip -4 addr | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){3}' | grep -vE '^(127|10|172\\.(1[6-9]|2[0-9]|3[0-1])|192\\.168)\\.' | head -1`,
    (error, stdout, stderr) => {
        if (error || stderr) throw Error(`Can't find IPv4`)
        const IPv4 = stdout.trim()

        execSync(
            // eslint-disable-next-line max-len
            `openssl req -newkey rsa:2048 -sha256 -nodes -keyout key.pem -x509 -days 9999 -out cert.pem -subj "/C=US/ST=New York/L=Brooklyn/O=Example Brooklyn Company/CN=${IPv4}"`,
            { cwd: CERTS_DIR_PATH, stdio: 'ignore' }
        )
        console.log(`Certs installed in ${CERTS_DIR_PATH}`)
    }
)
