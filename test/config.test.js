import assert from 'node:assert/strict'
import { test } from 'node:test'

// config.js parses process.env.DOMAINS on import
process.env.DOMAINS = '[]'
const { parseDomains } = await import('../app/code/config.js')

test('accepts valid routes', () => {
    const domains = [{ from: 'example.com:443', to: '127.0.0.1:3443' }]
    assert.deepEqual(parseDomains(JSON.stringify(domains)), domains)
    assert.deepEqual(parseDomains('[]'), [])
})

test('rejects a missing or malformed value', () => {
    assert.throws(() => parseDomains(undefined), /DOMAINS must be a JSON array/)
    assert.throws(() => parseDomains('not json'), /DOMAINS must be a JSON array/)
    assert.throws(() => parseDomains('{"from":"a:1","to":"b:2"}'), /DOMAINS must be a JSON array/)
})

test('rejects routes that are not host:port', () => {
    const invalidRoutes = [
        { from: 'example.com', to: '127.0.0.1:3000' },
        { from: 'example.com:443', to: '127.0.0.1' },
        { from: 'example.com:443', to: 'http://127.0.0.1:3000' },
        { from: 'example.com:443', to: '127.0.0.1:70000' },
        { from: 'example.com:443' },
        null,
    ]
    invalidRoutes.forEach((route) => {
        assert.throws(() => parseDomains(JSON.stringify([route])), /DOMAINS\[0\]/)
    })
})
