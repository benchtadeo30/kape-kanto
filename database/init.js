const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

function resolveDatabasePath() {
    const fallbackPath = path.join(__dirname, 'cafe.db');
    const requestedPath = process.env.DB_PATH || fallbackPath;
    const resolvedDbDir = path.dirname(requestedPath);

    try {
        if (!fs.existsSync(resolvedDbDir)) {
            fs.mkdirSync(resolvedDbDir, { recursive: true });
        }
        return requestedPath;
    } catch (error) {
        console.warn(`Unable to use DB_PATH "${requestedPath}". Falling back to "${fallbackPath}".`, error.message);
        return fallbackPath;
    }
}

const dbPath = resolveDatabasePath();
const db = new Database(dbPath, { verbose: console.log });

// Enable foreign keys
db.pragma('foreign_keys = ON');

function initDb() {
    console.log("Initializing database schema...");

    // 1. Users table
    db.prepare(`
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
    `).run();

    // 2. Categories table
    db.prepare(`
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        )
    `).run();

    // 3. Menu items table
    db.prepare(`
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
    `).run();

    // 4. Promos table
    db.prepare(`
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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(applicable_category_id) REFERENCES categories(id) ON DELETE SET NULL,
            FOREIGN KEY(applicable_menu_item_id) REFERENCES menu_items(id) ON DELETE SET NULL
        )
    `).run();

    // Migration: Add columns for promo system upgrades if they don't exist
    const promoCols = db.prepare("PRAGMA table_info(promos)").all().map(c => c.name);
    
    const migrate = (col, sql) => {
        if (!promoCols.includes(col)) {
            try {
                db.prepare(sql).run();
                console.log(`Migration: Added ${col} to promos.`);
            } catch (e) {
                console.log(`Migration: Skipping ${col} (likely already exists).`);
            }
        }
    };

    migrate('discount_amount', 'ALTER TABLE promos ADD COLUMN discount_amount REAL DEFAULT 0');
    migrate('applicable_category_id', 'ALTER TABLE promos ADD COLUMN applicable_category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL');
    migrate('applicable_menu_item_id', 'ALTER TABLE promos ADD COLUMN applicable_menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL');
    migrate('applicable_category_ids', "ALTER TABLE promos ADD COLUMN applicable_category_ids TEXT DEFAULT '[]'");
    migrate('applicable_menu_item_ids', "ALTER TABLE promos ADD COLUMN applicable_menu_item_ids TEXT DEFAULT '[]'");

    // 5. Promo Items (Join table for Promo -> Menu Items)
    db.prepare(`
        CREATE TABLE IF NOT EXISTS promo_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            promo_id INTEGER,
            menu_item_id INTEGER,
            FOREIGN KEY(promo_id) REFERENCES promos(id) ON DELETE CASCADE,
            FOREIGN KEY(menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
        )
    `).run();

    // 6. Orders table
    db.prepare(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            status TEXT DEFAULT 'awaiting_payment' CHECK(status IN ('awaiting_payment', 'pending', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled')),
            subtotal REAL NOT NULL,
            vat_amount REAL DEFAULT 0,
            discount_amount REAL DEFAULT 0,
            discount_type TEXT DEFAULT 'none' CHECK(discount_type IN ('senior', 'pwd', 'promo', 'none')),
            delivery_fee REAL DEFAULT 0,
            total REAL NOT NULL,
            payment_method TEXT,
            payment_status TEXT DEFAULT 'awaiting' CHECK(payment_status IN ('awaiting', 'paid', 'failed', 'cancelled')),
            payrex_checkout_id TEXT,
            payrex_payment_id TEXT,
            order_type TEXT NOT NULL CHECK(order_type IN ('delivery', 'pickup')),
            delivery_address TEXT,
            scheduled_date TEXT,
            scheduled_time TEXT,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
        )
    `).run();

    // 7. Order Items table
    db.prepare(`
        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            menu_item_id INTEGER,
            quantity INTEGER NOT NULL,
            unit_price REAL NOT NULL,
            subtotal REAL NOT NULL,
            customizations TEXT, -- New column for storing selected options as JSON
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
            FOREIGN KEY(menu_item_id) REFERENCES menu_items(id) ON DELETE SET NULL
        )
    `).run();

    // 8. Menu Item Options (e.g., Sugar Level, Size)
    db.prepare(`
        CREATE TABLE IF NOT EXISTS menu_item_options (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            menu_item_id INTEGER,
            name TEXT NOT NULL,
            FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
        )
    `).run();

    // 9. Menu Item Option Choices (e.g., 25%, 50%, Large, Medium)
    db.prepare(`
        CREATE TABLE IF NOT EXISTS menu_item_option_choices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            option_id INTEGER,
            name TEXT NOT NULL,
            price_adjustment REAL DEFAULT 0,
            FOREIGN KEY (option_id) REFERENCES menu_item_options(id) ON DELETE CASCADE
        )
    `).run();

    // 10. Promo Tasks (Purchase-based tracking)
    db.prepare(`
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
    `).run();

    // 11. User Promo Progress
    db.prepare(`
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
    `).run();

    // 12. User Earned Coupons
    db.prepare(`
        CREATE TABLE IF NOT EXISTS user_coupons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            promo_id INTEGER,
            is_used BOOLEAN DEFAULT 0,
            earned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (promo_id) REFERENCES promos(id) ON DELETE CASCADE
        )
    `).run();

    // 12. Pending Users table (for delayed insertion)
    db.prepare(`
        CREATE TABLE IF NOT EXISTS pending_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            verification_token TEXT NOT NULL,
            profile_image TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `).run();

    // Migration: Add new columns if they don't exist
    const userCols = db.prepare("PRAGMA table_info(users)").all();
    const colNames = userCols.map(c => c.name);

    if (!colNames.includes('is_verified')) {
        db.prepare('ALTER TABLE users ADD COLUMN is_verified BOOLEAN DEFAULT 0').run();
    }
    if (!colNames.includes('verification_token')) {
        db.prepare('ALTER TABLE users ADD COLUMN verification_token TEXT').run();
    }
    if (!colNames.includes('reset_token')) {
        db.prepare('ALTER TABLE users ADD COLUMN reset_token TEXT').run();
    }
    if (!colNames.includes('reset_token_expiry')) {
        db.prepare('ALTER TABLE users ADD COLUMN reset_token_expiry DATETIME').run();
    }
    if (!colNames.includes('profile_image')) {
        db.prepare('ALTER TABLE users ADD COLUMN profile_image TEXT').run();
    }
    if (!colNames.includes('id_verification_message')) {
        db.prepare('ALTER TABLE users ADD COLUMN id_verification_message TEXT').run();
        console.log("Migration: Added id_verification_message column to users.");
    }
    if (!colNames.includes('pending_email')) {
        db.prepare('ALTER TABLE users ADD COLUMN pending_email TEXT').run();
        console.log("Migration: Added pending_email column to users.");
    }

    // Migration: Check if order_items has customizations column
    try {
        db.prepare('SELECT customizations FROM order_items LIMIT 1').get();
    } catch (e) {
        if (e.message.includes('no such column')) {
            db.prepare('ALTER TABLE order_items ADD COLUMN customizations TEXT').run();
            console.log("Migration: Added customizations column to order_items.");
        }
    }

    // Migration: Check if orders has vat_amount and delivery_fee
    const orderCols = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
    if (!orderCols.includes('vat_amount')) {
        db.prepare('ALTER TABLE orders ADD COLUMN vat_amount REAL DEFAULT 0').run();
        console.log("Migration: Added vat_amount column to orders.");
    }
    if (!orderCols.includes('delivery_fee')) {
        db.prepare('ALTER TABLE orders ADD COLUMN delivery_fee REAL DEFAULT 0').run();
        console.log("Migration: Added delivery_fee column to orders.");
    }
    if (!orderCols.includes('rider_name')) {
        db.prepare('ALTER TABLE orders ADD COLUMN rider_name TEXT').run();
        console.log("Migration: Added rider_name column to orders.");
    }
    if (!orderCols.includes('rider_contact')) {
        db.prepare('ALTER TABLE orders ADD COLUMN rider_contact TEXT').run();
        console.log("Migration: Added rider_contact column to orders.");
    }
    if (!orderCols.includes('sc_discount_amount')) {
        db.prepare('ALTER TABLE orders ADD COLUMN sc_discount_amount REAL DEFAULT 0').run();
        console.log("Migration: Added sc_discount_amount column to orders.");
    }
    if (!orderCols.includes('promo_discount_amount')) {
        db.prepare('ALTER TABLE orders ADD COLUMN promo_discount_amount REAL DEFAULT 0').run();
        console.log("Migration: Added promo_discount_amount column to orders.");
    }
    if (!orderCols.includes('promo_id')) {
        db.prepare('ALTER TABLE orders ADD COLUMN promo_id INTEGER REFERENCES promos(id) ON DELETE SET NULL').run();
        console.log("Migration: Added promo_id column to orders.");
    }

    // Migration: Add columns for promo system upgrades if they don't exist
    // (Consolidated in the main migration block above)

    const taskCols = db.prepare("PRAGMA table_info(promo_tasks)").all().map(c => c.name);
    if (!taskCols.includes('required_category_id')) {
        db.prepare('ALTER TABLE promo_tasks ADD COLUMN required_category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE').run();
        console.log("Migration: Added required_category_id to promo_tasks.");
    }
    if (!taskCols.includes('task_type')) {
        db.prepare("ALTER TABLE promo_tasks ADD COLUMN task_type TEXT DEFAULT 'buy_specific_item'").run();
        console.log("Migration: Added task_type to promo_tasks.");
    }
    if (!taskCols.includes('rule_json')) {
        db.prepare('ALTER TABLE promo_tasks ADD COLUMN rule_json TEXT').run();
        console.log("Migration: Added rule_json to promo_tasks.");
    }
    if (!taskCols.includes('customer_description')) {
        db.prepare('ALTER TABLE promo_tasks ADD COLUMN customer_description TEXT').run();
        console.log("Migration: Added customer_description to promo_tasks.");
    }
    if (!taskCols.includes('min_order_amount')) {
        db.prepare('ALTER TABLE promo_tasks ADD COLUMN min_order_amount REAL').run();
        console.log("Migration: Added min_order_amount to promo_tasks.");
    }
    if (!taskCols.includes('end_date')) {
        db.prepare('ALTER TABLE promo_tasks ADD COLUMN end_date DATETIME').run();
        console.log("Migration: Added end_date to promo_tasks.");
    }

    // Migration: Add scheduling columns to orders
    const orderColsRefresh = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
    if (!orderColsRefresh.includes('schedule_mode')) {
        db.prepare("ALTER TABLE orders ADD COLUMN schedule_mode TEXT DEFAULT 'scheduled'").run();
        console.log("Migration: Added schedule_mode column to orders.");
    }
    if (!orderColsRefresh.includes('estimated_ready_time')) {
        db.prepare('ALTER TABLE orders ADD COLUMN estimated_ready_time DATETIME').run();
        console.log("Migration: Added estimated_ready_time column to orders.");
    }

    console.log("Database schema initialized.");
}

function seedData() {
    console.log("Seeding default data...");
    
    // Seed Admin Account (if not exists)
    const adminCheck = db.prepare(`SELECT id FROM users WHERE username = ?`).get('admin');
    if (!adminCheck) {
        const hash = bcrypt.hashSync('admin123', 10);
        db.prepare(`
            INSERT INTO users (username, email, password, role, is_verified) 
            VALUES (?, ?, ?, ?, 1)
        `).run('admin', 'admin@kapekantohub.com', hash, 'admin');
        console.log("Created default admin user (admin / admin123)");
    }

    // Seed Categories
    const categories = ['Hot Coffee', 'Iced Coffee', 'Pastries', 'Meals', 'Frappe'];
    const insertCategory = db.prepare(`INSERT OR IGNORE INTO categories (name) VALUES (?)`);
    categories.forEach(category => insertCategory.run(category));
    
    // Always sync menu items to update images/descriptions if needed
    const categoriesList = ['Hot Coffee', 'Iced Coffee', 'Pastries', 'Meals', 'Frappe'];
    const catMap = {};
    categoriesList.forEach(c => {
        const row = db.prepare(`SELECT id FROM categories WHERE name = ?`).get(c);
        if (row) catMap[c] = row.id;
    });

    const menuItems = [
        // ─── Hot Coffee ────────────────────────────────────
        ['Kanto Americano', 'Our signature bold black coffee — pure espresso & hot water, no-frills perfection.', 100.0, catMap['Hot Coffee'], 'https://images.unsplash.com/photo-1510591509098-f4fdc6d0ff04?auto=format&fit=crop&q=80&w=600', 50, 1],
        ['Kanto Latte', 'Silky steamed milk layered over a rich double espresso shot.', 125.0, catMap['Hot Coffee'], 'https://images.unsplash.com/photo-1570968015861-d53aa810ddee?auto=format&fit=crop&q=80&w=600', 50, 1],
        ['Cappuccino', 'Classic Italian-style equal-parts espresso, steamed milk, and velvety microfoam.', 130.0, catMap['Hot Coffee'], 'https://images.unsplash.com/photo-1534778101976-62847782c213?auto=format&fit=crop&q=80&w=600', 40, 1],
        ['Spanish Latte', 'Espresso sweetened with condensed milk — creamy, indulgent, and dangerously good.', 145.0, catMap['Hot Coffee'], 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&q=80&w=600', 40, 1],
        ['Flat White', 'Double ristretto espresso with velvety steamed milk — stronger than a latte.', 140.0, catMap['Hot Coffee'], 'https://images.unsplash.com/photo-1551893086-c0411bd996ee?auto=format&fit=crop&q=80&w=600', 35, 1],
        ['Caramel Macchiato', 'Freshly steamed milk with vanilla-flavored syrup marked with espresso and topped with caramel drizzle.', 150.0, catMap['Hot Coffee'], 'https://images.unsplash.com/photo-1485808191679-5f86510681a2?auto=format&fit=crop&q=80&w=600', 40, 1],
        ['Caffè Mocha', 'Rich, full-bodied espresso combined with bittersweet mocha sauce and steamed milk.', 145.0, catMap['Hot Coffee'], 'https://images.unsplash.com/photo-1607681034540-2c46cc71896d?auto=format&fit=crop&q=80&w=600', 45, 1],

        // ─── Iced Coffee ───────────────────────────────────
        ['Iced Americano', 'Double espresso chilled over ice — refreshing and unapologetically bold.', 110.0, catMap['Iced Coffee'], 'https://images.unsplash.com/photo-1517701604599-bb29b565090c?auto=format&fit=crop&q=80&w=600', 60, 1],
        ['Iced Latte', 'Cold milk meets espresso over crushed ice for a smooth daily staple.', 135.0, catMap['Iced Coffee'], 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&q=80&w=600', 60, 1],
        ['Cold Brew', 'Steeped slowly for 18 hours — naturally sweet, low-acid, incredibly smooth.', 150.0, catMap['Iced Coffee'], 'https://images.unsplash.com/photo-1494314671902-399b18174975?auto=format&fit=crop&q=80&w=600', 30, 1],
        ['Iced Spanish Latte', 'Sweet condensed milk, espresso, and ice — the classic Filipino café favorite.', 155.0, catMap['Iced Coffee'], 'https://images.unsplash.com/photo-1553909489-cd47e0907980?auto=format&fit=crop&q=80&w=600', 50, 1],
        ['Iced Caramel Macchiato', 'Vanilla-flavored syrup, milk and ice topped with espresso and caramel drizzle.', 160.0, catMap['Iced Coffee'], 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&q=80&w=600', 50, 1],
        ['Iced White Mocha', 'Espresso, milk and white chocolate sauce served over ice.', 165.0, catMap['Iced Coffee'], 'https://images.unsplash.com/photo-1553909489-cd47e0907980?auto=format&fit=crop&q=80&w=600', 40, 1],

        // ─── Frappe ────────────────────────────────────────
        ['Mocha Frappe', 'Blended espresso, rich chocolate sauce, milk, and ice — topped with whipped cream.', 165.0, catMap['Frappe'], 'https://images.unsplash.com/photo-1572490122747-3968b75cc699?auto=format&fit=crop&q=80&w=600', 40, 1],
        ['Caramel Frappe', 'Creamy blended coffee with golden caramel drizzle and whipped cream.', 165.0, catMap['Frappe'], 'https://images.unsplash.com/photo-1544145945-f904253db0ad?auto=format&fit=crop&q=80&w=600', 40, 1],
        ['Vanilla Cream Frappe', 'A smooth and creamy blend of vanilla bean, milk and ice.', 155.0, catMap['Frappe'], 'https://images.unsplash.com/photo-1571115177098-24ec42ed204d?auto=format&fit=crop&q=80&w=600', 35, 1],
        ['Hazelnut Frappe', 'Rich hazelnut syrup blended with coffee, milk and ice.', 170.0, catMap['Frappe'], 'https://images.unsplash.com/photo-1615478503562-ec2d8aa0e24e?auto=format&fit=crop&q=80&w=600', 30, 1],

        // ─── Pastries ──────────────────────────────────────
        ['Classic Croissant', 'Flaky, buttery layers baked fresh every morning — perfect with any coffee.', 85.0, catMap['Pastries'], 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?auto=format&fit=crop&q=80&w=600', 25, 1],
        ['Chocolate Chip Cookie', 'Thick, chewy, loaded with dark chocolate chunks — still warm from the oven.', 65.0, catMap['Pastries'], 'https://images.unsplash.com/photo-1499636136210-6f4ee915583e?auto=format&fit=crop&q=80&w=600', 40, 1],
        ['Pain au Chocolat', 'A buttery, flaky croissant pastry with two bars of dark chocolate inside.', 95.0, catMap['Pastries'], 'https://images.unsplash.com/photo-1530610476181-d83430b64dcd?auto=format&fit=crop&q=80&w=600', 20, 1],
        ['Cinnamon Roll', 'Warm, soft pastry swirled with cinnamon sugar and topped with cream cheese icing.', 110.0, catMap['Pastries'], 'https://images.unsplash.com/photo-1509365465985-25d11c17e812?auto=format&fit=crop&q=80&w=600', 15, 1],
        ['Carrot Cake Slice', 'Moist carrot cake with walnuts and a thick layer of cream cheese frosting.', 135.0, catMap['Pastries'], 'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?auto=format&fit=crop&q=80&w=600', 10, 1],

        // ─── Meals ─────────────────────────────────────────
        ['Beef Tapa Rice Bowl', 'Filipino cured beef served with garlic rice and sunny-side up egg.', 220.0, catMap['Meals'], 'https://images.unsplash.com/photo-1627308595229-7830a5c91f9f?auto=format&fit=crop&q=80&w=600', 20, 1],
        ['Chicken Adobo Bowl', 'Classic Filipino chicken adobo in savory soy-vinegar sauce over steamed rice.', 195.0, catMap['Meals'], 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&q=80&w=600', 20, 1],
        ['Club Sandwich', 'Triple-decker with grilled chicken, lettuce, tomato, bacon, and mayo.', 185.0, catMap['Meals'], 'https://images.unsplash.com/photo-1567234669003-dce7a7a88821?auto=format&fit=crop&q=80&w=600', 20, 1],
    ];

    const checkMenu = db.prepare(`SELECT id FROM menu_items WHERE name = ?`);
    const updateMenuImage = db.prepare(`UPDATE menu_items SET image = ?, description = ? WHERE name = ?`);
    const insertMenu = db.prepare(`
        INSERT OR IGNORE INTO menu_items (name, description, price, category_id, image, stock, is_available)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    menuItems.forEach(item => {
        const exists = checkMenu.get(item[0]);
        if (exists) {
            updateMenuImage.run(item[4], item[1], item[0]);
        } else {
            insertMenu.run(...item);
        }
    });
    console.log('Synchronized menu items with accurate images and descriptions');

        // ── Options for items with choices ─────────────────────
        const addOption = (itemName, optionName, choices) => {
            const item = db.prepare('SELECT id FROM menu_items WHERE name = ?').get(itemName);
            if (!item) return;

            const existingOption = db.prepare('SELECT id FROM menu_item_options WHERE menu_item_id = ? AND LOWER(name) = LOWER(?)').get(item.id, optionName);
            if (existingOption) return;

            const optionId = db.prepare('INSERT INTO menu_item_options (menu_item_id, name) VALUES (?, ?)').run(item.id, optionName).lastInsertRowid;
            const insertChoice = db.prepare('INSERT INTO menu_item_option_choices (option_id, name, price_adjustment) VALUES (?, ?, ?)');
            choices.forEach(([name, adj]) => insertChoice.run(optionId, name, adj));
        };

        // Temperature options for hot drinks
        ['Kanto Americano','Kanto Latte','Cappuccino','Spanish Latte','Flat White'].forEach(name =>
            addOption(name, 'Temperature', [['Standard Hot', 0], ['Extra Hot', 0], ['Iced (switch to cold)', 10]])
        );

        // Sugar level for all coffees
        ['Kanto Americano','Kanto Latte','Cappuccino','Iced Americano','Iced Latte','Cold Brew','Iced Spanish Latte'].forEach(name =>
            addOption(name, 'Sugar Level', [['No Sugar', 0], ['Less Sweet', 0], ['Regular', 0], ['Extra Sweet', 0]])
        );

        // Size for frappes
        ['Mocha Frappe','Caramel Frappe','Matcha Frappe','Strawberry Frappe'].forEach(name =>
            addOption(name, 'Size', [['Regular (16oz)', 0], ['Large (22oz)', 25]])
        );

        // Whip option for frappes
        ['Mocha Frappe','Caramel Frappe','Matcha Frappe','Strawberry Frappe'].forEach(name =>
            addOption(name, 'Whipped Cream', [['With Whip', 0], ['No Whip', 0]])
        );

        // Milk option for lattes
        ['Kanto Latte','Iced Latte','Spanish Latte','Iced Spanish Latte','Flat White'].forEach(name =>
            addOption(name, 'Milk Type', [['Full Cream', 0], ['Oat Milk', 15], ['Almond Milk', 15], ['Non-fat', 0]])
        );

        // Egg doneness for breakfast
        addOption('Egg & Bacon Sandwich', 'Egg Style', [['Scrambled', 0], ['Sunny-Side Up', 0], ['Over Easy', 0]]);

        console.log('Created menu options and choices');

        // Seed Sample Promo Task
        const kantoAmericano = db.prepare("SELECT id FROM menu_items WHERE name = 'Kanto Americano'").get();
        const discountPromo = db.prepare("SELECT id FROM promos WHERE promo_code = 'SUMMER20'").get(); 
        
        if (kantoAmericano) {
            let pId = discountPromo ? discountPromo.id : null;
            if (!pId) {
                db.prepare("INSERT OR IGNORE INTO promos (title, description, discount_percent, promo_code, is_active) VALUES ('Task Reward', '20% Off Reward', 20, 'REWARD20', 1)").run();
                const newP = db.prepare("SELECT id FROM promos WHERE promo_code = 'REWARD20'").get();
                pId = newP ? newP.id : null;
            }

            db.prepare(`
                INSERT INTO promo_tasks (title, description, required_menu_item_id, required_quantity, reward_promo_id)
                SELECT 'Buy 5 Americanos', 'Buy 5 Kanto Americanos and get a 20% discount coupon!', ?, 5, ?
                WHERE NOT EXISTS (SELECT 1 FROM promo_tasks WHERE title = 'Buy 5 Americanos')
            `).run(kantoAmericano.id, pId);
            console.log("Created sample purchase-based promo task");
        }
    
    console.log("Seeding complete.");
}

// Run if executed directly
if (require.main === module) {
    initDb();
    seedData();
    console.log("Database setup finished.");
}

module.exports = { db, initDb, seedData };
