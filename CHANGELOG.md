# Changelog

## 0.2.0

- First stable release, including the beta-2 TypeScript page server and bundled UI.
- Security: restore fail-closed API authentication when OPEN_BOT_PAGE_TOKEN is unset or empty; the beta-2 migration had regressed this protection.
- Security: remove the loopback bypass accepting the known `dev-preview` header instead of the configured page token.
- Preserve HTML escaping of all OAuth callback messages introduced in beta-1.
- Add an isolated source/frozen-layout security regression harness and configuration guide.

## beta-2

- Extract the dashboard into index.html, app.ts and styles.css with bundled UI support.
- Migrate the page server to TypeScript and add health, theme and contrast checks.

## beta-1

- OAuth support for GitHub, Google and Slack.
- Escape OAuth callback HTML and fail closed when the page token is missing.
