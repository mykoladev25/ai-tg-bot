# Security Policy

## Supported versions

This repository is maintained on the `main` branch. Security fixes are applied there first.

## Reporting a vulnerability

Do not open public GitHub issues for security reports.

Send a private report that includes:

- a clear description of the issue
- affected files or routes
- reproduction steps
- impact assessment
- any suggested mitigation

If the report involves secrets, payment flows, webhook validation, or Telegram bot token handling, rotate the affected credentials immediately after mitigation.

## Scope highlights

Pay special attention to:

- Telegram bot token handling
- signed file proxy routes
- admin authentication and session handling
- payment and webhook verification
- environment variable management
