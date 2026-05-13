// ANSI helpers using anser (the library behind ansi-to-react)
import Anser from 'anser'
import { escapeCarriageReturn } from 'escape-carriage'

const MAX_LOG_LEN = 200_000

function truncateSafe(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text

  let truncated = text.slice(-maxLen)

  // If the truncated text doesn't start with ESC, it might have a partial ANSI sequence
  if (truncated.charCodeAt(0) !== 0x1b) {
    // Look for first ESC in first 50 chars
    let escIndex = -1
    for (let i = 0; i < Math.min(50, truncated.length); i++) {
      if (truncated.charCodeAt(i) === 0x1b) {
        escIndex = i
        break
      }
    }

    if (escIndex !== -1) {
      truncated = truncated.slice(escIndex)
    } else {
      // Check for partial ANSI sequence without ESC: [digits;...m
      const partialMatch = truncated.match(/^\[\d+(;\d+)*m/)
      if (partialMatch) {
        truncated = truncated.slice(partialMatch[0].length)
      }
    }
  }

  return truncated
}

export function renderAnsiLogs(text: string): string {
  if (!text) return ''

  const truncated = text.length > MAX_LOG_LEN
  let source = truncateSafe(text, MAX_LOG_LEN)

  // Handle carriage returns (progress bars, etc.)
  source = escapeCarriageReturn(source)

  // Convert ANSI to HTML
  const html = Anser.ansiToHtml(source)

  if (truncated) {
    return '<span style="color:#d29922">[log truncated, showing last ' + (MAX_LOG_LEN / 1000).toFixed(0) + 'K chars]</span>\n' + html
  }

  return html
}
