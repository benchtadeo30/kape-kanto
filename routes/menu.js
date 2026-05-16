const express = require('express');
const router = express.Router();
const { db } = require('../database/init');
const { requireRole } = require('../middleware/auth');
const upload = require('../middleware/upload');

const DEFAULT_MENU_IMAGE = 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&q=80&w=800';

function buildInternetImageUrl(name) {
    const cleaned = String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .replace(/\s+/g, ',')
        .replace(/,+/g, ',')
        .replace(/^,|,$/g, '');

    if (!cleaned) return DEFAULT_MENU_IMAGE;
    return `https://loremflickr.com/800/600/${encodeURIComponent(`${cleaned},cafe,food,drink`)}?lock=${hashName(name)}`;
}

function normalizeMenuItemImage(item) {
    if (!item.image || item.image.includes('source.unsplash.com')) {
        return { ...item, image: buildInternetImageUrl(item.name) };
    }
    return item;
}

function hashName(value) {
    return String(value || '').split('').reduce((hash, char) => {
        return ((hash << 5) - hash + char.charCodeAt(0)) >>> 0;
    }, 0) % 100000;
}

function parseOptionsPayload(rawOptions) {
    if (!rawOptions) return [];

    let parsed = rawOptions;
    if (typeof rawOptions === 'string') {
        try {
            parsed = JSON.parse(rawOptions);
        } catch (e) {
            return [];
        }
    }

    if (!Array.isArray(parsed)) return [];

    return parsed.map(option => ({
        name: String(option.name || '').trim(),
        choices: Array.isArray(option.choices) ? option.choices.map(choice => ({
            name: String(choice.name || '').trim(),
            price_adjustment: Number.parseFloat(choice.price_adjustment) || 0
        })).filter(choice => choice.name) : []
    })).filter(option => option.name && option.choices.length > 0);
}

async function replaceMenuItemOptions(menuItemId, options) {
    await db.prepare(`DELETE FROM menu_item_options WHERE menu_item_id = ?`).run(menuItemId);

    for (const option of options) {
        const optResult = await db.prepare(`INSERT INTO menu_item_options (menu_item_id, name) VALUES (?, ?)`).run(menuItemId, option.name);
        const optionId = optResult.lastInsertRowid;
        for (const choice of option.choices) {
            await db.prepare(`INSERT INTO menu_item_option_choices (option_id, name, price_adjustment) VALUES (?, ?, ?)`).run(optionId, choice.name, choice.price_adjustment);
        }
    }
}

// GET /api/menu (Public)
router.get('/', async (req, res) => {
    const limit = parseInt(req.query.limit);
    const offset = parseInt(req.query.offset) || 0;
    const search = req.query.search || '';
    const category_id = req.query.category_id;
    const available_only = req.query.available_only === 'true';

    try {
        let itemsQuery = `
            SELECT m.*, c.name as category_name 
            FROM menu_items m
            LEFT JOIN categories c ON m.category_id = c.id
        `;
        let countQuery = `SELECT COUNT(*) as total FROM menu_items m`;
        const params = [];
        const countParams = [];
        const conditions = [];

        if (search) {
            conditions.push(`(m.name LIKE ? OR m.description LIKE ?)`);
            params.push(`%${search}%`, `%${search}%`);
            countParams.push(`%${search}%`, `%${search}%`);
        }

        if (category_id && category_id !== 'all') {
            const categoryIds = String(category_id)
                .split(',')
                .map(id => parseInt(id, 10))
                .filter(Number.isInteger);

            if (categoryIds.length > 0) {
                const placeholders = categoryIds.map(() => '?').join(',');
                conditions.push(`m.category_id IN (${placeholders})`);
                params.push(...categoryIds);
                countParams.push(...categoryIds);
            }
        }

        if (available_only) {
            conditions.push(`m.is_available = 1`);
        }

        if (conditions.length > 0) {
            const whereClause = ` WHERE ` + conditions.join(' AND ');
            itemsQuery += whereClause;
            countQuery += whereClause;
        }

        itemsQuery += ` ORDER BY m.created_at DESC`;

        if (!isNaN(limit)) {
            itemsQuery += ` LIMIT ? OFFSET ?`;
            params.push(limit, offset);
        }

        const items = (await db.prepare(itemsQuery).all(...params)).map(normalizeMenuItemImage);
        const total = (await db.prepare(countQuery).get(...countParams)).total;
        
        if (!isNaN(limit)) {
            res.json({ items, total });
        } else {
            res.json(items);
        }
    } catch (error) {
        console.error('Menu API error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// GET /api/menu/:id/options (Public)
router.get('/:id/options', async (req, res) => {
    try {
        const options = await db.prepare(`SELECT * FROM menu_item_options WHERE menu_item_id = ?`).all(req.params.id);
        
        const optionsWithChoices = [];
        for (const opt of options) {
            const choices = await db.prepare(`SELECT * FROM menu_item_option_choices WHERE option_id = ?`).all(opt.id);
            optionsWithChoices.push({ ...opt, choices });
        }
        
        res.json(optionsWithChoices);
    } catch (error) {
        console.error('Failed to fetch item options:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// GET /api/menu/categories (Public)
router.get('/categories', async (req, res) => {
    const limit = parseInt(req.query.limit);
    const offset = parseInt(req.query.offset) || 0;
    const search = req.query.search || '';

    try {
        let query = `SELECT * FROM categories`;
        let countQuery = `SELECT COUNT(*) as total FROM categories`;
        const params = [];
        const countParams = [];

        if (search) {
            query += ` WHERE name LIKE ?`;
            countQuery += ` WHERE name LIKE ?`;
            params.push(`%${search}%`);
            countParams.push(`%${search}%`);
        }

        query += ` ORDER BY name COLLATE NOCASE ASC`;

        if (!isNaN(limit)) {
            query += ` LIMIT ? OFFSET ?`;
            params.push(limit, offset);
        }

        const categories = await db.prepare(query).all(...params);
        const total = (await db.prepare(countQuery).get(...countParams)).total;

        if (!isNaN(limit)) {
            let idsQuery = `SELECT id FROM categories`;
            const idsParams = [];

            if (search) {
                idsQuery += ` WHERE name LIKE ?`;
                idsParams.push(`%${search}%`);
            }

            idsQuery += ` ORDER BY name COLLATE NOCASE ASC`;
            const ids = (await db.prepare(idsQuery).all(...idsParams)).map(row => row.id);
            res.json({ items: categories, total, ids });
        } else {
            res.json(categories);
        }
    } catch (error) {
        console.error('Category list error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/menu (Admin only)
router.post('/', requireRole('admin'), upload.single('image'), async (req, res) => {
    const { name, description, price, category_id, stock, is_available, options } = req.body;
    const imagePath = req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : buildInternetImageUrl(name);

    if (!name || !price) {
        return res.status(400).json({ error: 'Name and price are required.' });
    }

    try {
        await db.beginTransaction();

        const existing = await db.prepare(`SELECT id FROM menu_items WHERE LOWER(name) = LOWER(?)`).get(name);
        if (existing) {
            await db.rollback();
            return res.status(400).json({ error: 'A menu item with this name already exists.' });
        }

        const info = await db.prepare(`
            INSERT INTO menu_items (name, description, price, category_id, image, stock, is_available)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(name, description, price, category_id, imagePath, stock || 0, is_available || 1);
        await replaceMenuItemOptions(info.lastInsertRowid, parseOptionsPayload(options));
        await db.commit();
        res.status(201).json({ message: 'Menu item created.', id: info.lastInsertRowid });
    } catch (error) {
        await db.rollback();
        console.error('Create Menu Item Error:', error);
        res.status(500).json({ error: 'Internal server error: ' + error.message });
    }
});

// PUT /api/menu/:id (Admin only)
router.put('/:id', requireRole('admin', 'staff'), upload.single('image'), async (req, res) => {
    const { name, description, price, category_id, stock, is_available, options } = req.body;
    const itemId = req.params.id;

    try {
        await db.beginTransaction();

        const existing = await db.prepare(`SELECT id FROM menu_items WHERE LOWER(name) = LOWER(?) AND id != ?`).get(name, itemId);
        if (existing) {
            await db.rollback();
            return res.status(400).json({ error: 'Another menu item with this name already exists.' });
        }

        let info;

        if (req.file) {
            const imagePath = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
            info = await db.prepare(`
                UPDATE menu_items 
                SET name=?, description=?, price=?, category_id=?, image=?, stock=?, is_available=?, updated_at=CURRENT_TIMESTAMP
                WHERE id=?
            `).run(name, description, price, category_id, imagePath, stock || 0, is_available || 0, itemId);
        } else {
            info = await db.prepare(`
                UPDATE menu_items 
                SET name=?, description=?, price=?, category_id=?, stock=?, is_available=?, updated_at=CURRENT_TIMESTAMP
                WHERE id=?
            `).run(name, description, price, category_id, stock || 0, is_available || 0, itemId);
        }

        if (info.changes === 0) {
            await db.rollback();
            return res.status(404).json({ error: 'Menu item not found.' });
        }
        await replaceMenuItemOptions(itemId, parseOptionsPayload(options));
        await db.commit();
        res.json({ message: 'Menu item updated.' });
    } catch (error) {
        await db.rollback();
        console.error('Update Menu Item Error:', error);
        res.status(500).json({ error: 'Internal server error: ' + error.message });
    }
});

// DELETE /api/menu/:id (Admin only)
router.delete('/:id', requireRole('admin'), async (req, res) => {
    try {
        const info = await db.prepare(`DELETE FROM menu_items WHERE id=?`).run(req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: 'Menu item not found.' });
        res.json({ message: 'Menu item deleted.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// PATCH /api/menu/:id/stock (Admin/Staff only)
router.patch('/:id/stock', requireRole('admin', 'staff'), async (req, res) => {
    const { stock } = req.body;
    if (stock === undefined) return res.status(400).json({ error: 'Stock value required.' });

    try {
        const info = await db.prepare(`UPDATE menu_items SET stock=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(stock, req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: 'Menu item not found.' });
        res.json({ message: 'Stock updated.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

module.exports = router;
