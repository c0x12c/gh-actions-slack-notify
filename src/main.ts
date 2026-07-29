import * as core from '@actions/core'
import * as github from '@actions/github'
import { IncomingWebhook } from '@slack/webhook'
import { simpleGit as SimpleGit } from 'simple-git'

const simpleGit = SimpleGit()
const MAX_MESSAGE_LENGTH = 2500
const TRUNCATION_SUFFIX = ' ... [truncated]'
const FENCE = '```'

/** Cap the length, marking the cut so a truncated body does not read as a complete one. */
function truncate(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`
    : text
}

/**
 * Render the message body for Slack.
 *
 * `code` wraps it in a fence, which is why the escaping lives here rather than in each caller:
 * Slack closes a code block at the first fence terminator, so one occurring in the body would end
 * the block early and let whatever followed render as mrkdwn.
 */
export function renderMessage(raw: string, format: string): string {
  const body = raw.trim()
  if (!body || format !== 'code') return truncate(body, MAX_MESSAGE_LENGTH)

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

    webhook.send({
      blocks: messageBlocks,
      username: 'GitHub Actions Bot'
    })
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
