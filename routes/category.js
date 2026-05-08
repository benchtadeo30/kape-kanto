const express = require('express');
const router = express.Router();
const { db } = require('../database/init');
const { requireRole } = require('../middleware/auth');

// GET /api/categories (Public)
router.get('/', (req, res) => {
    const limit = parseInt(req.query.limit);
    const offset = parseInt(req.query.offset) || 0;

    try {
        let query = `SELECT * FROM categories`;
        let countQuery = `SELECT COUNT(*) as total FROM categories`;

        if (!isNaN(limit)) {
            query += ` LIMIT ? OFFSET ?`;
        }

        const categories = !isNaN(limit)
            ? db.prepare(query).all(limit, offset)
            : db.prepare(query).all();
        
        const total = db.prepare(countQuery).get().total;

        if (!isNaN(limit)) {
            res.json({ items: categories, total });
        } else {
            res.json(categories);
        }
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/categories (Admin only)
router.post('/', requireRole('admin'), (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Category name is required.' });

    try {
        // Validation: Check for duplicate name
        const existing = db.prepare(`SELECT id FROM categories WHERE LOWER(name) = LOWER(?)`).get(name);
        if (existing) {
            return res.status(400).json({ error: 'A category with this name already exists.' });
        }

        const stmt = db.prepare(`INSERT INTO categories (name) VALUES (?)`);
        const info = stmt.run(name);
        res.status(201).json({ message: 'Category created.', id: info.lastInsertRowid });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// PUT /api/categories/:id (Admin only)
router.put('/:id', requireRole('admin'), (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Category name is required.' });

    try {
        // Validation: Check for duplicate name (excluding current)
        const existing = db.prepare(`SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND id != ?`).get(name, req.params.id);
        if (existing) {
            return res.status(400).json({ error: 'Another category with this name already exists.' });
        }

        const info = db.prepare(`UPDATE categories SET name=? WHERE id=?`).run(name, req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: 'Category not found.' });
        res.json({ message: 'Category updated.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// DELETE /api/categories/:id (Admin only)
router.delete('/:id', requireRole('admin'), (req, res) => {
    try {
        // Check if category is in use
        const inUse = db.prepare(`SELECT count(*) as count FROM menu_items WHERE category_id=?`).get(req.params.id);
        if (inUse.count > 0) {
            return res.status(400).json({ error: 'Cannot delete category that is in use by menu items.' });
        }

        const info = db.prepare(`DELETE FROM categories WHERE id=?`).run(req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: 'Category not found.' });
        res.json({ message: 'Category deleted.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

module.exports = router;
