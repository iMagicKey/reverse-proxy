const isHostPort = (value) => {
    if (typeof value !== 'string' || !/^[^\s:/]+:\d+$/.test(value)) return false
    const port = Number(value.split(':')[1])
    return port >= 1 && port <= 65535
}

/**
 * Parse and validate the DOMAINS environment variable
 * @param {string} value - JSON array of { from: 'host:port', to: 'host:port' } entries
 * @returns {Array} Validated domain entries
 */
export const parseDomains = (value) => {
    let domains
    try {
        domains = JSON.parse(value)
    } catch (err) {
        throw new Error(`DOMAINS must be a JSON array of { "from": "host:port", "to": "host:port" } entries: ${err.message}`)
    }

    if (!Array.isArray(domains)) {
        throw new Error('DOMAINS must be a JSON array of { "from": "host:port", "to": "host:port" } entries')
    }

    domains.forEach((entry, index) => {
        if (!isHostPort(entry?.from) || !isHostPort(entry?.to)) {
            throw new Error(`DOMAINS[${index}]: "from" and "to" must both be "host:port", got ${JSON.stringify(entry)}`)
        }
    })

    return domains
}

export const DOMAINS = parseDomains(process.env.DOMAINS)
