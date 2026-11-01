import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const ROOT_PATH = resolve()

const FOLDER_NAMES = ['logs', 'config/dev']
FOLDER_NAMES.forEach((folderName) => {
    const folderPath = `${ROOT_PATH}/app/${folderName}/`
    if (!existsSync(folderPath)) mkdirSync(folderPath, { recursive: true })
})

const LOG_LEVELS = ['log', 'debug', 'error', 'warn', 'info', 'crit', 'service-output', 'service-error']
LOG_LEVELS.forEach((logLevel) => {
    const filePath = `${ROOT_PATH}/app/logs/${logLevel}.log`
    if (!existsSync(filePath)) writeFileSync(filePath, '')
})

const ENV_EXAMPLE = readFileSync(`${ROOT_PATH}/.env.example`, 'utf8')
const ENV_FILES = { '.env': 'live', '.env.dev': 'dev' }
Object.entries(ENV_FILES).forEach(([fileName, appEnv]) => {
    const filePath = `${ROOT_PATH}/${fileName}`
    if (!existsSync(filePath)) writeFileSync(filePath, ENV_EXAMPLE.replace('APP_ENV=live', `APP_ENV=${appEnv}`))
})
