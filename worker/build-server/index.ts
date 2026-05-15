import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { startBuild, readLogs, readState, writeState, WORKSPACE } from './builder.js'
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
    const MAX_IDLE_TICKS = 120 // 250ms * 120 = 30s idle timeout after build/deploy finish

    let lastSize = 0
    let closed = false
    let idleTicks = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const stream = new ReadableStream({
      start(controller) {
        const send = () => {
          if (closed) return
          if (timer) {
            clearTimeout(timer)
            timer = null
          }
          try {
            let hadNewData = false

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
                hadNewData = true
              }
            }

            if (hadNewData) {
              idleTicks = 0
            } else {
              idleTicks++
            }
            controller.enqueue(new TextEncoder().encode(`:keepalive\n\n`))

            // Only close once build/deploy are finished AND logs have been idle for a while
            const state = readState(buildId)
            if ((state.status === 'done' || state.status === 'error') && idleTicks > MAX_IDLE_TICKS) {
              controller.enqueue(new TextEncoder().encode(
                `event: done\ndata: ${JSON.stringify(state)}\n\n`
              ))
              closed = true
              controller.close()
              return
            }

            timer = setTimeout(send, 250)
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
      distPath, network = 'testnet', epochs = 'max', siteName, existingObjectId, suiKeystore, suiAddress, buildId,
    } = body as {
      distPath: string; network?: 'mainnet' | 'testnet'; epochs?: number | 'max'; siteName?: string; existingObjectId?: string; suiKeystore: string; suiAddress: string; buildId?: string
    }
    if (!distPath) return c.json({ success: false, error: 'distPath required', logs: [] }, 400)
    if (!suiKeystore || !suiAddress) return c.json({ success: false, error: 'wallet credentials required', logs: [] }, 400)
    const logPath = buildId ? join(WORKSPACE, buildId, 'log.txt') : undefined
    if (buildId) {
      writeState(buildId, { status: 'running', phase: 'deploy', distPath })
    }
    const result = await deployToWalrus({ distPath, network: network as 'mainnet' | 'testnet', epochs, siteName, existingObjectId, suiKeystore, suiAddress, logPath })
    if (buildId) {
      writeState(buildId, {
        status: result.success ? 'done' : 'error',
        phase: 'deploy',
        distPath,
        error: result.success ? undefined : result.error,
        deployResult: {
          success: result.success,
          objectId: result.objectId,
          base36Url: result.base36Url,
          error: result.error,
        },
      })
    }
    return c.json(result)
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : 'deploy error', logs: [] }, 500)
  }
})

app.get('/status', (c) => c.json({ status: 'ready' }))

const port = parseInt(process.env.PORT || '8080', 10)
serve({ fetch: app.fetch, port }, (info) => console.log(`Build server listening on port ${info.port}`))
