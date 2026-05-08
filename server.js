const express = require('express');
// Trigger restart - v2
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const { db, initDb, seedData } = require('./database/init');

initDb();
seedData();

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24 // 24 hours
    }
}));

// Helper to pass common data to all views
// Moved to server.js for global access

// Global User Middleware
app.use((req, res, next) => {
    res.locals.user = null;
    if (req.session && req.session.userId) {
        try {
            if (db) {
                res.locals.user = db.prepare(`SELECT id, username, email, pending_email, role, is_senior, is_pwd, is_verified, id_verification_status, id_verification_notes, profile_image FROM users WHERE id = ?`).get(req.session.userId);
            }
        } catch (e) {
            console.error("Session User Middleware Error:", e);
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

// Initialize DB (only if required on startup, better to run separately for schema creation)
// require('./database/init'); 

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong on the server!' });
});

// Start Server
app.listen(PORT, () => {
    console.log(`☕ Kape Kanto Hub Server is running on http://localhost:${PORT}`);
});

// Keep process alive
setInterval(() => {}, 1000);
