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

router.get('/', (req, res) => {
    try {
        const featuredItems = db.prepare(`
            SELECT m.*, IFNULL(SUM(oi.quantity), 0) as order_count 
            FROM menu_items m 
            LEFT JOIN order_items oi ON m.id = oi.menu_item_id 
            WHERE m.is_available = 1 
            GROUP BY m.id 
            ORDER BY order_count DESC, m.id ASC 
            LIMIT 6
        `).all();
        const promos = db.prepare(`
            SELECT *, 'promo' as event_type FROM promos 
            WHERE is_active = 1 
            AND (end_date IS NULL OR end_date = '' OR datetime(end_date) >= datetime('now', 'localtime'))
        `).all();

        const tasks = db.prepare(`
            SELECT *, 'task' as event_type FROM promo_tasks 
            WHERE is_active = 1 
            AND (end_date IS NULL OR end_date = '' OR datetime(end_date) >= datetime('now', 'localtime'))
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

router.get('/menu', (req, res) => {
    try {
        const categories = db.prepare(`SELECT * FROM categories`).all();
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

router.get('/forgot-password', (req, res) => {
    if (res.locals.user) return res.redirect('/');
    res.render('forgot-password', { title: 'Forgot Password - Kape Kanto Hub' });
});

router.get('/reset-password', (req, res) => {
    const token = req.query.token;
    if (!token) return res.redirect('/login');
    res.render('reset-password', { token, title: 'Reset Password - Kape Kanto Hub' });
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

router.get('/profile', pageRequireAuth, (req, res) => {
    const promoProgress = db.prepare(`
        SELECT 
            t.id as task_id, 
            t.title, 
            COALESCE(t.customer_description, t.description) as description, 
            t.required_quantity,
            t.end_date,
            IFNULL(p.current_quantity, 0) as current_quantity, 
            IFNULL(p.is_completed, 0) as is_completed
        FROM promo_tasks t
        LEFT JOIN user_promo_progress p ON t.id = p.promo_task_id AND p.user_id = ?
        WHERE (t.is_active = 1 AND (t.end_date IS NULL OR datetime(t.end_date) >= datetime('now', 'localtime')))
    `).all(req.session.userId);

    const coupons = db.prepare(`
        SELECT c.*, p.title, p.discount_percent, p.promo_code, p.end_date 
        FROM user_coupons c
        JOIN promos p ON c.promo_id = p.id
        WHERE c.user_id = ? AND c.is_used = 0
        AND p.is_active = 1
        AND (p.end_date IS NULL OR datetime(p.end_date) >= datetime('now', 'localtime'))
    `).all(req.session.userId);

    res.render('profile', { 
        title: 'My Account Profile - Kape Kanto Hub',
        promoProgress: promoProgress || [],
        coupons: coupons || []
    });
});

router.get('/payment-success', (req, res) => {
    res.render('payment-success', { title: 'Payment Successful', orderId: req.query.order_id });
});

router.get('/payment-cancel', (req, res) => {
    res.render('payment-cancel', { title: 'Payment Cancelled', orderId: req.query.order_id });
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
    res.render('staff/dashboard', { title: 'Staff Dashboard' });
});

router.get('/staff/orders', pageRequireRole('staff'), (req, res) => {
    res.render('staff/orders', { title: 'Manage Orders' });
});

router.get('/staff/menu-stock', pageRequireRole('staff'), (req, res) => {
    res.render('staff/menu-stock', { title: 'Update Stock' });
});

module.exports = router;
