# Homepage

Personal homepage and auth/billing hub for my app suite. Shares authentication, theming, and the site switcher with the other sites via a common MongoDB database.

## Pages

| Route | Description |
|---|---|
| `/` | Home: intro, projects, experience |
| `/projects` | Project cards pulled from the `websites` collection |
| `/downloads` | GitHub Releases downloads with OS detection |
| `/plans` | Pricing tiers when resources run out, currently disabled |
| `/tutoring` | Tutoring qualifications and Wyzant booking |
| `/login` `/signup` | SSO entry point, accepts `?redirect=URL&app=NAME` for cross-app auth |
| `/logout` | Destroys session and redirects to `/` |

## Setup

```bash
npm install
cp .env.example .env   # fill in your values
node index.js
```

Runs on port `3003` by default (set `PORT` in `.env` to override).

## Environment variables

| Variable | Description |
|---|---|
| `MONGODB_URI` | Atlas URI pointing to the shared database (must match all other apps) |
| `SESSION_SECRET` | Must match the secret used by all other apps for shared sessions |
| `SSO_SECRET` | Signs one-time SSO tokens issued after login/signup |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_…` or `sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_…`) |
| `STRIPE_PRO_PRICE_ID` | Stripe Price ID for the Pro plan |
| `STRIPE_STUDIO_PRICE_ID` | Stripe Price ID for the Studio plan |
| `PORT` | Optional, as it defaults to `3003` |

## SSO flow

Other apps redirect unauthenticated users here with query params:

```
/login?redirect=https://catalogue.example.com/sso&app=Catalogue
```

After a successful login or signup, this app mints a one-time token:

```
base64url({ userId, name, exp: now+60s }) + '.' + HMAC-SHA256(payload, SSO_SECRET)
```

and redirects to `redirect_url?token=TOKEN`. The receiving app verifies the HMAC, checks `exp`, and creates a local session. If the user is already logged in, the token is issued immediately without re-prompting.

## Billing

All Stripe logic lives here. Other apps only read `user.plan`.

| Route | Description |
|---|---|
| `POST /billing/checkout` | Creates a Stripe Checkout session and redirects |
| `POST /billing/cancel` | Cancels the active subscription immediately |
| `POST /billing/webhook` | Stripe webhook, which is registered before `express.json()` |

Webhook events handled:
- `checkout.session.completed`: sets `plan`, `stripeCustomerId`, `stripeSubscriptionId`
- `customer.subscription.deleted`: resets `plan` to `free`, clears `stripeSubscriptionId`

Point your Stripe webhook at `https://yourdomain.com/billing/webhook` with both events selected.

## Shared User schema

Fields written here and read by all apps:

| Field | Type | Notes |
|---|---|---|
| `plan` | `'free' \| 'pro' \| 'studio'` | Default `'free'` |
| `stripeCustomerId` | string | Set on checkout completion |
| `stripeSubscriptionId` | string | Cleared on cancellation |
| `storageUsed` | number (bytes) | Default `0` and incremented via `$inc: { storageUsed: fileSize }` |

## Database

### `websites` collection

| Field | Type | Used by |
|---|---|---|
| `title_color` | hex string | Projects card title color |
| `description` | string | Projects card description |
| `github` | `owner/repo` | Downloads through GitHub Releases |
| `order` | number | Sort order in switcher and Projects |
| `featured` | boolean | Reserved for featured projects |
| `self` | boolean | Marks the Homepage so that it is excluded from Projects, drives the favicon. This is needed so that there is a database entry so it shows up in the page-switcher.|

### `cataloguenotifications` collection

Other apps can write here to surface a notification in Catalogue's inbox:

```js
db.cataloguenotifications.insertOne({
  userId: ObjectId("..."),
  type: "info",           // or "mention", "invite", etc.
  message: "You have a new message.",
  link: "/some/path",
  read: false,
  createdAt: new Date()
})
```

### Insert this site into the switcher

```js
db.websites.insertOne({
  site_name: "Homepage",
  link: "localhost:3003",
  icon: "person-outline",
  color: "#8C88F3",
  self: true,
  order: 0
})
```
