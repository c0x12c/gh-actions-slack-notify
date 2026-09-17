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

Every message carries a _View Commit_ and a _View Pipeline_ button. `buttons` appends your own, as a
JSON array of `{"text", "url"}` objects:

```yaml
with:
  webhook_url: ${{ secrets.SLACK_WEBHOOK_URL }}
  title: ':pause_button: *Apply awaiting approval*'
  buttons: |
    [
      {"text": "View Issue", "url": "${{ steps.find_issue.outputs.issue_url }}"},
      {"text": "Runbook", "url": "https://wiki.example.com/terraform-apply"}
    ]
```

An entry is skipped with a warning if it is missing `text` or `url`, or if its `url` is not an
absolute `http`/`https` one under 3000 characters - so a step output that came back empty, or as
`none`, costs you that button rather than the notification. Labels are truncated at 75 characters
and the row is capped at 25 buttons; Slack rejects the whole payload past either limit. Input that
is not a JSON array at all drops every extra button, again with a warning.

`project_url` predates this and still renders a single _View Project_ button after the built-in
ones. `buttons` covers the same ground with a label you choose - prefer it for anything new.
