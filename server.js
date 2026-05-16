const express = require('express');
// Trigger restart - v6 - sqlite cloud
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const { db, initDb, seedData } = require('./database/init');

const app = express();
const PORT = process.env.PORT || 3000;

// Render/other hosts terminate HTTPS before requests reach Express.
// Trusting the first proxy lets secure session cookies work correctly there.
app.set('trust proxy', 1);

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Smart Fallback for missing Uploads (Legacy Data Resilience)
const fs = require('fs');
app.use('/uploads', (req, res, next) => {
    const filePath = path.join(__dirname, 'public/uploads', req.path);
    if (!fs.existsSync(filePath)) {
        const type = req.path.split('/')[1];
        const fallbacks = {
            'profiles': 'https://ui-avatars.com/api/?name=User&background=6f4e37&color=fff',
            'menu': 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&q=60&w=400',
            'promos': 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&q=60&w=800',
            'ids': 'https://ui-avatars.com/api/?name=ID&background=999&color=fff'
        };
        return res.redirect(fallbacks[type] || fallbacks['menu']);
    }
    next();
});

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production' && process.env.BASE_URL.startsWith('https'),
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 // 24 hours
    }
}));

// Helper to pass common data to all views
// Moved to server.js for global access

// Global User Middleware
app.use(async (req, res, next) => {
    res.locals.user = null;
    res.locals.isVerifiedInSession = req.session.isVerifiedInSession || false;
    res.locals.canUpdateID = req.session.canUpdateID || false;
    
    if (req.session && req.session.userId) {
        console.log(`[SESSION] User ${req.session.userId} | Verified this session: ${res.locals.isVerifiedInSession}`);
        try {
            res.locals.user = await db.prepare(`SELECT id, username, email, pending_email, role, is_senior, is_pwd, is_verified, id_verification_status, id_verification_notes, id_verification_message, profile_image, selfie_image, id_number, verified_by, verified_at FROM users WHERE id = ?`).get(req.session.userId);
        } catch (e) {
            console.error("Session User Middleware Error:", e);
        }
    }
    next();
});

// Enforce Email Verification Middleware
app.use((req, res, next) => {
    // Check if user is logged in as customer and hasn't verified THIS session
    if (res.locals.user && res.locals.user.role === 'customer' && !req.session.isVerifiedInSession) {
        
        // Paths that unverified users ARE allowed to access
        const allowedPaths = [
            '/verify-email', 
            '/api/auth/verify-email', 
            '/api/auth/resend-code', 
            '/api/auth/logout',
            '/api/auth/cancel-email-change',
            '/css', 
            '/js', 
            '/images', 
            '/favicon.ico'
        ];
        
        const isPathAllowed = allowedPaths.some(path => req.path.startsWith(path));
        
        if (!isPathAllowed) {
            if (req.path.startsWith('/api/')) {
                return res.status(403).json({ 
                    error: 'You must verify your email before using this action.',
                    unverified: true,
                    email: res.locals.user.email
                });
            }
            return res.redirect(`/verify-email?email=${encodeURIComponent(res.locals.user.email)}`);
        }
    }
    next();
});

// Import API Routes
const authRoutes = require('./routes/auth');
const verifyRoutes = require('./routes/verify');
const menuRoutes = require('./routes/menu');
const promoRoutes = require('./routes/promo');
const orderRoutes = require('./routes/order');
const paymentRoutes = require('./routes/payment');
const userRoutes = require('./routes/user');
const categoryRoutes = require('./routes/category');

// Import Page Routes
const pageRoutes = require('./routes/index');
const helpRoutes = require('./routes/help');

// Mount API Routes
app.use('/api/auth', authRoutes);
app.use('/api/verify', verifyRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/promos', promoRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/users', userRoutes);
app.use('/api/categories', categoryRoutes);

// Mount Page Routes
app.use('/', pageRoutes);
app.use('/help', helpRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong on the server!' });
});

// Async startup: initialize DB schema then start listening
(async () => {
    try {
        await initDb();
        await seedData();
        const server = app.listen(PORT, () => {
            console.log(`☕ Kape Kanto Hub Server is running on http://localhost:${PORT}`);
        });
        
        // Increase timeouts for large Base64 transfers
        server.keepAliveTimeout = 120000; // 120 seconds
        server.headersTimeout = 125000;
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
})();

// Keep process alive
setInterval(() => {}, 1000);
