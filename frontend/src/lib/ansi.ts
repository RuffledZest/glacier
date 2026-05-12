export function ansiToHtml(text: string): string {
  // Safety: cap input to prevent OOM/render crashes
  const MAX_LEN = 200_000
  const truncated = text.length > MAX_LEN
  const input = text.slice(-MAX_LEN)

  const colors: Record<number, string> = {
    30: '#c9d1d9', 31: '#f85149', 32: '#3fb950', 33: '#d29922',
    34: '#58a6ff', 35: '#bc8cff', 36: '#56d4dd', 37: '#f0f6fc',
    90: '#8b949e', 91: '#f7787a', 92: '#56d364', 93: '#e3b341',
    94: '#79c0ff', 95: '#d2a8ff', 96: '#56d4dd', 97: '#ffffff',
  }

  const bgColors: Record<number, string> = {
    40: '#0d1117', 41: '#490202', 42: '#04260f', 43: '#5c4b00',
    44: '#0c2d6b', 45: '#2d1174', 46: '#04260f', 47: '#30363d',
  }

  let html = ''
  const stack: string[] = []

  const escaped = input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const regex = /\x1b\[([\d;]+)m/g
  let lastIdx = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(escaped)) !== null) {
    if (match.index > lastIdx) {
      html += escaped.slice(lastIdx, match.index)
    }
    lastIdx = regex.lastIndex

    const codes = match[1].split(';').map(Number)

    if (codes[0] === 0 || codes.length === 1 && codes[0] === 0) {
      while (stack.length) html += '</span>'
      continue
    }

    const styles: string[] = []
    for (const code of codes) {
      if (code === 1) styles.push('font-weight:bold')
      else if (code === 2) styles.push('opacity:0.6')
      else if (code === 4) styles.push('text-decoration:underline')
      else if (colors[code]) styles.push(`color:${colors[code]}`)
      else if (bgColors[code]) styles.push(`background:${bgColors[code]}`)
    }

    if (styles.length) {
      html += `<span style="${styles.join(';')}">`
      stack.push('</span>')
    }
  }

  if (lastIdx < escaped.length) {
    html += escaped.slice(lastIdx)
  }

  while (stack.length) html += '</span>'

  if (truncated) {
    html = '<span style="color:#d29922">[log truncated, showing last ' + (MAX_LEN / 1000).toFixed(0) + 'K chars]</span>\n' + html
  }

  return html
}
