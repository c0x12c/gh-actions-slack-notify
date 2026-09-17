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
    const webhookUrl = core.getInput('webhook_url') as string
    const webhook = new IncomingWebhook(webhookUrl)

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
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: title
        }
      },
      ...(renderedMessage
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: renderedMessage
              }
            }
          ]
        : []),
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Created by:* ${authorName}`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `\`\`\`${combinedMessages}\`\`\``
        }
      },
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

    await webhook.send({
      blocks: messageBlocks,
      username: 'GitHub Actions Bot'
    })
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
