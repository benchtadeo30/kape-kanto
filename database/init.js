const { Database } = require('@sqlitecloud/drivers');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const SQLITECLOUD_URL = process.env.SQLITECLOUD_URL;

if (!SQLITECLOUD_URL) {
    console.error('[DB] FATAL: SQLITECLOUD_URL environment variable is not set.');
    process.exit(1);
}

// Create the SQLite Cloud database connection
const cloudDb = new Database(SQLITECLOUD_URL);
console.log('[DB] SQLite Cloud connection initialized.');

// ─── Compatibility Wrapper ───────────────────────────────────
// Mimics better-sqlite3 API shape but async, so callers add `await`
const db = {
    _inTransaction: false,
    get inTransaction() { return this._inTransaction; },

    prepare(sql) {
        return {
            async run(...args) {
                // Handle named params object (e.g., { user_id: 1, status: 'pending' })
                if (args.length === 1 && typeof args[0] === 'object' && !Array.isArray(args[0]) && args[0] !== null) {
                    const obj = args[0];
                    const paramNames = [];
                    const regex = /@(\w+)/g;
                    let match;
                    while ((match = regex.exec(sql)) !== null) {
                        paramNames.push(match[1]);
                    }
                    const positionalSql = sql.replace(/@(\w+)/g, '?');
                    const positionalArgs = paramNames.map(name => obj[name]);
                    const result = await cloudDb.sql(positionalSql, ...positionalArgs);
                    return { changes: result?.changes ?? 0, lastInsertRowid: result?.lastID ?? 0 };
                }
                const result = await cloudDb.sql(sql, ...args);
                return { changes: result?.changes ?? 0, lastInsertRowid: result?.lastID ?? 0 };
            },
            async get(...args) {
                const rows = await cloudDb.sql(sql, ...args);
                if (Array.isArray(rows)) return rows[0] || null;
                return rows || null;
            },
            async all(...args) {
                const rows = await cloudDb.sql(sql, ...args);
                return Array.isArray(rows) ? rows : [];
            }
        };
    },

    async pragma(str) {
        try {
            return await cloudDb.sql(`PRAGMA ${str}`);
        } catch (e) {
            console.warn(`[DB] PRAGMA ${str} warning:`, e.message);
        }
    },

    transaction(fn) {
        return async (...args) => {
            await cloudDb.sql('BEGIN TRANSACTION');
            db._inTransaction = true;
            try {
                const result = await fn(...args);
                await cloudDb.sql('COMMIT');
                db._inTransaction = false;
                return result;
            } catch (e) {
                await cloudDb.sql('ROLLBACK');
                db._inTransaction = false;
                throw e;
            }
        };
    },

    async beginTransaction() {
        await cloudDb.sql('BEGIN TRANSACTION');
        db._inTransaction = true;
    },
    async commit() {
        await cloudDb.sql('COMMIT');
        db._inTransaction = false;
    },
    async rollback() {
        try { await cloudDb.sql('ROLLBACK'); } catch(e) {}
        db._inTransaction = false;
    }
};

// ─── Schema & Migrations ────────────────────────────────────
async function initDb() {
    console.log("[DB] Initializing database schema...");

    await db.pragma('foreign_keys = ON');

    // 1. Users table
    await cloudDb.sql(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('customer', 'admin', 'staff')),
            is_senior BOOLEAN DEFAULT 0,
            is_pwd BOOLEAN DEFAULT 0,
            senior_id_image TEXT,
            pwd_id_image TEXT,
            id_verification_status TEXT DEFAULT 'none' CHECK(id_verification_status IN ('none', 'pending', 'verified', 'rejected')),
            id_verification_notes TEXT,
            is_verified BOOLEAN DEFAULT 0,
            verification_token TEXT,
            reset_token TEXT,
            reset_token_expiry DATETIME,
            profile_image TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 2. Categories table
    await cloudDb.sql(`
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        )
    `);

    // 3. Menu items table
    await cloudDb.sql(`
        CREATE TABLE IF NOT EXISTS menu_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            price REAL NOT NULL,
            category_id INTEGER,
            image TEXT,
            stock INTEGER DEFAULT 0,
            is_available BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE SET NULL
        )
    `);

    // 4. Promos table
    await cloudDb.sql(`
        CREATE TABLE IF NOT EXISTS promos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            discount_percent REAL NOT NULL,
            discount_amount REAL DEFAULT 0,
            image TEXT,
            start_date DATETIME,
            end_date DATETIME,
            is_active BOOLEAN DEFAULT 0,
            promo_code TEXT UNIQUE,
            applicable_category_id INTEGER,
            applicable_menu_item_id INTEGER,
            applicable_category_ids TEXT DEFAULT '[]',
            applicable_menu_item_ids TEXT DEFAULT '[]',
            usage_limit INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(applicable_category_id) REFERENCES categories(id) ON DELETE SET NULL,
            FOREIGN KEY(applicable_menu_item_id) REFERENCES menu_items(id) ON DELETE SET NULL
        )
    `);

    // 5. Promo Items
    await cloudDb.sql(`
        CREATE TABLE IF NOT EXISTS promo_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            promo_id INTEGER,
            menu_item_id INTEGER,
            FOREIGN KEY(promo_id) REFERENCES promos(id) ON DELETE CASCADE,
            FOREIGN KEY(menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
        )
    `);

    // 6. Orders table
    await cloudDb.sql(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            status TEXT DEFAULT 'awaiting_payment' CHECK(status IN ('awaiting_payment', 'pending', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled')),
            subtotal REAL NOT NULL,
            vat_amount REAL DEFAULT 0,
            discount_amount REAL DEFAULT 0,
            discount_type TEXT DEFAULT 'none' CHECK(discount_type IN ('senior', 'pwd', 'promo', 'none')),
            sc_discount_amount REAL DEFAULT 0,
            promo_discount_amount REAL DEFAULT 0,
            delivery_fee REAL DEFAULT 0,
            total REAL NOT NULL,
            payment_method TEXT,
            payment_status TEXT DEFAULT 'awaiting' CHECK(payment_status IN ('awaiting', 'paid', 'failed', 'cancelled')),
            payrex_checkout_id TEXT,
            payrex_payment_id TEXT,
            order_type TEXT NOT NULL CHECK(order_type IN ('delivery', 'pickup')),
            delivery_address TEXT,
            promo_id INTEGER,
            schedule_mode TEXT DEFAULT 'scheduled',
            scheduled_date TEXT,
            scheduled_time TEXT,
            estimated_ready_time DATETIME,
            notes TEXT,
            rider_name TEXT,
            rider_contact TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY(promo_id) REFERENCES promos(id) ON DELETE SET NULL
        )
    `);

    // 7. Order Items table
    await cloudDb.sql(`
        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            menu_item_id INTEGER,
            quantity INTEGER NOT NULL,
            unit_price REAL NOT NULL,
            subtotal REAL NOT NULL,
            customizations TEXT,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
            FOREIGN KEY(menu_item_id) REFERENCES menu_items(id) ON DELETE SET NULL
        )
    `);

    // 8. Order Messages table
    await cloudDb.sql(`
        CREATE TABLE IF NOT EXISTS order_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            user_id INTEGER,
            message TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
        )
    `);

    // 9. Menu Item Options
    await cloudDb.sql(`
        CREATE TABLE IF NOT EXISTS menu_item_options (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            menu_item_id INTEGER,
            name TEXT NOT NULL,
            FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
        )
    `);

    // 9. Menu Item Option Choices
    await cloudDb.sql(`
        CREATE TABLE IF NOT EXISTS menu_item_option_choices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            option_id INTEGER,
            name TEXT NOT NULL,
            price_adjustment REAL DEFAULT 0,
            FOREIGN KEY (option_id) REFERENCES menu_item_options(id) ON DELETE CASCADE
        )
    `);

    // 10. Promo Tasks
    await cloudDb.sql(`
        CREATE TABLE IF NOT EXISTS promo_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            required_menu_item_id INTEGER,
            required_category_id INTEGER,
            required_quantity INTEGER NOT NULL DEFAULT 1,
            reward_promo_id INTEGER,
            is_active BOOLEAN DEFAULT 1,
            FOREIGN KEY (required_menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE,
            FOREIGN KEY (required_category_id) REFERENCES categories(id) ON DELETE CASCADE,
            FOREIGN KEY (reward_promo_id) REFERENCES promos(id) ON DELETE CASCADE
        )
    `);

    // 11. User Promo Progress
    await cloudDb.sql(`
        CREATE TABLE IF NOT EXISTS user_promo_progress (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            promo_task_id INTEGER,
            current_quantity INTEGER DEFAULT 0,
            is_completed BOOLEAN DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (promo_task_id) REFERENCES promo_tasks(id) ON DELETE CASCADE
        )
    `);

    // 12. User Earned Coupons
    await cloudDb.sql(`
        CREATE TABLE IF NOT EXISTS user_coupons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            promo_id INTEGER,
            is_used BOOLEAN DEFAULT 0,
            times_used INTEGER DEFAULT 0,
            usage_limit INTEGER DEFAULT 1,
            earned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(promo_id) REFERENCES promos(id) ON DELETE CASCADE
        )
    `);

    // 13. Pending Users table
    await cloudDb.sql(`
        CREATE TABLE IF NOT EXISTS pending_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            verification_token TEXT NOT NULL,
            profile_image TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // ─── Migrations ──────────────────────────────────────────
    const safeAddColumn = async (table, column, definition) => {
        try {
            const cols = await cloudDb.sql(`PRAGMA table_info(${table})`);
            const colNames = Array.isArray(cols) ? cols.map(c => c.name) : [];
            if (!colNames.includes(column)) {
                await cloudDb.sql(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
                console.log(`[DB] Migration: Added ${column} to ${table}.`);
            }
        } catch (e) {
            console.log(`[DB] Migration: Skipping ${column} on ${table} (${e.message})`);
        }
    };

    // Users migrations
    await safeAddColumn('users', 'is_verified', 'BOOLEAN DEFAULT 0');
    await safeAddColumn('users', 'verification_token', 'TEXT');
    await safeAddColumn('users', 'reset_token', 'TEXT');
    await safeAddColumn('users', 'reset_token_expiry', 'DATETIME');
    await safeAddColumn('users', 'profile_image', 'TEXT');
    await safeAddColumn('users', 'id_verification_message', 'TEXT');
    await safeAddColumn('users', 'pending_email', 'TEXT');
    await safeAddColumn('users', 'selfie_image', 'TEXT');
    await safeAddColumn('users', 'id_number', 'TEXT');
    await safeAddColumn('users', 'verified_by', 'INTEGER');
    await safeAddColumn('users', 'verified_at', 'DATETIME');
    await safeAddColumn('users', 'phone_number', 'TEXT');
    await safeAddColumn('users', 'is_phone_verified', 'BOOLEAN DEFAULT 0');
    await safeAddColumn('users', 'phone_otp', 'TEXT');
    await safeAddColumn('users', 'phone_otp_expires', 'DATETIME');

    // Promos migrations
    await safeAddColumn('promos', 'discount_amount', 'REAL DEFAULT 0');
    await safeAddColumn('promos', 'applicable_category_id', 'INTEGER');
    await safeAddColumn('promos', 'applicable_menu_item_id', 'INTEGER');
    await safeAddColumn('promos', 'applicable_category_ids', "TEXT DEFAULT '[]'");
    await safeAddColumn('promos', 'applicable_menu_item_ids', "TEXT DEFAULT '[]'");
    await safeAddColumn('promos', 'usage_limit', 'INTEGER DEFAULT 1');

    // user_coupons migrations
    await safeAddColumn('user_coupons', 'times_used', 'INTEGER DEFAULT 0');
    await safeAddColumn('user_coupons', 'usage_limit', 'INTEGER DEFAULT 1');

    // Order migrations
    await safeAddColumn('orders', 'vat_amount', 'REAL DEFAULT 0');
    await safeAddColumn('orders', 'delivery_fee', 'REAL DEFAULT 0');
    await safeAddColumn('orders', 'rider_name', 'TEXT');
    await safeAddColumn('orders', 'rider_contact', 'TEXT');
    await safeAddColumn('orders', 'sc_discount_amount', 'REAL DEFAULT 0');
    await safeAddColumn('orders', 'promo_discount_amount', 'REAL DEFAULT 0');
    await safeAddColumn('orders', 'promo_id', 'INTEGER');
    await safeAddColumn('orders', 'schedule_mode', "TEXT DEFAULT 'scheduled'");
    await safeAddColumn('orders', 'estimated_ready_time', 'DATETIME');

    // Order items migration
    await safeAddColumn('order_items', 'customizations', 'TEXT');

    // Promo tasks migrations
    await safeAddColumn('promo_tasks', 'required_category_id', 'INTEGER');
    await safeAddColumn('promo_tasks', 'task_type', "TEXT DEFAULT 'buy_specific_item'");
    await safeAddColumn('promo_tasks', 'rule_json', 'TEXT');
    await safeAddColumn('promo_tasks', 'customer_description', 'TEXT');
    await safeAddColumn('promo_tasks', 'min_order_amount', 'REAL');
    await safeAddColumn('promo_tasks', 'start_date', 'DATETIME');
    await safeAddColumn('promo_tasks', 'end_date', 'DATETIME');
    
    // Order Messages migration
    await safeAddColumn('order_messages', 'is_read', 'BOOLEAN DEFAULT 0');

    console.log("[DB] Database schema initialized.");
}

async function seedData() {
    console.log("[DB] Seeding default data...");

    // Seed Admin Account
    const adminCheck = await db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    if (!adminCheck) {
        const hash = bcrypt.hashSync('admin123', 10);
        await db.prepare('INSERT INTO users (username, email, password, role, is_verified) VALUES (?, ?, ?, ?, 1)').run('admin', 'admin@kapekantohub.com', hash, 'admin');
        console.log("[DB] Created default admin user (admin / admin123)");
    }

    // Guard clause: If the database already contains menu items, skip the rest of seeding to preserve modifications!
    const menuCount = await db.prepare('SELECT COUNT(*) as count FROM menu_items').get();
    if (menuCount && menuCount.count > 0) {
        console.log('[DB] Database already contains menu items. Skipping categories, menu, options, and tasks seeding to preserve custom modifications.');
        return;
    }

    // Seed Categories
    const categories = ['Hot Coffee', 'Iced Coffee', 'Pastries', 'Meals', 'Frappe'];
    for (const cat of categories) {
        await db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(cat);
    }

    // Build category map
    const catMap = {};
    for (const c of categories) {
        const row = await db.prepare('SELECT id FROM categories WHERE name = ?').get(c);
        if (row) catMap[c] = row.id;
    }

    const menuItems = [
        ['Kanto Americano', 'Our signature bold black coffee — pure espresso & hot water, no-frills perfection.', 100.0, catMap['Hot Coffee'], 'https://images.unsplash.com/photo-1510591509098-f4fdc6d0ff04?auto=format&fit=crop&q=80&w=600', 50, 1],
        ['Kanto Latte', 'Silky steamed milk layered over a rich double espresso shot.', 125.0, catMap['Hot Coffee'], 'https://images.unsplash.com/photo-1570968015861-d53aa810ddee?auto=format&fit=crop&q=80&w=600', 50, 1],
        ['Cappuccino', 'Classic Italian-style equal-parts espresso, steamed milk, and velvety microfoam.', 130.0, catMap['Hot Coffee'], 'https://images.unsplash.com/photo-1534778101976-62847782c213?auto=format&fit=crop&q=80&w=600', 40, 1],
        ['Spanish Latte', 'Espresso sweetened with condensed milk — creamy, indulgent, and dangerously good.', 145.0, catMap['Hot Coffee'], 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&q=80&w=600', 40, 1],
        ['Flat White', 'Double ristretto espresso with velvety steamed milk — stronger than a latte.', 140.0, catMap['Hot Coffee'], 'https://images.unsplash.com/photo-1551893086-c0411bd996ee?auto=format&fit=crop&q=80&w=600', 35, 1],
        ['Caramel Macchiato', 'Freshly steamed milk with vanilla-flavored syrup marked with espresso and topped with caramel drizzle.', 150.0, catMap['Hot Coffee'], 'https://images.unsplash.com/photo-1485808191679-5f86510681a2?auto=format&fit=crop&q=80&w=600', 40, 1],
        ['Caffè Mocha', 'Rich, full-bodied espresso combined with bittersweet mocha sauce and steamed milk.', 145.0, catMap['Hot Coffee'], 'https://images.unsplash.com/photo-1607681034540-2c46cc71896d?auto=format&fit=crop&q=80&w=600', 45, 1],
        ['Iced Americano', 'Double espresso chilled over ice — refreshing and unapologetically bold.', 110.0, catMap['Iced Coffee'], 'https://images.unsplash.com/photo-1517701604599-bb29b565090c?auto=format&fit=crop&q=80&w=600', 60, 1],
        ['Iced Latte', 'Cold milk meets espresso over crushed ice for a smooth daily staple.', 135.0, catMap['Iced Coffee'], 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&q=80&w=600', 60, 1],
        ['Cold Brew', 'Steeped slowly for 18 hours — naturally sweet, low-acid, incredibly smooth.', 150.0, catMap['Iced Coffee'], 'https://images.unsplash.com/photo-1494314671902-399b18174975?auto=format&fit=crop&q=80&w=600', 30, 1],
        ['Iced Spanish Latte', 'Sweet condensed milk, espresso, and ice — the classic Filipino café favorite.', 155.0, catMap['Iced Coffee'], 'https://images.unsplash.com/photo-1553909489-cd47e0907980?auto=format&fit=crop&q=80&w=600', 50, 1],
        ['Iced Caramel Macchiato', 'Vanilla-flavored syrup, milk and ice topped with espresso and caramel drizzle.', 160.0, catMap['Iced Coffee'], 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&q=80&w=600', 50, 1],
        ['Iced White Mocha', 'Espresso, milk and white chocolate sauce served over ice.', 165.0, catMap['Iced Coffee'], 'https://images.unsplash.com/photo-1553909489-cd47e0907980?auto=format&fit=crop&q=80&w=600', 40, 1],
        ['Mocha Frappe', 'Blended espresso, rich chocolate sauce, milk, and ice — topped with whipped cream.', 165.0, catMap['Frappe'], 'https://images.unsplash.com/photo-1572490122747-3968b75cc699?auto=format&fit=crop&q=80&w=600', 40, 1],
        ['Caramel Frappe', 'Creamy blended coffee with golden caramel drizzle and whipped cream.', 165.0, catMap['Frappe'], 'https://images.unsplash.com/photo-1544145945-f904253db0ad?auto=format&fit=crop&q=80&w=600', 40, 1],
        ['Vanilla Cream Frappe', 'A smooth and creamy blend of vanilla bean, milk and ice.', 155.0, catMap['Frappe'], 'https://images.unsplash.com/photo-1571115177098-24ec42ed204d?auto=format&fit=crop&q=80&w=600', 35, 1],
        ['Hazelnut Frappe', 'Rich hazelnut syrup blended with coffee, milk and ice.', 170.0, catMap['Frappe'], 'https://images.unsplash.com/photo-1615478503562-ec2d8aa0e24e?auto=format&fit=crop&q=80&w=600', 30, 1],
        ['Classic Croissant', 'Flaky, buttery layers baked fresh every morning — perfect with any coffee.', 85.0, catMap['Pastries'], 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?auto=format&fit=crop&q=80&w=600', 25, 1],
        ['Chocolate Chip Cookie', 'Thick, chewy, loaded with dark chocolate chunks — still warm from the oven.', 65.0, catMap['Pastries'], 'https://images.unsplash.com/photo-1499636136210-6f4ee915583e?auto=format&fit=crop&q=80&w=600', 40, 1],
        ['Pain au Chocolat', 'A buttery, flaky croissant pastry with two bars of dark chocolate inside.', 95.0, catMap['Pastries'], 'https://images.unsplash.com/photo-1530610476181-d83430b64dcd?auto=format&fit=crop&q=80&w=600', 20, 1],
        ['Cinnamon Roll', 'Warm, soft pastry swirled with cinnamon sugar and topped with cream cheese icing.', 110.0, catMap['Pastries'], 'https://images.unsplash.com/photo-1509365465985-25d11c17e812?auto=format&fit=crop&q=80&w=600', 15, 1],
        ['Carrot Cake Slice', 'Moist carrot cake with walnuts and a thick layer of cream cheese frosting.', 135.0, catMap['Pastries'], 'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?auto=format&fit=crop&q=80&w=600', 10, 1],
        ['Beef Tapa Rice Bowl', 'Filipino cured beef served with garlic rice and sunny-side up egg.', 220.0, catMap['Meals'], 'https://images.unsplash.com/photo-1627308595229-7830a5c91f9f?auto=format&fit=crop&q=80&w=600', 20, 1],
        ['Chicken Adobo Bowl', 'Classic Filipino chicken adobo in savory soy-vinegar sauce over steamed rice.', 195.0, catMap['Meals'], 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&q=80&w=600', 20, 1],
        ['Club Sandwich', 'Triple-decker with grilled chicken, lettuce, tomato, bacon, and mayo.', 185.0, catMap['Meals'], 'https://images.unsplash.com/photo-1567234669003-dce7a7a88821?auto=format&fit=crop&q=80&w=600', 20, 1],
    ];

    for (const item of menuItems) {
        const exists = await db.prepare('SELECT id FROM menu_items WHERE name = ?').get(item[0]);
        if (exists) {
            await db.prepare('UPDATE menu_items SET image = ?, description = ? WHERE name = ?').run(item[4], item[1], item[0]);
        } else {
            await db.prepare('INSERT OR IGNORE INTO menu_items (name, description, price, category_id, image, stock, is_available) VALUES (?, ?, ?, ?, ?, ?, ?)').run(...item);
        }
    }
    console.log('[DB] Synchronized menu items');

    // Options helper
    const addOption = async (itemName, optionName, choices) => {
        const item = await db.prepare('SELECT id FROM menu_items WHERE name = ?').get(itemName);
        if (!item) return;
        const existingOption = await db.prepare('SELECT id FROM menu_item_options WHERE menu_item_id = ? AND LOWER(name) = LOWER(?)').get(item.id, optionName);
        if (existingOption) return;
        const optResult = await db.prepare('INSERT INTO menu_item_options (menu_item_id, name) VALUES (?, ?)').run(item.id, optionName);
        const optionId = optResult.lastInsertRowid;
        for (const [name, adj] of choices) {
            await db.prepare('INSERT INTO menu_item_option_choices (option_id, name, price_adjustment) VALUES (?, ?, ?)').run(optionId, name, adj);
        }
    };

    // Temperature options
    for (const name of ['Kanto Americano','Kanto Latte','Cappuccino','Spanish Latte','Flat White']) {
        await addOption(name, 'Temperature', [['Standard Hot', 0], ['Extra Hot', 0], ['Iced (switch to cold)', 10]]);
    }
    // Sugar level
    for (const name of ['Kanto Americano','Kanto Latte','Cappuccino','Iced Americano','Iced Latte','Cold Brew','Iced Spanish Latte']) {
        await addOption(name, 'Sugar Level', [['No Sugar', 0], ['Less Sweet', 0], ['Regular', 0], ['Extra Sweet', 0]]);
    }
    // Size for frappes
    for (const name of ['Mocha Frappe','Caramel Frappe','Matcha Frappe','Strawberry Frappe']) {
        await addOption(name, 'Size', [['Regular (16oz)', 0], ['Large (22oz)', 25]]);
    }
    // Whip
    for (const name of ['Mocha Frappe','Caramel Frappe','Matcha Frappe','Strawberry Frappe']) {
        await addOption(name, 'Whipped Cream', [['With Whip', 0], ['No Whip', 0]]);
    }
    // Milk
    for (const name of ['Kanto Latte','Iced Latte','Spanish Latte','Iced Spanish Latte','Flat White']) {
        await addOption(name, 'Milk Type', [['Full Cream', 0], ['Oat Milk', 15], ['Almond Milk', 15], ['Non-fat', 0]]);
    }
    await addOption('Egg & Bacon Sandwich', 'Egg Style', [['Scrambled', 0], ['Sunny-Side Up', 0], ['Over Easy', 0]]);
    console.log('[DB] Created menu options and choices');

    // Seed Sample Promo Task
    const kantoAmericano = await db.prepare("SELECT id FROM menu_items WHERE name = 'Kanto Americano'").get();
    const discountPromo = await db.prepare("SELECT id FROM promos WHERE promo_code = 'SUMMER20'").get();

    if (kantoAmericano) {
        let pId = discountPromo ? discountPromo.id : null;
        if (!pId) {
            await db.prepare("INSERT OR IGNORE INTO promos (title, description, discount_percent, promo_code, is_active) VALUES ('Task Reward', '20% Off Reward', 20, 'REWARD20', 1)").run();
            const newP = await db.prepare("SELECT id FROM promos WHERE promo_code = 'REWARD20'").get();
            pId = newP ? newP.id : null;
        }
        const existingTask = await db.prepare("SELECT 1 FROM promo_tasks WHERE title = 'Buy 5 Americanos'").get();
        if (!existingTask) {
            await db.prepare('INSERT INTO promo_tasks (title, description, required_menu_item_id, required_quantity, reward_promo_id) VALUES (?, ?, ?, ?, ?)').run('Buy 5 Americanos', 'Buy 5 Kanto Americanos and get a 20% discount coupon!', kantoAmericano.id, 5, pId);
        }
        console.log("[DB] Created sample purchase-based promo task");
    }

    console.log("[DB] Seeding complete.");
}

module.exports = { db, initDb, seedData };
