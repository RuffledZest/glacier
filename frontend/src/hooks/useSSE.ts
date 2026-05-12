import { useEffect, useRef } from 'react'

interface UseSSEOptions {
  url: string
  token: string
  onMessage: (text: string) => void
  onDone: () => void
}

export function useSSE({ url, token, onMessage, onDone }: UseSSEOptions) {
  const onMessageRef = useRef(onMessage)
  const onDoneRef = useRef(onDone)
  const abortRef = useRef<AbortController | null>(null)

  // Keep refs updated without triggering reconnection
  onMessageRef.current = onMessage
  onDoneRef.current = onDone

  useEffect(() => {
    if (!url || !token) return

    const controller = new AbortController()
    abortRef.current = controller

    const fullUrl = `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`

    fetch(fullUrl, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    })
      .then(async (resp) => {
        if (!resp.ok || !resp.body) {
          console.error('[SSE] response not ok or no body', resp.status, resp.statusText)
          onDoneRef.current()
          return
        }

        const contentType = resp.headers.get('content-type') || ''
        if (!contentType.includes('text/event-stream')) {
          console.error('[SSE] unexpected content-type:', contentType)
          onDoneRef.current()
          return
        }

        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        const MAX_BUFFER = 2 * 1024 * 1024 // 2MB safety cap on parser buffer

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            if (buffer.length > MAX_BUFFER) {
              console.error('[SSE] buffer exceeded safety cap, dropping connection')
              onDoneRef.current()
              return
            }

            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            let eventType = ''
            for (const line of lines) {
              if (line.startsWith('event: ')) {
                eventType = line.slice(7).trim()
              } else if (line.startsWith('data: ')) {
                try {
                  const parsed = JSON.parse(line.slice(6))
                  if (eventType === 'done') {
                    onDoneRef.current()
                    return
                  }
                  if (parsed.text) {
                    onMessageRef.current(parsed.text)
                  }
                } catch (e) {
                  console.error('[SSE] JSON parse error:', e)
                }
                eventType = ''
              }
            }
          }
        } catch (e) {
          console.error('[SSE] stream read error:', e)
        }
        onDoneRef.current()
      })
      .catch((e) => {
        if ((e as Error)?.name !== 'AbortError') {
          console.error('[SSE] fetch error:', e)
        }
      })

    return () => controller.abort()
  }, [url, token]) // only reconnect if URL or token changes
}
