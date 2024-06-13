import * as core from '@actions/core'
import * as github from '@actions/github'
import { IncomingWebhook } from '@slack/webhook'
import { simpleGit as SimpleGit } from 'simple-git'

const simpleGit = SimpleGit()

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const title = core.getInput('title') as string
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

    const repo = github.context.repo
    const pipelineUrl = `${github.context.serverUrl}/${repo}/actions/runs/${github.context.runId}`
    core.debug(`Pipeline URL: ${pipelineUrl}`)

    const buttons = [
      {
        text: 'View Commit',
        url: `${repo}/commit/${revision}`
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

    const messageBlocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: title
        }
      },
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
