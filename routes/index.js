const express = require('express');
const router = express.Router();
const { db } = require('../database/init');

// Routes defined here
// Global user middleware moved to server.js

// Role Guard Middleware for Pages
const pageRequireRole = (...roles) => {
    return (req, res, next) => {
        if (!res.locals.user) {
            return res.redirect('/login');
        }
        if (!roles.includes(res.locals.user.role)) {
            return res.redirect('/'); // Redirect unauthorized to home
        }
        next();
    };
};

const pageRequireAuth = (req, res, next) => {
    if (!res.locals.user) return res.redirect('/login');
    next();
};

// --- PUBLIC PAGES ---

router.get('/', async (req, res) => {
    try {
        const featuredItems = await db.prepare(`
            SELECT m.*, IFNULL(SUM(oi.quantity), 0) as order_count 
            FROM menu_items m 
            LEFT JOIN order_items oi ON m.id = oi.menu_item_id 
            WHERE m.is_available = 1 
            GROUP BY m.id 
            ORDER BY order_count DESC, m.id ASC 
            LIMIT 6
        `).all();
        const promos = await db.prepare(`
            SELECT *, 'promo' as event_type FROM promos 
            WHERE is_active = 1 
            AND (start_date IS NULL OR start_date = '' OR datetime(start_date) <= datetime('now', '+8 hours'))
            AND (end_date IS NULL OR end_date = '' OR datetime(end_date) >= datetime('now', '+8 hours'))
        `).all();

        const tasks = await db.prepare(`
            SELECT *, 'task' as event_type FROM promo_tasks 
            WHERE is_active = 1 
            AND (start_date IS NULL OR start_date = '' OR datetime(start_date) <= datetime('now', '+8 hours'))
            AND (end_date IS NULL OR end_date = '' OR datetime(end_date) >= datetime('now', '+8 hours'))
        `).all();

        const activePromos = [...promos, ...tasks].sort((a, b) => {
            const dateA = a.created_at || '0';
            const dateB = b.created_at || '0';
            return dateB.localeCompare(dateA);
        });

        res.render('index', { featuredItems, activePromos, title: 'Home - Kape Kanto Hub' });
    } catch (e) {
        console.error('Home Page Error:', e);
        res.render('index', { featuredItems: [], activePromos: [], title: 'Home - Kape Kanto Hub' });
    }
});

router.get('/menu', async (req, res) => {
    try {
        const categories = await db.prepare(`SELECT * FROM categories`).all();
        res.render('menu', { categories, title: 'Menu - Kape Kanto Hub' });
    } catch (e) {
        res.render('menu', { categories: [], title: 'Menu - Kape Kanto Hub' });
    }
});

router.get('/login', (req, res) => {
    if (res.locals.user) return res.redirect('/');
    res.render('login', { title: 'Login - Kape Kanto Hub' });
});

router.get('/register', (req, res) => {
    if (res.locals.user) return res.redirect('/');
    res.render('register', { title: 'Register - Kape Kanto Hub' });
});

router.get('/verify-email', (req, res) => {
    const email = req.query.email;
    if (!email) return res.redirect('/login');
    res.render('verify-email', { email, title: 'Verify Email - Kape Kanto Hub' });
});

router.get('/verify-account-change', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.render('verify-account-change', { title: 'Security Verification - Kape Kanto Hub' });
});

router.get('/forgot-password', (req, res) => {
    if (res.locals.user) return res.redirect('/');
    res.render('forgot-password', { title: 'Forgot Password - Kape Kanto Hub' });
});

router.get('/reset-password', (req, res) => {
    const token = req.query.token;
    if (!token) return res.redirect('/login');
    res.render('reset-password', { token, title: 'Reset Password - Kape Kanto Hub' });
});

router.get('/contact', (req, res) => {
    res.render('contact', { title: 'Contact Us - Kape Kanto Hub', success: null });
});

router.post('/contact', async (req, res) => {
    if (!res.locals.user) {
        return res.status(401).json({ error: 'Please log in to send a message.' });
    }

    let { name, email, subject, message } = req.body;
    
    // Enforce logged in customer's actual registered name and email
    name = res.locals.user.username;
    email = res.locals.user.email;
    
    if (!name || !email || !subject || !message) {
        return res.status(400).json({ error: 'All fields are required.' });
    }

    try {
        const { sendContactFeedbackEmail } = require('../services/email');
        await sendContactFeedbackEmail(name, email, subject, message);
        res.json({ message: 'Thank you for your feedback! We have received your message and will get back to you soon.' });
    } catch (error) {
        console.error('Contact form error:', error);
        res.status(500).json({ error: 'Failed to send your message. Please try again later.' });
    }
});

// --- CUSTOMER PAGES ---

router.get('/cart', pageRequireAuth, (req, res) => {
    res.render('cart', { title: 'Cart & Checkout - Kape Kanto Hub' });
});

router.get('/order-tracking', pageRequireAuth, (req, res) => {
    res.render('order-tracking', { title: 'My Orders - Kape Kanto Hub' });
});

router.get('/order-tracking/:id', pageRequireAuth, (req, res) => {
    const orderId = req.params.id;
    res.render('order-detail', { orderId, title: `Order #${orderId} - Kape Kanto Hub` });
});

router.get('/profile', pageRequireAuth, async (req, res) => {
    const userId = req.session.userId;
    const limit = 10;
    
    // Task Page
    const tp = parseInt(req.query.tp) || 1;
    const tOffset = (tp - 1) * limit;

    // Coupon Page
    const cp = parseInt(req.query.cp) || 1;
    const cOffset = (cp - 1) * limit;

    // Public Promo Page
    const pp = parseInt(req.query.pp) || 1;
    const pOffset = (pp - 1) * limit;

    const promoProgress = await db.prepare(`
        SELECT 
            t.id as task_id, 
            t.title, 
            COALESCE(t.customer_description, t.description) as description, 
            t.required_quantity,
            t.task_type,
            t.min_order_amount,
            t.end_date,
            IFNULL(p.current_quantity, 0) as current_quantity, 
            IFNULL(p.is_completed, 0) as is_completed,
            r.usage_limit as reward_limit
        FROM promo_tasks t
        LEFT JOIN user_promo_progress p ON t.id = p.promo_task_id AND p.user_id = ?
        LEFT JOIN promos r ON t.reward_promo_id = r.id
        WHERE (t.is_active = 1 
               AND (t.start_date IS NULL OR t.start_date = '' OR datetime(t.start_date) <= datetime('now', '+8 hours'))
               AND (t.end_date IS NULL OR t.end_date = '' OR datetime(t.end_date) >= datetime('now', '+8 hours')))
        LIMIT ? OFFSET ?
    `).all(userId, limit, tOffset);

    const tCount = await db.prepare(`
        SELECT COUNT(*) as count FROM promo_tasks 
        WHERE is_active = 1 
        AND (start_date IS NULL OR start_date = '' OR datetime(start_date) <= datetime('now', '+8 hours'))
        AND (end_date IS NULL OR end_date = '' OR datetime(end_date) >= datetime('now', '+8 hours'))
    `).get();

    // Earned coupons: fetch all for this user that are linked to loyalty tasks
    const allCoupons = await db.prepare(`
        SELECT 
            p.id, p.title, p.discount_percent, p.discount_amount, p.promo_code, p.end_date, 
            p.usage_limit as global_limit,
            IFNULL(c.times_used, 0) as times_used,
            IFNULL(c.usage_limit, 0) as usage_limit
        FROM user_coupons c
        JOIN promos p ON c.promo_id = p.id
        WHERE c.user_id = ? 
        AND p.id IN (SELECT reward_promo_id FROM promo_tasks WHERE reward_promo_id IS NOT NULL)
        AND p.is_active = 1
        AND (p.end_date IS NULL OR p.end_date = '' OR datetime(p.end_date) >= datetime('now', '+8 hours'))
    `).all(userId);

    // Filter: only show coupons that still have uses left
    const filteredCoupons = allCoupons.filter(c => {
        const limit = Math.max(c.usage_limit || 0, c.global_limit || 1);
        return c.times_used < limit;
    });
    const cCount = { count: filteredCoupons.length };
    const coupons = filteredCoupons.slice(cOffset, cOffset + limit);

    // Public promos: fetch all active non-reward promos
    const allPublicPromos = await db.prepare(`
        SELECT p.*, 
               IFNULL((SELECT SUM(times_used) FROM user_coupons WHERE user_id = ? AND promo_id = p.id), 0) as times_used
        FROM promos p
        WHERE p.is_active = 1
        AND (p.start_date IS NULL OR p.start_date = '' OR datetime(p.start_date) <= datetime('now', '+8 hours'))
        AND (p.end_date IS NULL OR p.end_date = '' OR datetime(p.end_date) >= datetime('now', '+8 hours'))
        AND p.id NOT IN (SELECT reward_promo_id FROM promo_tasks WHERE reward_promo_id IS NOT NULL)
    `).all(userId);

    // Filter: hide promos where usage limit is reached
    const filteredPublic = allPublicPromos.filter(p => {
        if (!p.usage_limit || p.usage_limit === 0) return true; // unlimited
        return p.times_used < p.usage_limit;
    });
    const pCount = { count: filteredPublic.length };
    const publicPromos = filteredPublic.slice(pOffset, pOffset + limit);

    res.render('profile', { 
        title: 'My Account Profile - Kape Kanto Hub',
        promoProgress: promoProgress || [],
        coupons: coupons || [],
        publicPromos: publicPromos || [],
        pagination: {
            tasks: { current: tp, total: Math.ceil((tCount?.count || 0) / limit) },
            coupons: { current: cp, total: Math.ceil((cCount?.count || 0) / limit) },
            public: { current: pp, total: Math.ceil((pCount?.count || 0) / limit) }
        }
    });
});

router.get('/payment-success', (req, res) => {
    res.render('payment-success', { title: 'Payment Successful', orderId: req.query.order_id });
});

router.get('/payment-cancel', (req, res) => {
    res.render('payment-cancel', { title: 'Payment Cancelled', orderId: req.query.order_id });
});

// --- ADMIN & STAFF LOGIN ---

router.get('/admin/login', (req, res) => {
    if (res.locals.user && res.locals.user.role === 'admin') return res.redirect('/admin/dashboard');
    if (res.locals.user && res.locals.user.role === 'staff') return res.redirect('/staff/dashboard');
    res.render('admin/login', { title: 'Staff Portal - Kape Kanto Hub' });
});

// --- ADMIN PAGES ---

router.get('/admin/dashboard', pageRequireRole('admin'), (req, res) => {
    res.render('admin/dashboard', { title: 'Admin Dashboard' });
});

router.get('/admin/menu-manage', pageRequireRole('admin'), (req, res) => {
    res.render('admin/menu-manage', { title: 'Manage Menu' });
});

router.get('/admin/promo-manage', pageRequireRole('admin'), (req, res) => {
    res.render('admin/promo-manage', { title: 'Manage Promos' });
});

router.get('/admin/user-manage', pageRequireRole('admin'), (req, res) => {
    res.render('admin/user-manage', { title: 'Manage Users & Approvals' });
});

// Legacy redirect
router.get('/admin/users', pageRequireRole('admin'), (req, res) => {
    res.redirect('/admin/user-manage');
});

router.get('/admin/orders', pageRequireRole('admin'), (req, res) => {
    res.render('admin/orders', { title: 'All Orders' });
});

// --- STAFF PAGES ---

router.get('/staff/dashboard', pageRequireRole('staff'), (req, res) => {
    res.redirect('/staff/orders');
});

router.get('/staff/orders', pageRequireRole('staff'), (req, res) => {
    res.render('staff/orders', { title: 'Manage Orders' });
});

router.get('/staff/menu-stock', pageRequireRole('staff'), (req, res) => {
    res.render('staff/menu-stock', { title: 'Update Stock' });
});

module.exports = router;
