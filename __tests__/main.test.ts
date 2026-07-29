import { renderMessage } from '../src/main'

const FENCE = '```'
const MAX = 2500

describe('renderMessage', () => {
  describe('mrkdwn (default)', () => {
    it('passes the body through, trimmed', () => {
      expect(renderMessage('  hello  ', 'mrkdwn')).toBe('hello')
    })

    it('renders nothing for an empty or whitespace-only body', () => {
      expect(renderMessage('', 'mrkdwn')).toBe('')
      expect(renderMessage('   \n  ', 'mrkdwn')).toBe('')
    })

    it('truncates past the cap and marks the cut', () => {
      const out = renderMessage('x'.repeat(MAX + 500), 'mrkdwn')
      expect(out).toHaveLength(MAX)
      expect(out.endsWith('[truncated]')).toBe(true)
    })

    it('leaves a fence terminator alone - it is only a problem inside a code block', () => {
      expect(renderMessage(`a ${FENCE} b`, 'mrkdwn')).toBe(`a ${FENCE} b`)
    })
  })

  describe('code', () => {
    it('wraps the body in a fence', () => {
      expect(renderMessage('terraform failed', 'code')).toBe(`${FENCE}terraform failed${FENCE}`)
    })

    it('renders nothing for an empty body, rather than an empty code block', () => {
      expect(renderMessage('', 'code')).toBe('')
      expect(renderMessage('  \n ', 'code')).toBe('')
    })

    // Slack closes a code block at the first fence terminator, so one in the body would end the
    // block early and let the rest render as mrkdwn.
    it('neutralizes a fence terminator so the body cannot break out', () => {
      const out = renderMessage(`before ${FENCE} after`, 'code')
      expect(out.split(FENCE)).toHaveLength(3)
      expect(out).toBe(`${FENCE}before ''' after${FENCE}`)
    })

    it('neutralizes every fence terminator, not just the first', () => {
      const out = renderMessage(`a ${FENCE} b ${FENCE} c`, 'code')
      expect(out.split(FENCE)).toHaveLength(3)
    })

    // A body ending in backticks would merge with the closing fence into a longer run.
    it('does not let trailing backticks merge with the closing fence', () => {
      expect(renderMessage('value ``', 'code')).toBe(`${FENCE}value${FENCE}`)
      expect(renderMessage('value `', 'code')).toBe(`${FENCE}value${FENCE}`)
    })

    // Indentation is structure in machine output, not padding to be tidied away.
    it('preserves leading indentation, dropping only blank leading lines', () => {
      expect(renderMessage('\n\n    at foo()\n      at bar()\n\n', 'code')).toBe(
        `${FENCE}    at foo()\n      at bar()${FENCE}`
      )
    })

    it('keeps the whole rendered block within the cap, fence included', () => {
      const out = renderMessage('x'.repeat(MAX + 500), 'code')
      expect(out.length).toBeLessThanOrEqual(MAX)
      expect(out.startsWith(FENCE)).toBe(true)
      expect(out.endsWith(FENCE)).toBe(true)
      expect(out.split(FENCE)).toHaveLength(3)
    })
  })

  it('falls back to mrkdwn for an unknown format rather than dropping the message', () => {
    expect(renderMessage(`a ${FENCE} b`, 'nonsense')).toBe(`a ${FENCE} b`)
  })
})
