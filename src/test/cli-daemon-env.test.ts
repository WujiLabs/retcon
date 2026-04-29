// Copyright (c) 2026 Wuji Labs Inc
// SPDX-License-Identifier: MIT
//
// Verify that the env dict handed to the detached daemon excludes user
// credentials (Anthropic, AWS, OpenAI, etc.) and other uncaptured secrets,
// while preserving everything the daemon actually needs.

import { describe, expect, it } from 'vitest'
import { buildDaemonEnv } from '../cli/daemon-control.js'

describe('buildDaemonEnv', () => {
  const PARENT = {
    HOME: '/Users/test',
    USER: 'test',
    PATH: '/usr/bin:/bin',
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_TIME: 'en_US.UTF-8',
    TZ: 'America/Los_Angeles',
    NODE_OPTIONS: '--max-old-space-size=4096',
    RETCON_HOME: '/tmp/.retcon',
    // Sensitive — must be stripped:
    ANTHROPIC_API_KEY: 'sk-ant-SECRET',
    ANTHROPIC_AUTH_TOKEN: 'bearer-secret',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    ANTHROPIC_CUSTOM_HEADERS: 'x-trace: 1',
    AWS_ACCESS_KEY_ID: 'AKIA-SECRET',
    AWS_SECRET_ACCESS_KEY: 'secret',
    OPENAI_API_KEY: 'sk-openai-SECRET',
    GITHUB_TOKEN: 'ghp_SECRET',
    SLACK_BOT_TOKEN: 'xoxb-SECRET',
  } satisfies NodeJS.ProcessEnv

  it('passes through HOME / USER / PATH / locale / timezone / NODE_OPTIONS', () => {
    const env = buildDaemonEnv(PARENT, { port: 4099, upstream: 'https://api.anthropic.com' })
    expect(env.HOME).toBe('/Users/test')
    expect(env.USER).toBe('test')
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.LC_ALL).toBe('en_US.UTF-8')
    expect(env.LC_TIME).toBe('en_US.UTF-8')
    expect(env.TZ).toBe('America/Los_Angeles')
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096')
    expect(env.RETCON_HOME).toBe('/tmp/.retcon')
  })

  it('injects RETCON_PORT and RETCON_UPSTREAM from the opts', () => {
    const env = buildDaemonEnv(PARENT, { port: 4100, upstream: 'https://openrouter.ai/api' })
    expect(env.RETCON_PORT).toBe('4100')
    expect(env.RETCON_UPSTREAM).toBe('https://openrouter.ai/api')
  })

  it('strips ALL Anthropic env vars (the daemon proxies headers from requests, not from env)', () => {
    const env = buildDaemonEnv(PARENT, { port: 4099, upstream: 'https://api.anthropic.com' })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })

  it('strips other vendor credentials by default (allow-list, not deny-list)', () => {
    const env = buildDaemonEnv(PARENT, { port: 4099, upstream: 'https://api.anthropic.com' })
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.SLACK_BOT_TOKEN).toBeUndefined()
  })

  it('strips arbitrary user-set vars not in the allow-list', () => {
    const env = buildDaemonEnv(
      { ...PARENT, MY_DB_PASSWORD: 'p4ss', INTERNAL_API_TOKEN: 'tok' },
      { port: 4099, upstream: 'https://api.anthropic.com' },
    )
    expect(env.MY_DB_PASSWORD).toBeUndefined()
    expect(env.INTERNAL_API_TOKEN).toBeUndefined()
  })

  it('passes through corporate-network env (HTTP_PROXY / NODE_EXTRA_CA_CERTS / SSL_CERT_*)', () => {
    // Without these, daemons behind MITM proxies or with private CA bundles
    // get silent TLS failures — daemon.log shows ECONNREFUSED-style errors
    // while the user's interactive `claude` works fine.
    const env = buildDaemonEnv(
      {
        ...PARENT,
        HTTP_PROXY: 'http://corp-proxy:3128',
        HTTPS_PROXY: 'http://corp-proxy:3128',
        NO_PROXY: 'localhost,127.0.0.1',
        ALL_PROXY: 'socks5://corp-proxy:1080',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-ca.pem',
        SSL_CERT_FILE: '/etc/ssl/cert.pem',
        SSL_CERT_DIR: '/etc/ssl/certs',
      },
      { port: 4099, upstream: 'https://api.anthropic.com' },
    )
    expect(env.HTTP_PROXY).toBe('http://corp-proxy:3128')
    expect(env.HTTPS_PROXY).toBe('http://corp-proxy:3128')
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1')
    expect(env.ALL_PROXY).toBe('socks5://corp-proxy:1080')
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/corp-ca.pem')
    expect(env.SSL_CERT_FILE).toBe('/etc/ssl/cert.pem')
    expect(env.SSL_CERT_DIR).toBe('/etc/ssl/certs')
  })
})
