import run from './code/index.js'
import Logger from './libs/logger.js'
import getConfig from './libs/get-config.js'

global.config = getConfig()

Logger.setConfig(global.config.logger)
global.logger = Logger

const errorEvents = ['uncaughtException', 'unhandledRejection']
errorEvents.forEach((eventName) => {
    process.on(eventName, (err) => {
        global.logger.crit(eventName, err)
    })
})

run().catch((err) => {
    global.logger.crit('Startup failed', err)
    process.exit(1)
})
