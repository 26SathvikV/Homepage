// ── Imports ───────────────────────────────────────────────────────────────────
require('dotenv').config();
const express    = require('express');
const mongoose   = require('mongoose');
const session    = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt     = require('bcrypt');
const ejs        = require('ejs');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);

// TLS compatibility for Node 18 + MongoDB Atlas
require('tls').DEFAULT_MIN_VERSION = 'TLSv1.2';

mongoose.connect(process.env.MONGODB_URI, { tls: true, tlsInsecure: true });

// ── Models ────────────────────────────────────────────────────────────────────

const User = mongoose.model('User', new mongoose.Schema({
    name:                 String,
    email:                String,
    password:             String,
    plan:                 { type: String, enum: ['free', 'pro', 'studio'], default: 'free' },
    stripeCustomerId:     String,
    stripeSubscriptionId: String,
    storageUsed:          { type: Number, default: 0 },
    betaTester:           { type: Boolean, default: false }
}));

// Shared notification inbox, schema must match Catalogue's
const CatalogueNotification = mongoose.model('CatalogueNotification', new mongoose.Schema({
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type:      { type: String, default: 'info' },
    message:   String,
    link:      String,
    read:      { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
}), 'cataloguenotifications');

const Website = mongoose.model('Website', new mongoose.Schema({
    site_name:   String,
    link:        String,
    icon:        String,
    color:       String,
    title_color: String,
    description: String,
    github:      String,
    order:       { type: Number, default: 0 },
    featured:    { type: Boolean, default: false },
    self:        Boolean,
    visible:     { type: Boolean, default: true },
    hide_monetization: { type: Boolean, default: false },
    beta:        { type: Boolean, default: false }
}), 'websites');

// ── App setup ─────────────────────────────────────────────────────────────────

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// ── Billing webhook: MUST BE BEFORE express.json() ──────────────────-─────────
// Stripe requires the raw body to verify the signature; express.json() would
// replace req.body with a parsed object before constructEvent can read it.

app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const s = event.data.object;
        if (s.metadata?.userId) {
            await User.findByIdAndUpdate(s.metadata.userId, {
                plan:                 s.metadata.plan,
                stripeCustomerId:     s.customer,
                stripeSubscriptionId: s.subscription
            });
        }
    } else if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        await User.findOneAndUpdate(
            { stripeSubscriptionId: sub.id },
            { plan: 'free', stripeSubscriptionId: null }
        );
    }

    res.json({ received: true });
});

app.use(express.json());
app.disable('x-powered-by');

app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

// Render an EJS template from the views/pages directory with the given locals
async function render(name, locals = {}) {
    const filePath = path.join(__dirname, 'views', 'pages', `${name}.ejs`);
    const src = await fs.promises.readFile(filePath, 'utf8');
    return ejs.render(src, locals, { filename: filePath });
}

// Cache site info for 60 seconds to avoid hitting the database on every request
let _siteInfoCache = null;
let _siteInfoExpiry = 0;

// Get site info (icon, color, monetization visibility) from the database
async function getSiteInfo() {
    if (_siteInfoCache && Date.now() < _siteInfoExpiry) return _siteInfoCache;
    const site = await Website.findOne({ self: true }).lean();
    _siteInfoCache = {
        siteIcon:           site?.icon  || 'person-outline',
        siteColor:          site?.color || '#8C88F3',
        monetizationHidden: !!(site && site.hide_monetization)
    };
    _siteInfoExpiry = Date.now() + 60_000;
    return _siteInfoCache;
}

// Cache visible websites for 60 seconds to avoid hitting the database on every request
let _visibleWebsitesCache = null;
let _visibleWebsitesExpiry = 0;

// Get visible websites (not hidden) from the database, sorted by order
async function getVisibleWebsites() {
    if (_visibleWebsitesCache && Date.now() < _visibleWebsitesExpiry) return _visibleWebsitesCache;
    _visibleWebsitesCache = await Website.find({ visible: { $ne: false } }).sort({ order: 1 }).lean();
    _visibleWebsitesExpiry = Date.now() + 60_000;
    return _visibleWebsitesCache;
}

// Cache in-progress websites (not self, not visible) for 60 seconds to avoid hitting the database on every request
let _inProgressWebsitesCache = null;
let _inProgressWebsitesExpiry = 0;

// Get in-progress websites (not self, not visible) from the database, sorted by order
async function getInProgressWebsites() {
    if (_inProgressWebsitesCache && Date.now() < _inProgressWebsitesExpiry) return _inProgressWebsitesCache;
    _inProgressWebsitesCache = await Website.find({ self: { $ne: true }, visible: false }).sort({ order: 1 }).lean();
    _inProgressWebsitesExpiry = Date.now() + 60_000;
    return _inProgressWebsitesCache;
}

// Render a page with the standard layout, including site info and body content
async function renderPage(res, pageName, locals = {}) {
    const siteInfo = await getSiteInfo();
    const body = await render(pageName, locals);
    res.render('standard/page', { ...locals, ...siteInfo, body });
}


// Detect the user's operating system from the User-Agent string
function detectOS(ua = '') {
    if (/Windows/i.test(ua)) return 'windows';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
    if (/Linux/i.test(ua)) return 'linux';
    return 'unknown';
}

// Mint a one-time SSO token: base64url(payload) + '.' + HMAC-SHA256(payload, SSO_SECRET)
// Other apps verify with the same SSO_SECRET, and the token expires after 60 seconds.
function mintSSOToken(userId, name) {
    const payload = Buffer.from(JSON.stringify({
        userId,
        name,
        exp: Date.now() + 60_000
    })).toString('base64url');
    const sig = crypto
        .createHmac('sha256', process.env.SSO_SECRET || 'dev-sso-secret')
        .update(payload)
        .digest('base64url');
    return `${payload}.${sig}`;
}

// Only redirect to http/https URLs; blocks javascript: and data: schemes.
function isSafeRedirect(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

// Redirect to another app with a one-time SSO token appended as a query parameter
function ssoRedirect(res, redirectUrl, userId, name) {
    const token = mintSSOToken(userId, name);
    const sep   = redirectUrl.includes('?') ? '&' : '?';
    return res.redirect(`${redirectUrl}${sep}token=${encodeURIComponent(token)}`);
}

// ── Public routes ─────────────────────────────────────────────────────────────


// Home page
app.get('/', async (req, res) => {
    await renderPage(res, 'home', { loggedIn: !!req.session.userId, pageTitle: 'Home' });
});

// Projects page
app.get('/projects', async (req, res) => {
    await renderPage(res, 'projects', { loggedIn: !!req.session.userId, pageTitle: 'Projects' });
});

// Tutoring page
app.get('/tutoring', async (req, res) => {
    await renderPage(res, 'tutoring', { loggedIn: !!req.session.userId, pageTitle: 'Tutoring' });
});

// Plans page (only if monetization is not hidden, which it currently is due to lack of necessity for monetization)
app.get('/plans', async (req, res, next) => {
    const { monetizationHidden } = await getSiteInfo();
    if (monetizationHidden) return next(); // falls through to the 404 handler if the route looks nonexistent
    const sites = await getVisibleWebsites();
    const visibleSiteNames = new Set(sites.map(s => s.site_name));
    await renderPage(res, 'plans', { loggedIn: !!req.session.userId, pageTitle: 'Plans', monetizationHidden, visibleSiteNames });
});

// Downloads page
app.get('/downloads', async (req, res) => {
    const detectedOS = detectOS(req.headers['user-agent']);
    await renderPage(res, 'downloads', { loggedIn: !!req.session.userId, pageTitle: 'Downloads', detectedOS });
});

// ── Auth routes ───────────────────────────────────────────────────────────────

// Login page
app.get('/login', async (req, res) => {
    const redirect = req.query.redirect || '';
    const appName  = req.query.app      || '';

    // If already logged in, issue token immediately if a redirect is waiting
    if (req.session.userId) {
        if (redirect && isSafeRedirect(redirect)) {
            const user = await User.findById(req.session.userId).select('name');
            return ssoRedirect(res, redirect, req.session.userId, user?.name || '');
        }
        return res.redirect('/');
    }

    res.render('signup/login', { error: null, redirect, appName });
});

// Handle login form submission
app.post('/login', async (req, res) => {
    const { email, pass, redirect, app: appName } = req.body;

    if (!email || !pass)  // Check for missing fields
        return res.render('signup/login', { error: 'Email and password required.', redirect: redirect || '', appName: appName || '' });

    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user || !await bcrypt.compare(pass, user.password)) // Check for invalid credentials
        return res.render('signup/login', { error: 'Invalid email or password.', redirect: redirect || '', appName: appName || '' });

    req.session.userId = user._id.toString();

    if (redirect && isSafeRedirect(redirect)) // If a redirect is specified, issue a one-time SSO token and redirect to the other app
        return ssoRedirect(res, redirect, user._id.toString(), user.name || '');

    res.redirect('/');
});

// Signup page
app.get('/signup', (req, res) => {
    const redirect = req.query.redirect || '';
    const appName  = req.query.app      || '';

    if (req.session.userId) {
        if (redirect && isSafeRedirect(redirect)) {
            // If already logged in, skip straight to SSO redirect (resolved async below)
            return res.redirect(`/login?redirect=${encodeURIComponent(redirect)}&app=${encodeURIComponent(appName)}`);
        }
        return res.redirect('/');
    }

    res.render('signup/signup', { error: null, redirect, appName });
});

// Handle signup form submission
app.post('/signup', async (req, res) => {
    const { name, email, pass, pass2, redirect, app: appName } = req.body;

    if (!name || !email || !pass || !pass2)  // Check for missing fields
        return res.render('signup/signup', { error: 'All fields are required.', redirect: redirect || '', appName: appName || '' });
    if (pass !== pass2)  // Check for password mismatch
        return res.render('signup/signup', { error: 'Passwords do not match.', redirect: redirect || '', appName: appName || '' });
    if (pass.length < 8)  // Check for password length
        return res.render('signup/signup', { error: 'Password must be at least 8 characters.', redirect: redirect || '', appName: appName || '' });
    if (email.length > 254 || pass.length > 72)  // Check for excessively long input (MongoDB limits)
        return res.render('signup/signup', { error: 'Input too long.', redirect: redirect || '', appName: appName || '' });

    // Check if an account with that email already exists
    const exists = await User.findOne({ email: email.trim().toLowerCase() });
    if (exists)
        return res.render('signup/signup', { error: 'An account with that email already exists.', redirect: redirect || '', appName: appName || '' });

    // Create the new user account
    const hash    = await bcrypt.hash(pass, 10);
    const newUser = await User.create({ name: name.trim().slice(0, 100), email: email.trim().toLowerCase(), password: hash });

    req.session.userId = newUser._id.toString();

    if (redirect && isSafeRedirect(redirect))
        return ssoRedirect(res, redirect, newUser._id.toString(), newUser.name || '');

    res.redirect('/');
});

// Handle logout
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// ── Admin ─────────────────────────────────────────────────────────────────────
// Internal-only tool for granting beta access without touching Mongo by hand.
// Gated by ADMIN_PASSWORD (not a user account) since it has no relation to the
// per-app user session.

// Timing-safe string comparison to prevent timing attacks on the admin password
function safeEqual(a, b) {
    const bufA = Buffer.from(String(a || ''));
    const bufB = Buffer.from(String(b || ''));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// Middleware to require admin access for certain routes
function requireAdmin(req, res, next) {
    if (req.session.isAdmin) return next();
    res.redirect('/admin');
}

// Admin dashboard
app.get('/admin', async (req, res) => {
    if (!req.session.isAdmin) return res.render('admin/login', { error: null });

    // Fetch all non-self websites and beta testers in parallel
    const [sites, testers] = await Promise.all([
        Website.find({ self: { $ne: true } }, 'site_name beta').sort({ site_name: 1 }).lean(),
        User.find({ betaTester: true }, 'name email').sort({ email: 1 }).lean()
    ]);

    res.render('admin/dashboard', {
        sites, testers,
        error:   req.query.error   || null,
        success: req.query.success || null
    });
});

// Handle admin login form submission
app.post('/admin/login', (req, res) => {
    if (process.env.ADMIN_PASSWORD && safeEqual(req.body.password, process.env.ADMIN_PASSWORD)) {
        req.session.isAdmin = true;
        return res.redirect('/admin');
    }
    res.render('admin/login', { error: 'Incorrect password.' });
});

// Handle admin logout
app.get('/admin/logout', (req, res) => {
    req.session.isAdmin = false;
    res.redirect('/admin');
});

// Handle granting beta tester status to a user by email
app.post('/admin/beta-tester', requireAdmin, async (req, res) => {
    const { email } = req.body;
    if (!email)
        return res.redirect('/admin?error=' + encodeURIComponent('Email is required.'));

    const user = await User.findOneAndUpdate(
        { email: email.trim().toLowerCase() },
        { betaTester: true }
    );
    if (!user)
        return res.redirect('/admin?error=' + encodeURIComponent('No account found for that email.'));

    res.redirect('/admin?success=' + encodeURIComponent(`Granted beta tester status to ${user.email}.`));
});

// Handle revoking beta tester status from a user by ID
app.post('/admin/beta-tester/:id/revoke', requireAdmin, async (req, res) => {
    await User.findByIdAndUpdate(req.params.id, { betaTester: false });
    res.redirect('/admin');
});


// Handle toggling the beta status of a website by ID
app.post('/admin/website-beta/:id/toggle', requireAdmin, async (req, res) => {
    const site = await Website.findById(req.params.id);
    if (site) {
        site.beta = !site.beta;
        await site.save();
        _visibleWebsitesCache = null;
        _inProgressWebsitesCache = null;
    }
    res.redirect('/admin');
});

// ── Billing ───────────────────────────────────────────────────────────────────

// Handle checkout for a subscription plan
app.post('/billing/checkout', async (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    const { monetizationHidden } = await getSiteInfo();
    if (monetizationHidden) return next(); // falls through to the 404 handler if the route looks nonexistent

    // Determine the Stripe price ID based on the selected plan
    const { plan } = req.body;
    const priceId = plan === 'pro'    ? process.env.STRIPE_PRO_PRICE_ID
                  : plan === 'studio' ? process.env.STRIPE_STUDIO_PRICE_ID
                  : null;
    if (!priceId) return res.status(400).send('Invalid plan');

    const user   = await User.findById(req.session.userId);
    const origin = req.protocol + '://' + req.get('host');

    // Create a Stripe Checkout session for the subscription plan, including user email and metadata for tracking
    const checkoutSession = await stripe.checkout.sessions.create({
        mode:         'subscription',
        line_items:   [{ price: priceId, quantity: 1 }],
        customer_email: user.email,
        metadata:     { userId: user._id.toString(), plan },
        success_url:  `${origin}/plans?upgraded=1`,
        cancel_url:   `${origin}/plans`,
    });

    res.redirect(303, checkoutSession.url);
});

// Handle subscription cancellation
app.post('/billing/cancel', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });

    const user = await User.findById(req.session.userId);
    if (!user?.stripeSubscriptionId)
        return res.status(400).json({ error: 'No active subscription' });

    // Cancel the plan by the customer.subscription.deleted webhook, which resets plan to free
    await stripe.subscriptions.cancel(user.stripeSubscriptionId);

    res.json({ ok: true });
});

// ── API ───────────────────────────────────────────────────────────────────────

// Get site info (icon, color) for the frontend
app.get('/api/self', async (req, res) => {
    const info = await getSiteInfo();
    res.json({ icon: info.siteIcon, color: info.siteColor });
});

// Get visible websites (not hidden) for the frontend, only if the user is logged in
app.get('/api/websites', async (req, res) => {
    if (!req.session.userId) return res.status(401).json([]);
    const sites = await getVisibleWebsites();
    res.json(sites.map(({ site_name, link, icon, color }) => ({ site_name, link, icon, color })));
});

// Get visible projects (not hidden, not self) for the frontend
app.get('/api/projects', async (req, res) => {
    const sites = await getVisibleWebsites();
    res.json(sites
        .filter(s => !s.self)
        .map(({ site_name, title_color, link, icon, color, description, featured, order }) =>
            ({ site_name, title_color, link, icon, color, description, featured, order })));
});

// Get in-progress projects (not self, not visible) for the frontend
app.get('/api/projects/in-progress', async (req, res) => {
    const sites = await getInProgressWebsites();
    res.json(sites.map(({ site_name, title_color, link, icon, color, description }) =>
        ({ site_name, title_color, link, icon, color, description })));
});

// Get downloadable projects (with GitHub links) for the frontend
app.get('/api/downloads', async (req, res) => {
    const sites = await getVisibleWebsites();
    res.json(sites
        .filter(s => s.github)
        .map(({ site_name, icon, color, github, description, link }) => ({ site_name, icon, color, github, description, link })));
});

// Get the latest GitHub release for a given owner/repo, with caching for 10 minutes
const releasesCache = new Map();

app.get('/api/releases/:owner/:repo', async (req, res) => {
    const key    = `${req.params.owner}/${req.params.repo}`;
    const cached = releasesCache.get(key);
    if (cached && Date.now() < cached.expiry) return res.json(cached.data);
    try {
        const resp = await fetch(`https://api.github.com/repos/${key}/releases/latest`, {
            headers: { 'User-Agent': 'SathvikHomepage/1.0', Accept: 'application/vnd.github+json' }
        });
        if (!resp.ok) return res.json(null);
        const data = await resp.json();
        releasesCache.set(key, { data, expiry: Date.now() + 10 * 60_000 });
        res.json(data);
    } catch {
        res.json(null);
    }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3003;

async function start() {
    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI is not set. Check your .env file.');
        process.exit(1);
    }
    try {
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
        console.log('MongoDB connected');
        app.listen(PORT, () => console.log(`Homepage running → http://localhost:${PORT}`));
    } catch (err) {
        console.error('MongoDB connection failed:', err.message);
        process.exit(1);
    }
}
start();