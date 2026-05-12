import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { existsSync, statSync, openSync, readSync, closeSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { startBuild, readLogs, readState, WORKSPACE } from './builder.js'
import { deployToWalrus } from './deployer.js'

const app = new Hono()

// POST /build — start async build, returns buildId immediately
app.post('/build', async (c) => {
  try {
    const body = await c.req.json()
    const {
      repoUrl, branch = 'main', baseDir, installCommand, buildCommand, outputDir, githubToken,
    } = body as {
      repoUrl: string; branch: string; baseDir?: string; installCommand?: string; buildCommand?: string; outputDir?: string; githubToken?: string
    }
    if (!repoUrl) return c.json({ success: false, error: 'repoUrl is required' }, 400)
    const buildId = startBuild({ repoUrl, branch, baseDir, installCommand, buildCommand, outputDir, githubToken, buildId: body.buildId })
    return c.json({ buildId, status: 'started' })
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : 'unknown error' }, 500)
  }
})

// GET /logs/:buildId — stream current build log
app.get('/logs/:buildId', (c) => {
  const buildId = c.req.param('buildId')
  const logs = readLogs(buildId)
  return c.json({ logs })
})

// GET /status/:buildId — get build status + result
app.get('/status/:buildId', (c) => {
  const buildId = c.req.param('buildId')
  const state = readState(buildId)
  return c.json(state)
})

  // GET /stream-logs/:buildId — SSE real-time log streaming
  app.get('/stream-logs/:buildId', (c) => {
    const buildId = c.req.param('buildId')
    const logPath = join(WORKSPACE, buildId, 'log.txt')
    const MAX_CHUNK = 64 * 1024 // cap each SSE message to 64KB to avoid browser memory explosions

    let lastSize = 0
    let closed = false

    const stream = new ReadableStream({
      start(controller) {
        const send = () => {
          if (closed) return
          try {
            // Check for new log content
            if (existsSync(logPath)) {
              const stat = statSync(logPath)
              if (stat.size > lastSize) {
                const delta = stat.size - lastSize
                const size = Math.min(delta, MAX_CHUNK)
                const fd = openSync(logPath, 'r')
                const buf = Buffer.alloc(size)
                readSync(fd, buf, 0, size, lastSize)
                closeSync(fd)
                const text = buf.toString('utf-8')
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ text })}
\n`))
                lastSize += size
                // If there is more unread data, schedule another send immediately
                if (lastSize < stat.size) {
                  setTimeout(send, 0)
                  return
                }
                controller.enqueue(new TextEncoder().encode(`:keepalive\n\n`))
              } else {
                controller.enqueue(new TextEncoder().encode(`:keepalive\n\n`))
              }
            }

            // Check if build is done
            const state = readState(buildId)
            if (state.status === 'done' || state.status === 'error') {
              controller.enqueue(new TextEncoder().encode(
                `event: done\ndata: ${JSON.stringify(state)}\n\n`
              ))
              closed = true
              controller.close()
              return
            }

            setTimeout(send, 250)
          } catch {
            closed = true
            controller.close()
          }
        }
        send()
      },
      cancel() {
        closed = true
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  })

// POST /deploy — synchronous deploy
app.post('/deploy', async (c) => {
  try {
    const body = await c.req.json()
    const {
      distPath, network = 'testnet', epochs = 'max', siteName, suiKeystore, suiAddress, buildId,
    } = body as {
      distPath: string; network?: 'mainnet' | 'testnet'; epochs?: number | 'max'; siteName?: string; suiKeystore: string; suiAddress: string; buildId?: string
    }
    if (!distPath) return c.json({ success: false, error: 'distPath required', logs: [] }, 400)
    if (!suiKeystore || !suiAddress) return c.json({ success: false, error: 'wallet credentials required', logs: [] }, 400)
    const result = await deployToWalrus({ distPath, network: network as 'mainnet' | 'testnet', epochs, siteName, suiKeystore, suiAddress })
    // Also write deploy logs to the build log file so they can be retrieved later
    if (buildId) {
      const logPath = join(WORKSPACE, buildId, 'log.txt')
      try {
        appendFileSync(logPath, '\n--- Deploy ---\n' + result.logs.join('\n') + '\n')
      } catch {}
    }
    return c.json(result)
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : 'deploy error', logs: [] }, 500)
  }
})

app.get('/status', (c) => c.json({ status: 'ready' }))

const port = parseInt(process.env.PORT || '8080', 10)
serve({ fetch: app.fetch, port }, (info) => console.log(`Build server listening on port ${info.port}`))
