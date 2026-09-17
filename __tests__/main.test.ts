import { parseButtons, renderMessage } from '../src/main'

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

describe('parseButtons', () => {
  it('parses a list of buttons in order', () => {
    expect(
      parseButtons(
        '[{"text":"View Issue","url":"https://x/1"},{"text":"Runbook","url":"https://x/2"}]'
      )
    ).toEqual([
      { text: 'View Issue', url: 'https://x/1' },
      { text: 'Runbook', url: 'https://x/2' }
    ])
  })

  it('renders none when the input is unset, empty or an empty array', () => {
    expect(parseButtons('')).toEqual([])
    expect(parseButtons('   ')).toEqual([])
    expect(parseButtons('[]')).toEqual([])
  })

  // A caller building the JSON from a step output can legitimately produce an empty url - the
  // notification should still go out, one button lighter.
  it('skips an entry missing text or url rather than rendering a broken button', () => {
    expect(
      parseButtons(
        '[{"text":"No url","url":""},{"text":"","url":"https://x/1"},{"url":"https://x/2"}]'
      )
    ).toEqual([])
  })

  it('keeps the valid entries alongside a skipped one', () => {
    expect(parseButtons('[{"text":"Ok","url":"https://x/1"},{"text":"Bad","url":""}]')).toEqual([
      { text: 'Ok', url: 'https://x/1' }
    ])
  })

  // Slack rejects the whole payload on a bad block, so a malformed input must not take the
  // notification down with it.
  it('renders none for invalid JSON or a non-array', () => {
    expect(parseButtons('not json')).toEqual([])
    expect(parseButtons('{"text":"x","url":"y"}')).toEqual([])
    expect(parseButtons('"a string"')).toEqual([])
    expect(parseButtons('[null]')).toEqual([])
  })

  it('trims, and truncates a label past the 75-character button cap', () => {
    expect(parseButtons('[{"text":"  Spaced  ","url":"  https://x/1  "}]')).toEqual([
      { text: 'Spaced', url: 'https://x/1' }
    ])
    expect(parseButtons(`[{"text":"${'x'.repeat(100)}","url":"https://x/1"}]`)).toEqual([
      { text: 'x'.repeat(75), url: 'https://x/1' }
    ])
  })

  // Truncating by UTF-16 code unit would cut the 38th emoji in half and leave a lone surrogate,
  // which Slack renders as a replacement character at best.
  it('truncates a label by code point, never mid-surrogate-pair', () => {
    const [button] = parseButtons(`[{"text":"${'\u{1f600}'.repeat(80)}","url":"https://x/1"}]`)
    expect(button.text).toBe('\u{1f600}'.repeat(75))
    expect(Array.from(button.text)).toHaveLength(75)
  })

  // A step output that came back as 'none' or '#123' is non-empty but unusable; letting it
  // through would have Slack reject the whole actions block.
  it('skips a url that is not an absolute http(s) URL', () => {
    expect(
      parseButtons(
        '[{"text":"a","url":"none"},{"text":"b","url":"#123"},{"text":"c","url":"/issues/1"},{"text":"d","url":"javascript:alert(1)"}]'
      )
    ).toEqual([])
  })

  it('skips a url past the 3000-character cap', () => {
    const long = `https://x/${'a'.repeat(3000)}`
    expect(
      parseButtons(`[{"text":"Long","url":"${long}"},{"text":"Ok","url":"https://x/1"}]`)
    ).toEqual([{ text: 'Ok', url: 'https://x/1' }])
  })
})
