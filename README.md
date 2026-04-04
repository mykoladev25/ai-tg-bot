# neuro-lab-ai-bot

Open-source Telegram bot for AI text, image, video, and payment workflows. The project combines Telegram UX, provider integrations, token accounting, checkout flows, and an operator dashboard in one Node.js codebase.

## Features

- Telegram-first UX built on `telegraf`
- Multiple AI provider integrations for text, image, video, and audio workflows
- Token balance, billing, and generation tracking backed by MongoDB
- Stripe, LiqPay, WayForPay, and Telegram Stars payment support
- Admin dashboard for revenue, COGS, pricing checks, and active generation visibility
- Signed Telegram file proxy to avoid exposing the bot token to third-party providers
- Centralized English locale structure with Telegram `language_code` fallback to English

## Screenshots

- Add bot screenshots here before publishing.
- Recommended: main menu, generation flow, payment page, admin dashboard.

## Requirements

- Node.js 20+
- MongoDB 6+ or a compatible hosted MongoDB service
- A Telegram bot token from `@BotFather`
- API keys for the providers you want to enable

## Installation

```bash
git clone <your-repository-url>
cd neuro-lab-ai-bot
npm install
cp .env.example .env
```

Fill in the values in `.env`, then run:

```bash
npm run check
npm run dev
```

For a normal start without `nodemon`:

```bash
npm start
```

## Configuration

The repository now expects secrets to live only in environment variables. Start with `.env.example`.

Important variables:

- `BOT_TOKEN`: Telegram bot token
- `MONGODB_URI`: MongoDB connection string
- `ADMIN_TOKEN`: admin dashboard login token
- `FILE_PROXY_SECRET`: signing secret for Telegram media proxy URLs
- `REPLICATE_API_KEY`, `KIE_AI_API_KEY`, `GOOGLE_GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`: provider credentials
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `LIQPAY_PUBLIC_KEY`, `LIQPAY_PRIVATE_KEY`, `WAYFORPAY_MERCHANT_ACCOUNT`, `WAYFORPAY_MERCHANT_KEY`: payment credentials
- `APP_URL`: public application base URL used for callbacks, public payment pages, and media proxy links

If a provider key is missing, related features should be considered disabled.

## Localization

The public repository is English-only by design.

Locale resolution is centralized in [utils/i18n.js](utils/i18n.js) and currently uses Telegram `language_code` as the best available device/system locale proxy. Unsupported or missing locales fall back to English.

The translation structure is intentionally simple and extensible:

- [locales/en.js](locales/en.js)
- [utils/i18n.js](utils/i18n.js)
- [utils/keyboard.js](utils/keyboard.js)

## Project Structure

```text
admin/        Admin routes and dashboard access control
config/       Model, pricing, and access configuration
database/     MongoDB connection and Mongoose models
monitoring/   Usage logging, reports, and alerting
public/       Checkout pages, admin UI, and public legal placeholders
scripts/      Lightweight repository maintenance scripts
services/     AI providers, pricing sync, and payment integrations
utils/        Shared helpers for keyboards, i18n, shutdown, and file proxying
webhooks/     Payment and provider webhook handlers
index.js      Main bot and HTTP server entrypoint
```

## Security Notes

- Secrets are expected in `.env` only. Do not commit real credentials.
- Admin access uses a login route plus an HTTP-only cookie. Query-token auth has been removed.
- Telegram media shared with providers should flow through the signed file proxy route instead of raw `api.telegram.org/file/bot...` links.
- Read [SECURITY.md](SECURITY.md) before publishing production contact details.

## Development Notes

- Run `npm run check` before opening a PR.
- The repository includes a generic CI workflow at [ci.yml](.github/workflows/ci.yml).
- Public legal pages in `public/terms.html`, `public/privacy.html`, and `public/info.html` are placeholders and should be replaced before live commercial use.

## Contributing

Small, focused changes are preferred. Security-sensitive changes should include a clear explanation of impact, fallback behavior, and any required environment variables.

## License

MIT. See [LICENSE](LICENSE).
