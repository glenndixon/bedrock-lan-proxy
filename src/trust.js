'use strict'

// Trust for the remote server's operator key.
//
// Over plain HTTP, node-nethernet verifies that the server's answer is signed by *some*
// key, but not that it's the right server. Like SSH, we trust the key the first time we
// see it for a given address, remember it, and refuse if it later changes. A key given
// with --server-key is pinned instead. HTTPS origins are trusted through TLS.

const fs = require('node:fs')
const path = require('node:path')

function readStore (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw new Error(`Could not read ${file}: ${err.message}`)
  }
}

function writeStore (file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(store, null, 2) + '\n')
}

/**
 * @param {object} opts
 * @param {string} opts.file           where remembered keys live
 * @param {string} [opts.pinned]       sha256:<hex> key to require
 * @param {(level: 'info'|'warn', msg: string) => void} [opts.log]
 * @returns {{ serverKey?: string, onServerKey?: (fingerprint: string, origin: string) => boolean }}
 */
function createServerTrust ({ file, pinned, log = () => {} }) {
  if (pinned) return { serverKey: pinned }

  return {
    onServerKey (fingerprint, origin) {
      const store = readStore(file)
      const known = store[origin]
      if (known === fingerprint) return true
      if (!known) {
        store[origin] = fingerprint
        writeStore(file, store)
        log('info', `First connection to ${origin}: trusting its server key ${fingerprint} (saved to ${file})`)
        return true
      }
      log('warn',
        `The server key for ${origin} has CHANGED, so the proxy refused to connect.\n` +
        `    expected ${known}\n` +
        `    got      ${fingerprint}\n` +
        '    If the server was reinstalled or moved, remove its entry from ' + file +
        ' or pass --server-key with the new value.')
      return false
    }
  }
}

module.exports = { createServerTrust }
