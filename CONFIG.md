# Configure API Connectors

Ask which provider and authentication method the user wants. Do not request secrets
in chat: the user fills Plugins → API Connectors → Settings → Vault keys, or the
Connexions dashboard. Configure only the selected provider; others may stay empty.

## Settings

- `enabled` (default true): enables API calls.
- `timeout_ms` (default 20000, range 1000–120000): request timeout.
- `log_calls` (default true): records call metadata, never credentials.

Set these with `ob-plugin settings api-connectors KEY=VALUE`.

## Keys and OAuth

- GitHub personal token: `github-token`, from GitHub Settings → Developer settings
  → Personal access tokens. Grant only the repository permissions needed.
  For device OAuth instead, register an OAuth App with device flow enabled and
  set `github-client-id`. Connect from Connexions; the plugin stores the result in
  `github-oauth-token`.
- Google API key: `google-api-key`, from Google Cloud Console → APIs & Services
  → Credentials; enable only required APIs and restrict the key appropriately.
  For OAuth, create a web application client, set `google-client-id` and
  `google-client-secret`, and register the redirect URL shown by Connexions.
  Complete the provider consent flow yourself; `google-refresh-token` is written
  by the plugin. Never copy a token into a report or chat.
- Slack bot token: `slack-bot-token`, from the Slack app's OAuth & Permissions
  page after installation to the intended workspace with minimum required scopes.
  For OAuth instead, set `slack-client-id` and `slack-client-secret` from the app's
  Basic Information page and register the redirect URL shown by Connexions.
  The plugin stores the consent result in `slack-oauth-token`.

These eleven slugs are owned vault entries. `ob-plugin vault api-connectors`
reports presence only. Authorized automation may write an owned slug with
`ob-plugin vault api-connectors SLUG=value`, but never print or log its value.

## Verify

Run `ob-plugin-api-connectors-status`, then use **Tester** on the selected provider
in Connexions. An unconfigured provider must return a missing-key message, not a
crash. On 401 replace/reconnect the credential; on 403 check scopes and quotas.
Do not perform a write API call merely to verify installation.

The control plane supplies `OPEN_BOT_PAGE_TOKEN`. Missing or empty tokens deny all
API requests. For development, supply a synthetic nonempty token and send its exact
value in `x-open-bot-page-token`; there is no loopback or preview-header bypass.
`/healthz` and the static UI remain public, but do not expose provider data.

## Maintainer regression tests

`bun scripts/security-test.ts` creates its own servers, synthetic configuration,
HOME and mutation CLI stub. It checks missing/empty/wrong/preview headers,
authenticated reads, callback escaping, and the frozen UI without using real vault
data. It stops its children and removes only its own temporary directory.
