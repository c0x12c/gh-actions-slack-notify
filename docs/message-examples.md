# `message` examples

The `message` input renders as a Block Kit `mrkdwn` section beneath the title. It is optional -
omit it and the payload is exactly what this action posted before the input existed.

Slack truncates long messages, so the body is capped at 2500 characters. Anything longer is cut
and ` ... [truncated]` appended, with the suffix counted inside the cap.

## Static messages

### Title only (unchanged behaviour)

```yaml
- uses: c0x12c/gh-actions-slack-notify@v1
  with:
    webhook_url: ${{ secrets.SLACK_WEBHOOK_URL }}
    title: '✅ *my-service - Deploy SUCCESS in prod*'
```

> ✅ **my-service - Deploy SUCCESS in prod**

### Short body

```yaml
- uses: c0x12c/gh-actions-slack-notify@v1
  with:
    webhook_url: ${{ secrets.SLACK_WEBHOOK_URL }}
    title: '⚠️ *my-service - Nightly job degraded*'
    message: '3 of 12 shards timed out. Retry scheduled for 02:00 UTC.'
```

> ⚠️ **my-service - Nightly job degraded**
>
> 3 of 12 shards timed out. Retry scheduled for 02:00 UTC.

## Dynamic messages from an earlier step

This is the case the input was added for: a step fails, and the alert should carry the reason
rather than only a link to the run.

### The mechanics

A step exposes text through `$GITHUB_OUTPUT`, and a later step reads it as
`steps.<id>.outputs.<name>`. Multi-line values need heredoc syntax - a bare `name=value` only
carries a single line:

```yaml
- name: Produce a body
  id: detail
  run: |
    {
      echo 'text<<GH_EOF'
      cat /tmp/some-output.log
      echo 'GH_EOF'
    } >> "$GITHUB_OUTPUT"
```

Pick a delimiter that cannot appear in the content. `GH_EOF` is fine for command output; if the
content is arbitrary user input, generate a random delimiter instead.

### Terraform apply failure

Capture the output while still letting the step fail. `tee` lets a later step read it, and
`PIPESTATUS[0]` preserves terraform's own exit code rather than `tee`'s:

```yaml
- name: Terraform Apply
  id: tf_apply
  shell: bash
  run: |
    set +e
    terraform apply -input=false -auto-approve -no-color 2>&1 | tee /tmp/apply.log
    exit "${PIPESTATUS[0]}"

- name: Extract the error
  id: tf_error
  if: failure()
  shell: bash
  run: |
    # Keep from the first error marker onward - the leading output is init and refresh noise.
    detail=$(awk '/^(│ )?Error: /{found=1} found' /tmp/apply.log | head -c 2000)
    [ -n "$detail" ] || detail=$(tail -c 2000 /tmp/apply.log)
    {
      echo 'text<<GH_EOF'
      echo '```'
      echo "$detail"
      echo '```'
      echo 'GH_EOF'
    } >> "$GITHUB_OUTPUT"

- name: Notify Slack on failure
  if: failure()
  uses: c0x12c/gh-actions-slack-notify@v1
  with:
    webhook_url: ${{ secrets.SLACK_WEBHOOK_URL }}
    title: '❌ *${{ github.event.repository.name }} - Terraform Apply FAILED in ${{ inputs.environment }}*'
    message: ${{ steps.tf_error.outputs.text }}
```

Produces:

> ❌ **infra - Terraform Apply FAILED in staging**
>
> ```
> Error: Error acquiring the state lock
>
> Error message: operation error S3: PutObject, https response error
> StatusCode: 412, api error PreconditionFailed
> Lock Info:
>   ID:        7505ff32-7744-085f-8984-8154170942f3
>   Path:      my-tfstate-staging/live-workloads-staging.tfstate
>   Operation: OperationTypeApply
>   Who:       someone@their-machine.local
> ```

Pass `-no-color`. Terraform's ANSI codes both defeat a `^Error:` style anchor and render as
garbage in Slack.

### Test failures

```yaml
- name: Test
  id: test
  run: |
    set +e
    npm test 2>&1 | tee /tmp/test.log
    exit "${PIPESTATUS[0]}"

- name: Summarise failures
  id: failures
  if: failure()
  run: |
    {
      echo 'text<<GH_EOF'
      echo '```'
      grep -E '^\s+(✕|✗|FAIL)' /tmp/test.log | head -20
      echo '```'
      echo 'GH_EOF'
    } >> "$GITHUB_OUTPUT"
```

### Deployed-image summary on success

Bodies are not only for failures:

```yaml
- name: Notify Slack
  if: success()
  uses: c0x12c/gh-actions-slack-notify@v1
  with:
    webhook_url: ${{ secrets.SLACK_WEBHOOK_URL }}
    title: '✅ *${{ github.event.repository.name }} - Deployed to prod*'
    message: |
      *Image:* `${{ steps.build.outputs.image_tag }}`
      *Commit:* `${{ github.sha }}`
      *Rollout:* ${{ steps.rollout.outputs.duration }}
```

## Gotchas

**Wrap machine output in a code fence.** The body is `mrkdwn`, so Slack interprets `*`, `_` and
backticks. A stack trace containing `*` will render as bold and swallow text. A triple-backtick
fence, as in the examples above, avoids it.

**Do not interpolate untrusted text into a `run:` block.** `${{ }}` is substituted into the script
before bash sees it, so content containing backticks or `$(...)` executes. Pass it through `env:`
instead:

```yaml
- run: |
    printf '%s' "$BODY" >> /tmp/body.txt
  env:
    BODY: ${{ steps.detail.outputs.text }}
```

Passing `${{ steps.x.outputs.y }}` straight into the action's `message:` input is safe - it is a
value handed to the action, not shell source.

**Long bodies are cut at 2500 characters.** For anything larger, link the run and put only the
first error in the message. The run URL is
`${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}`.

**An empty `message` adds no section**, so a conditional body is safe - when the expression
resolves to an empty string the alert renders exactly as a title-only one.
