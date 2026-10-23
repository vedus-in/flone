# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: [Report a vulnerability](https://github.com/thevedus/flone/security/advisories/new). Include what you found, how to reproduce it, and what an attacker could do with it.

You should get a reply within a few days. Once a fix is released, you will be credited in the advisory unless you would rather not be.

## Scope

Things that matter most here:

- One organization reading or changing another organization's data
- Bypassing authentication, email confirmation, or invitation binding
- Session, password-reset or one-time-token weaknesses
- Access to attachments without access to their project
- Anything that lets a request reach `/api/mcp`, `/api/attachments` or `/api/cron/reminders` without valid credentials

The [Security notes](README.md#security-notes) in the README describe what is implemented and what is deliberately not, such as in-process rate limiting and a CSP that is not nonce-based. Those known limitations are not vulnerabilities by themselves, but a way to exploit them is worth reporting.

## Supported versions

Only the latest commit on `main` is supported. Self-hosted instances should stay up to date with it.
