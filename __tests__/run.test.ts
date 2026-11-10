import * as core from '@actions/core'
import { IncomingWebhook } from '@slack/webhook'
import { run } from '../src/main'

jest.mock('@actions/core')
jest.mock('@slack/webhook')
jest.mock('simple-git', () => ({
  simpleGit: () => ({
    revparse: async () => 'abc123',
    log: async () => ({
      latest: { author_name: 'dev' },
      all: [{ hash: 'abc12345', author_name: 'dev', message: 'fix' }]
    })
  })
}))
const deployJob = {
  id: 2,
  name: 'deploy',
  conclusion: 'failure',
  html_url: 'https://github.com/o/r/actions/runs/1/job/2',
  steps: [{ name: 'Configure AWS credentials', conclusion: 'failure' }]
}
let mockJobs: unknown[] = [deployJob]
jest.mock('@actions/github', () => ({
  context: { repo: { owner: 'o', repo: 'r' }, runId: 1, serverUrl: 'https://github.com' },
  getOctokit: () => ({
    rest: { actions: { listJobsForWorkflowRun: 'jobs' }, checks: { listAnnotations: 'notes' } },
    paginate: async (endpoint: string) =>
      endpoint === 'jobs'
        ? mockJobs
        : [{ annotation_level: 'failure', message: 'Not authorized to AssumeRoleWithWebIdentity' }]
  })
}))

const sectionTexts = (payload: { blocks: { text?: { text: string } }[] }): string[] =>
  payload.blocks.map(b => b.text?.text ?? '')

describe('run', () => {
  let inputs: Record<string, string>
  let posted: Record<string, unknown>[]

  beforeEach(() => {
    posted = []
    mockJobs = [deployJob]
    inputs = { title: 'Deploy failed', include_errors: 'true', 'num-commits': '1' }
    jest.mocked(core.getInput).mockImplementation(name => inputs[name] ?? '')
    global.fetch = jest.fn(async (_url, init) => {
      posted.push(JSON.parse(init?.body as string))
      return { ok: true, json: async () => ({ ok: true, ts: `${posted.length}.0` }) }
    }) as unknown as typeof fetch
  })

  it('posts the errors as a reply in the notification thread', async () => {
    Object.assign(inputs, {
      slack_bot_token: 'xoxb',
      channel: 'C1',
      errors_reply_as_thread: 'true'
    })
    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(posted).toHaveLength(2)
    const [parent, reply] = posted as { blocks: { text?: { text: string } }[] }[]
    expect(sectionTexts(parent).some(t => t.includes('AWS OIDC'))).toBe(false)
    expect(JSON.stringify(parent)).toContain('View Failed Job')
    expect(reply).toMatchObject({ channel: 'C1', thread_ts: '1.0' })
    expect(sectionTexts(reply)[0]).toContain('AWS OIDC')
  })

  it('keeps the errors inline when posting with a bot but not threading', async () => {
    Object.assign(inputs, { slack_bot_token: 'xoxb', channel: 'C1' })
    await run()

    expect(posted).toHaveLength(1)
    expect(sectionTexts(posted[0] as never).some(t => t.includes('AWS OIDC'))).toBe(true)
  })

  // A webhook returns no ts to reply under, so the errors must not be lost.
  it('falls back to inline errors over a webhook, with a warning', async () => {
    Object.assign(inputs, { webhook_url: 'https://hooks/x', errors_reply_as_thread: 'true' })
    await run()

    expect(fetch).not.toHaveBeenCalled()
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('errors_reply_as_thread'))
    const send = jest.mocked(IncomingWebhook).mock.instances[0].send as jest.Mock
    expect(sectionTexts(send.mock.calls[0][0]).some(t => t.includes('AWS OIDC'))).toBe(true)
  })

  it('warns when only one of slack_bot_token and channel is set', async () => {
    Object.assign(inputs, { webhook_url: 'https://hooks/x', slack_bot_token: 'xoxb' })
    await run()

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('both'))
  })

  // fail-fast cancels the matrix siblings, which may be listed before the job that failed.
  it('picks the failed job over a cancelled sibling listed before it', async () => {
    mockJobs = [
      { id: 3, name: 'test (b)', conclusion: 'cancelled', html_url: 'https://x/3', steps: [] },
      deployJob
    ]
    Object.assign(inputs, { slack_bot_token: 'xoxb', channel: 'C1' })
    await run()

    expect(JSON.stringify(posted[0])).toContain('`deploy`')
    expect(JSON.stringify(posted[0])).not.toContain('test (b)')
  })

  it('fails when there is nowhere to post', async () => {
    await run()
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('webhook_url'))
  })
})
