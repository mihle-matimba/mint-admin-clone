# Mint CRM Admin Portal

## Overview
Internal admin dashboard for the Mint investment platform. Provides client management, KYC verification, investment strategy configuration, and order book reporting.

## Architecture
- **Backend**: Node.js with native `http` module (`server.js`)
- **Frontend**: Static HTML/JS with Tailwind CSS (served from `public/`)
- **Database**: Supabase (PostgreSQL)
- **Services**: Resend (email), Sumsub (KYC)
- **Deployment target**: Vercel (serverless functions in `api/`)

## Key Pages
- `/signin.html` - Admin login (Supabase Auth)
- `/index.html` - Client profiles / CRM
- `/dashboard.html` - Main dashboard with three tabs: Overview, Strategies, Factsheets
- `/orderbook.html` - Order book email runs
- `/strategies.html` - Standalone strategies page (legacy, content now in dashboard)
- `/factsheet.html` - Standalone factsheet page (legacy, content now in dashboard)

## Dashboard Tabs
### Overview Tab
- Strategy chart visualization, user stats (total, KYC, bank linked), featured strategies, top performing holdings, all strategies list

### Strategies Tab
- **Create Strategy form** with holdings builder (search securities from DB, add with shares)
- **Auto-calculated fields**: target weight (based on market value proportions), minimum investment (sum of shares * price)
- **Strategy cards** with holdings preview logos, badges (public/featured/active), risk level, click to open detail modal
- **Detail modal** shows full holdings breakdown with shares, market value, weight, daily change
- **Filters**: search, risk level, visibility (public/featured/active), sort (newest/name/holdings count)
- Strategies saved with `status: 'active'` and warns if `is_public` not checked

### Factsheets Tab
- Grid of strategy cards to select from
- Inline factsheet view matching Mint platform layout: header with badges, daily change marquee, performance summary, strategy description, portfolio holdings table, calendar returns grid, fees & details section

## Strategies Feature
- Holdings stored as JSON array: `[{symbol, ticker, name, shares, quantity, weight}]`
- Minimum investment = sum of (shares * last_price/100) for each holding
- Target weight = (holding_market_value / total_market_value) * 100
- Strategies need `status: 'active'` AND `is_public: true` to appear on Mint's OpenStrategies page
- Missing price data triggers a warning on save

## Database Tables Used
- `profiles` - Client profiles
- `strategies` - Investment strategies with holdings JSON column
- `strategy_analytics` - Performance analytics (summary, curves, calendar_returns)
- `strategy_metrics` - Daily metrics (last_close, change_pct, returns)
- `securities` - Securities with symbol, name, logo_url, last_price, change_percent
- `stock_holdings` - Client stock holdings
- `user_onboarding` - KYC status tracking
- `user_onboarding_pack_details` - Onboarding pack details
- `orderbook_email_runs` - Email report history

## Environment Variables Required
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` - Database access
- `RESEND_API_KEY` - Email sending
- `SUMSUB_APP_TOKEN` / `SUMSUB_APP_SECRET` - KYC verification
- `ORDERBOOK_EMAIL_FROM` / `ORDERBOOK_EMAIL_TO` - Report emails
- `CRON_SECRET` - Cron endpoint protection
- `PORT` - Server port (set to 5000)

## Linked App
Connected to the Mint client-facing investment platform which shares the same Supabase backend. Strategies created here appear in Mint's OpenStrategies page when `status: 'active'` and `is_public: true`.
