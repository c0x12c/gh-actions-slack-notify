import * as core from '@actions/core'
import * as github from '@actions/github'
import { IncomingWebhook } from '@slack/webhook'
import { simpleGit as SimpleGit } from 'simple-git'

const simpleGit = SimpleGit()
const MAX_MESSAGE_LENGTH = 2500
const TRUNCATION_SUFFIX = ' ... [truncated]'
const FENCE = '```'
// Slack rejects the whole payload if a button label runs past 75 characters, if its url runs past
// 3000, or if an actions block carries more than 25 elements.
const MAX_BUTTON_TEXT_LENGTH = 75
const MAX_BUTTON_URL_LENGTH = 3000
const MAX_BUTTONS = 25
const MAX_ERROR_LENGTH = 500
// A section's text is capped at 3000 characters, and step names are caller-defined.
const MAX_STEPS = 5
const EXIT_CODE_ONLY = /^Process completed with exit code \d+\.?$/

const KNOWN_ERRORS = [
  {
    pattern: /AssumeRoleWithWebIdentity|assume role with OIDC/i,
    label: ':closed_lock_with_key: *AWS OIDC: could not assume role*',
    hint: 'The role trust policy does not match the token. Check the repo, branch or `environment:` in its `token.actions.githubusercontent.com:sub` condition, and the role ARN.'
  },
  {
    pattern: /Error acquiring the state lock/i,
    label: ':lock: *Terraform state lock held*',
    hint: 'Another plan or apply holds the lock. Wait for it, or force-unlock if that run died.'
  },
  {
    pattern: /not authorized to perform: ecr:|no basic auth credentials/i,
    label: ':no_entry: *ECR access denied*',
    hint: 'Check the ECR permissions of the assumed role and that the registry login step ran.'
  },
  {
    pattern: /exceeded the maximum execution time|The operation was canceled/i,
    label: ':stopwatch: *Timed out or cancelled*',
    hint: 'Check `timeout-minutes`, and whether a newer run cancelled this one.'
  }
]

export interface JobFailure {
  job: string
  steps: string[]
  url: string
  errors: string[]
}

/**
 * Slack reads `&`, `<` and `>` as control characters even inside code, so build output like
 * `<<EOT` or `<!channel>` would be swallowed or turned into a ping or a link.
 */
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Cap the length, marking the cut so a truncated body does not read as a complete one. */
function truncate(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`
    : text
}

export interface Button {
  text: string
  url: string
}

/** Cap a label by code point, so the cut cannot land inside a surrogate pair. */
function truncateLabel(text: string): string {
  const points = Array.from(text)
  return points.length > MAX_BUTTON_TEXT_LENGTH
    ? points.slice(0, MAX_BUTTON_TEXT_LENGTH).join('')
    : text
}

/** Slack renders a button only for an absolute http(s) url within its length limit. */
function urlProblem(url: string): string | null {
  if (url.length > MAX_BUTTON_URL_LENGTH) {
    return `url is longer than ${MAX_BUTTON_URL_LENGTH} characters`
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'url is not an absolute URL'
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    ? null
    : `url scheme '${parsed.protocol}' is not http or https`
}

/**
 * Parse the `buttons` input - a JSON array of `{ text, url }`.
 *
 * A malformed entry is dropped with a warning rather than thrown: a bad button should cost you
 * the button, not the whole notification, which is usually the only signal that something failed.
 * That holds only if every value Slack validates is checked here, so the url is checked for shape
 * and length too - a non-empty but unusable one would otherwise sink the whole payload.
 */
export function parseButtons(raw: string): Button[] {
  if (!raw.trim()) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    core.warning('buttons is not valid JSON; rendering none.')
    return []
  }

  if (!Array.isArray(parsed)) {
    core.warning('buttons is not a JSON array; rendering none.')
    return []
  }

  return parsed
    .map((entry, index) => {
      const candidate = entry as Record<string, unknown> | null
      const text = typeof candidate?.text === 'string' ? candidate.text.trim() : ''
      const url = typeof candidate?.url === 'string' ? candidate.url.trim() : ''
      // Warnings name the position, never the entry: a rejected url is often a long signed one,
      // and workflow logs mask only values registered as secrets.
      if (!text || !url) {
        core.warning(`Skipping button at index ${index}: text and url are both required.`)
        return null
      }
      const problem = urlProblem(url)
      if (problem) {
        core.warning(`Skipping button at index ${index}: ${problem}.`)
        return null
      }
      return { text: truncateLabel(text), url }
    })
    .filter((button): button is Button => button !== null)
}

/**
 * Render the message body for Slack.
 *
 * `code` wraps it in a fence, which is why the escaping lives here rather than in each caller:
 * Slack closes a code block at the first fence terminator, so one occurring in the body would end
 * the block early and let whatever followed render as mrkdwn.
 */
export function renderMessage(raw: string, format: string): string {
  if (!raw.trim()) return ''
  if (format !== 'code') return truncate(raw.trim(), MAX_MESSAGE_LENGTH)

  // Indentation on the first line is structure in machine output - a stack trace frame, a nested
  // terraform attribute - so only blank leading lines go, not the leading whitespace itself.
  const body = raw.replace(/^\n+/, '').trimEnd()
  // The fence counts against the same budget, so reserve it instead of letting the rendered block
  // run over. Truncating first and wrapping after would also risk cutting the closing fence off.
  const inner = truncate(body.replace(/```/g, "'''"), MAX_MESSAGE_LENGTH - FENCE.length * 2)
  // A body ending in backticks would merge with the closing fence into a longer run. Trailing
  // whitespace goes with them so stripping one does not leave the other stranded.
  return `${FENCE}${inner.replace(/[\s`]+$/, '')}${FENCE}`
}

export async function fetchFailures(token: string): Promise<JobFailure[]> {
  const octokit = github.getOctokit(token)
  const { owner, repo } = github.context.repo
  const jobs = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
    owner,
    repo,
    run_id: github.context.runId,
    per_page: 100
  })
  // A step killed by timeout-minutes, and every job of a cancelled run, conclude as 'cancelled'.
  const broke = (c?: string | null): boolean => c === 'failure' || c === 'cancelled'
  const failed = jobs.filter(
    job => broke(job.conclusion) || job.steps?.some(s => broke(s.conclusion))
  )
  // A real failure outranks the matrix siblings fail-fast cancelled because of it.
  failed.sort((a, b) => Number(a.conclusion !== 'failure') - Number(b.conclusion !== 'failure'))
  // Only the first failed job is rendered, so fetching annotations for the rest is wasted calls.
  return Promise.all(
    failed.slice(0, 1).map(async job => {
      const annotations = await octokit.paginate(octokit.rest.checks.listAnnotations, {
        owner,
        repo,
        check_run_id: job.id,
        per_page: 100
      })
      return {
        job: job.name,
        steps: (job.steps ?? []).filter(step => broke(step.conclusion)).map(s => s.name),
        url: job.html_url ?? '',
        errors: annotations
          .filter(a => a.annotation_level === 'failure' && a.message)
          .map(a => a.message as string)
      }
    })
  )
}

export function renderFailures(failures: JobFailure[]): string[] {
  return failures.slice(0, 1).map(failure => {
    const detailed = failure.errors.filter(e => !EXIT_CODE_ONLY.test(e.trim()))
    const errors = [...new Set(detailed.length ? detailed : failure.errors)]
    const known = KNOWN_ERRORS.find(k => errors.some(e => k.pattern.test(e)))
    const first = (known && errors.find(e => known.pattern.test(e))) ?? errors[0]
    const steps = failure.steps.slice(0, MAX_STEPS)
    const more = failure.steps.length - steps.length
    const where =
      // A backtick in a name would close its code span early.
      [failure.job, ...steps]
        .map(name => `\`${escapeMrkdwn(truncate(name, 100)).replace(/`/g, "'")}\``)
        .join(' › ') + (more > 0 ? ` (+${more} more)` : '')
    const shown = first ? [truncate(escapeMrkdwn(first.trim()), MAX_ERROR_LENGTH)] : []
    if (errors.length > 1) shown.push(`... and ${errors.length - 1} more`)
    return [
      known?.label ?? ':warning: *Failed*',
      `*Job / step:* ${where}`,
      renderMessage(shown.join('\n'), 'code'),
      known ? `_Hint:_ ${known.hint}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  })
}

/** Post via chat.postMessage, which unlike a webhook returns the `ts` a thread reply needs. */
export async function postMessage(
  token: string,
  payload: Record<string, unknown>
): Promise<string> {
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(payload)
  })
  // A 5xx or proxy page is not JSON; name the status instead of surfacing a parse error.
  if (!response.ok) throw new Error(`chat.postMessage failed: HTTP ${response.status}`)
  // Slack reports API errors as HTTP 200 with `ok: false`.
  const result = (await response.json()) as { ok: boolean; ts?: string; error?: string }
  if (!result.ok || !result.ts) throw new Error(`chat.postMessage failed: ${result.error}`)
  return result.ts
}

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } }) as const

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const title = core.getInput('title') as string
    const message = core.getInput('message') as string
    const messageFormat = (core.getInput('message_format') as string) || 'mrkdwn'
    const projectUrl = core.getInput('project_url') as string
    const extraButtons = parseButtons(core.getInput('buttons') as string)
    const includeErrors = core.getInput('include_errors') === 'true'
    const webhookUrl = core.getInput('webhook_url') as string
    const botToken = core.getInput('slack_bot_token') as string
    const channel = core.getInput('channel') as string
    const useBot = Boolean(botToken && channel)
    if (!useBot && (botToken || channel)) {
      core.warning('slack_bot_token and channel are used only when both are set.')
    }
    if (!useBot && !webhookUrl) {
      throw new Error('Set webhook_url, or slack_bot_token and channel.')
    }
    let replyAsThread = includeErrors && core.getInput('errors_reply_as_thread') === 'true'
    if (replyAsThread && !useBot) {
      core.warning(
        'errors_reply_as_thread needs slack_bot_token and channel; a webhook cannot reply in a thread. Rendering errors inline.'
      )
      replyAsThread = false
    }

    const revision = await simpleGit.revparse('HEAD')
    const author = await simpleGit.log({
      maxCount: 1
    })
    const authorName = author.latest?.author_name || 'Unknown'

    const commitMessages = await simpleGit.log({
      maxCount: core.getInput('num-commits') as string
    })

    const combinedMessages = commitMessages.all
      .map(commit => `${commit.hash.substring(0, 8)} (${commit.author_name}) ${commit.message}`)
      .join('\n')

    const repoInfo = github.context.repo
    const repoUrl = `${github.context.serverUrl}/${repoInfo.owner}/${repoInfo.repo}`
    const pipelineUrl = `${repoUrl}/actions/runs/${github.context.runId}`
    core.debug(`Pipeline URL: ${pipelineUrl}`)

    const buttons = [
      {
        text: 'View Commit',
        url: `${repoUrl}/commit/${revision}`
      },
      {
        text: 'View Pipeline',
        url: pipelineUrl
      }
    ]

    if (projectUrl) {
      buttons.push({
        text: 'View Project',
        url: projectUrl
      })
    }

    let failureSections: string[] = []
    if (includeErrors) {
      try {
        const failures = await fetchFailures(core.getInput('github_token'))
        failureSections = renderFailures(failures)
        if (failures[0]?.url) buttons.push({ text: 'View Failed Job', url: failures[0].url })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        core.warning(`Could not read this run's errors (${reason}); sending without them.`)
      }
    }

    buttons.push(...extraButtons)

    if (buttons.length > MAX_BUTTONS) {
      core.warning(`Slack renders at most ${MAX_BUTTONS} buttons; dropping the rest.`)
      buttons.length = MAX_BUTTONS
    }

    if (messageFormat !== 'mrkdwn' && messageFormat !== 'code') {
      core.warning(`Unknown message_format '${messageFormat}'; rendering as mrkdwn.`)
    }
    const renderedMessage = renderMessage(message, messageFormat)

    const messageBlocks = [
      section(title),
      ...(renderedMessage ? [section(renderedMessage)] : []),
      ...(replyAsThread ? [] : failureSections.map(section)),
      section(`*Created by:* ${authorName}`),
      section(`\`\`\`${combinedMessages}\`\`\``),
      {
        type: 'actions',
        elements: buttons.map(b => ({
          type: 'button',
          text: {
            type: 'plain_text',
            text: b.text
          },
          style: 'primary',
          url: b.url
        }))
      }
    ]

    if (!useBot) {
      await new IncomingWebhook(webhookUrl).send({
        blocks: messageBlocks,
        username: 'GitHub Actions Bot'
      })
      return
    }

    // `text` is the fallback Slack shows in notifications and screen readers.
    const ts = await postMessage(botToken, { channel, text: title, blocks: messageBlocks })
    if (replyAsThread && failureSections.length) {
      try {
        await postMessage(botToken, {
          channel,
          thread_ts: ts,
          text: failureSections[0],
          blocks: failureSections.map(section)
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        core.warning(`Could not reply with this run's errors (${reason}).`)
      }
    }
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
