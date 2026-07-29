# gh-actions-slack-notify

The project structure is based on the
[actions/typescript-action](https://github.com/actions/typescript-action/) project

Uses @slack/webhook to send a notification to a Slack channel when running CI/CD for our company
projects. The notification template is predefined for now and will be enhanced to support dynamic
templates in the future.

## Usage

```yaml
jobs:
  some_job:
    runs-on: ubuntu-latest
    steps:
      - name: Send Notification to Slack
        uses: c0x12c/gh-actions-slack-notify@v0.1.3
        with:
          webhook_url: ${{ secrets.SLACK_WEBHOOK_URL }}
          title: ':rocket: *${{ github.event.repository.name }} - Finish processing in DEV*'
```

`message` is optional and renders as a separate Slack body section beneath the title. Empty or
whitespace-only values are ignored.

`message_format` controls how that body renders - `mrkdwn` (default) passes it through, `code` wraps
it in a code block. Prefer `code` over fencing the value yourself: Slack closes a code block at the
first fence terminator, so a ` ``` ` occurring in the text would end the block early and let the
rest render as mrkdwn. Under `code` the action escapes those for you and keeps the fence inside the
character cap.

```yaml
with:
  webhook_url: ${{ secrets.SLACK_WEBHOOK_URL }}
  title: ':rotating_light: *Deploy failed*'
  message: ${{ steps.deploy.outputs.error }}
  message_format: 'code'
```
