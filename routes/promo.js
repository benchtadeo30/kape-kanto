const express = require('express');
const router = express.Router();
const { db } = require('../database/init');
const { requireRole, requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');

// GET /api/promos (Public - Unified promos & tasks, with pagination)
router.get('/', async (req, res) => {
    const limit = parseInt(req.query.limit) || 6;
    const offset = parseInt(req.query.offset) || 0;

    try {
        const promoQuery = `
            SELECT id, title, description, discount_percent, discount_amount, image, 
                   start_date, end_date, promo_code, 'promo' as event_type, created_at
            FROM promos p
            WHERE p.is_active = 1 
            AND NOT EXISTS (SELECT 1 FROM promo_tasks pt WHERE pt.reward_promo_id = p.id)
            AND (p.end_date IS NULL OR p.end_date = '' OR datetime(p.end_date) >= datetime('now', '+8 hours'))
        `;

        const taskQuery = `
            SELECT pt.id, pt.title, pt.description, 0 as discount_percent, 0 as discount_amount, p.image,
                   p.start_date, pt.end_date, NULL as promo_code, 'task' as event_type, p.created_at
            FROM promo_tasks pt
            LEFT JOIN promos p ON pt.reward_promo_id = p.id
            WHERE pt.is_active = 1
            AND (pt.end_date IS NULL OR pt.end_date = '' OR datetime(pt.end_date) >= datetime('now', '+8 hours'))
        `;

        const unifiedQuery = `
            SELECT * FROM (${promoQuery} UNION ALL ${taskQuery}) as combined
            ORDER BY 
                CASE 
                    WHEN start_date IS NOT NULL AND datetime(start_date) > datetime('now', '+8 hours') THEN 1 
                    ELSE 0 
                END ASC,
                COALESCE(created_at, '0000-00-00') DESC, 
                id DESC
            LIMIT ? OFFSET ?
        `;

        const items = await db.prepare(unifiedQuery).all(limit, offset);
        const countQuery = `SELECT COUNT(*) as count FROM (${promoQuery} UNION ALL ${taskQuery}) as combined`;
        const total = (await db.prepare(countQuery).get()).count;

        console.log(`[PROMO API] Found ${items.length} active items (Total: ${total})`);
        res.json({ items, total, limit, offset });
    } catch (error) {
        console.error('[PROMO LIST ERROR]:', error);
        res.status(500).json({ error: 'Internal server error.', details: error.message });
    }
});

// GET /api/promos/all (Admin - All promos)
router.get('/all', requireRole('admin'), async (req, res) => {
    try {
        const promos = await db.prepare(`
            SELECT p.* FROM promos p
            WHERE NOT EXISTS (SELECT 1 FROM promo_tasks pt WHERE pt.reward_promo_id = p.id)
        `).all();
        res.json(promos);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// GET /api/promos/context (Admin)
router.get('/context', requireRole('admin'), async (req, res) => {
    try {
        const menuItems = await db.prepare(`SELECT id, name, category_id, image FROM menu_items WHERE is_available = 1`).all();
        const categories = await db.prepare(`SELECT id, name FROM categories`).all();
        res.json({ menuItems, categories });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// GET /api/promos/tasks (Admin - All tasks)
router.get('/tasks', requireRole('admin'), async (req, res) => {
    try {
        const tasks = await db.prepare(`
            SELECT pt.*, p.promo_code, p.image, p.discount_percent as reward_discount
            FROM promo_tasks pt
            LEFT JOIN promos p ON pt.reward_promo_id = p.id
            ORDER BY pt.id DESC
        `).all();
        res.json(tasks);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// GET /api/promos/tasks/my-progress (Customer)
router.get('/tasks/my-progress', requireAuth, async (req, res) => {
    try {
        const tasks = await db.prepare(`
            SELECT pt.id, pt.title, pt.customer_description, pt.task_type, pt.required_quantity,
                   COALESCE(up.current_quantity, 0) as current_quantity,
                   COALESCE(up.is_completed, 0) as is_completed,
                   p.promo_code as reward_code, p.discount_percent as reward_discount
            FROM promo_tasks pt
            LEFT JOIN user_promo_progress up ON pt.id = up.promo_task_id AND up.user_id = ?
            LEFT JOIN promos p ON pt.reward_promo_id = p.id
            WHERE pt.is_active = 1
            AND (pt.end_date IS NULL OR pt.end_date = '' OR datetime(pt.end_date) >= datetime('now', '+8 hours'))
            ORDER BY COALESCE(up.is_completed, 0) ASC, pt.id DESC
        `).all(req.session.userId);
        res.json(tasks);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/promos/validate (Customer)
router.post('/validate', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Promo code required.' });

    try {
        const userId = req.session.userId;
        const promo = await db.prepare(`
            SELECT p.*, 
                   (SELECT id FROM promo_tasks WHERE reward_promo_id = p.id LIMIT 1) as is_loyalty_reward
            FROM promos p
            WHERE UPPER(p.promo_code) = UPPER(?) 
            AND p.is_active = 1 
            AND (p.start_date IS NULL OR p.start_date = '' OR datetime(p.start_date) <= datetime('now', '+8 hours'))
            AND (p.end_date IS NULL OR p.end_date = '' OR datetime(p.end_date) >= datetime('now', '+8 hours'))
        `).get(code);

        if (!promo) {
            return res.status(404).json({ error: 'Invalid or expired promo code.' });
        }

        const coupon = await db.prepare(`SELECT * FROM user_coupons WHERE user_id = ? AND promo_id = ?`).get(userId, promo.id);

        if (promo.is_loyalty_reward) {
            if (!userId) {
                return res.status(403).json({ error: 'Please log in to use your loyalty rewards.' });
            }
            const currentLimit = Math.max(coupon?.usage_limit || 0, promo.usage_limit || 1);
            if (!coupon || (coupon.times_used >= currentLimit)) {
                return res.status(403).json({ error: 'You have not unlocked this reward or it has already reached its usage limit.' });
            }
        } else if (promo.usage_limit > 0 && userId) {
            // Public promo with usage limit
            const currentLimit = Math.max(coupon?.usage_limit || 0, promo.usage_limit || 0);
            if (coupon && (coupon.times_used >= currentLimit)) {
                return res.status(403).json({ error: 'You have reached the usage limit for this promo code.' });
            }
        }

        try {
            if (promo.applicable_category_ids && typeof promo.applicable_category_ids === 'string') {
                promo.applicable_category_ids = JSON.parse(promo.applicable_category_ids);
            }
            if (promo.applicable_menu_item_ids && typeof promo.applicable_menu_item_ids === 'string') {
                promo.applicable_menu_item_ids = JSON.parse(promo.applicable_menu_item_ids);
            }
        } catch (e) {
            promo.applicable_category_ids = [];
            promo.applicable_menu_item_ids = [];
        }

        res.json({
            ...promo,
            times_used: coupon ? coupon.times_used : 0,
            user_limit: Math.max(coupon?.usage_limit || 0, (promo.is_loyalty_reward ? (promo.usage_limit || 1) : (promo.usage_limit || 0)))
        });
    } catch (error) {
        console.error('Validation Error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// GET /api/promos/validate - Catch accidental GET requests
router.get('/validate', (req, res) => {
    res.status(405).json({ error: 'Method Not Allowed. Use POST to validate promo codes.' });
});

// GET /api/promos/:id (Public)
router.get('/:id', async (req, res) => {
    try {
        const promo = await db.prepare(`SELECT * FROM promos WHERE id = ?`).get(req.params.id);
        if (!promo) return res.status(404).json({ error: 'Promo not found' });

        const items = await db.prepare(`
            SELECT m.* FROM menu_items m
            JOIN promo_items pi ON m.id = pi.menu_item_id
            WHERE pi.promo_id = ?
        `).all(promo.id);

        promo.items = items;
        res.json(promo);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

router.post('/', requireRole('admin'), upload.single('image'), async (req, res) => {
    const { 
        title, description, discount_percent, discount_amount, start_date, end_date, is_active, promo_code, 
        is_loyalty_task, task_type, required_quantity, required_menu_item_id, required_category_id, 
        min_order_amount, applicable_category_id, applicable_menu_item_id,
        applicable_category_ids, applicable_menu_item_ids, usage_limit
    } = req.body;
    const imagePath = req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : null;

    // Validate required fields
    if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Campaign title is required.' });
    }
    if (!promo_code || !promo_code.trim()) {
        return res.status(400).json({ error: 'Promo code is required.' });
    }

    try {
        const info = await db.prepare(`
            INSERT INTO promos (
                title, description, discount_percent, discount_amount, image, start_date, end_date, is_active, promo_code,
                applicable_category_id, applicable_menu_item_id,
                applicable_category_ids, applicable_menu_item_ids,
                usage_limit
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            title, description, 
            parseFloat(discount_percent) || 0, 
            parseFloat(discount_amount) || 0, 
            imagePath,
            start_date || null, end_date || null,
            is_active == '1' ? 1 : 0, promo_code || null,
            applicable_category_id || null, applicable_menu_item_id || null,
            applicable_category_ids || '[]', applicable_menu_item_ids || '[]',
            parseInt(usage_limit) || 1
        );
        const promoId = info.lastInsertRowid;

        if (is_loyalty_task == '1') {
            await db.prepare(`
                INSERT INTO promo_tasks (
                    title, description, task_type, customer_description, 
                    required_menu_item_id, required_category_id, required_quantity, 
                    min_order_amount, reward_promo_id, is_active, start_date, end_date
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                title, description, task_type, description, 
                parseInt(required_menu_item_id) || null, 
                parseInt(required_category_id) || null, 
                parseInt(required_quantity) || 1, 
                parseFloat(min_order_amount) || null, 
                promoId, 1, start_date || null, end_date || null
            );
        }

        res.status(201).json({ message: 'Campaign created successfully.', id: promoId });
    } catch (error) {
        console.error('[PROMO ERROR] Failed to create promo:', error);
        if (error.message && error.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'This promo code already exists. Please use a unique code.' });
        }
        res.status(500).json({ error: 'Internal server error.', details: error.message });
    }
});

// PUT /api/promos/:id (Admin)
router.put('/:id', requireRole('admin'), upload.single('image'), async (req, res) => {
    const { 
        title, description, discount_percent, discount_amount, start_date, end_date, is_active, promo_code,
        applicable_category_ids, applicable_menu_item_ids,
        is_loyalty_task, task_type, required_quantity, required_menu_item_id, required_category_id,
        min_order_amount, usage_limit
    } = req.body;
    const campaignId = req.params.id;

    // Validate required fields
    if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Campaign title is required.' });
    }
    if (!promo_code || !promo_code.trim()) {
        return res.status(400).json({ error: 'Promo code is required.' });
    }

    try {
        if (is_loyalty_task == '1') {
            const task = await db.prepare('SELECT reward_promo_id FROM promo_tasks WHERE id = ?').get(campaignId);
            if (!task) throw new Error('Task not found');

            await db.prepare(`
                UPDATE promo_tasks SET 
                    title=?, description=?, task_type=?, customer_description=?,
                    required_menu_item_id=?, required_category_id=?, required_quantity=?,
                    min_order_amount=?, is_active=?, start_date=?, end_date=?
                WHERE id=?
            `).run(
                title, description, task_type, description,
                required_menu_item_id || null, required_category_id || null,
                parseInt(required_quantity) || 1, parseFloat(min_order_amount) || null,
                is_active == '1' ? 1 : 0, start_date || null, end_date || null, campaignId
            );

            const promoId = task.reward_promo_id;
            if (req.file) {
                const imagePath = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
                await db.prepare(`
                    UPDATE promos SET 
                        title=?, description=?, discount_percent=?, discount_amount=?, image=?, 
                        start_date=?, end_date=?, is_active=?, promo_code=?,
                        applicable_category_ids=?, applicable_menu_item_ids=?,
                        usage_limit=?
                    WHERE id=?
                `).run(title, description, discount_percent || 0, discount_amount || 0, imagePath, start_date || null, end_date || null, is_active == '1' ? 1 : 0, promo_code || null, applicable_category_ids || '[]', applicable_menu_item_ids || '[]', parseInt(usage_limit) || 1, promoId);
            } else {
                await db.prepare(`
                    UPDATE promos SET 
                        title=?, description=?, discount_percent=?, discount_amount=?,
                        start_date=?, end_date=?, is_active=?, promo_code=?,
                        applicable_category_ids=?, applicable_menu_item_ids=?,
                        usage_limit=?
                    WHERE id=?
                `).run(title, description, discount_percent || 0, discount_amount || 0, start_date || null, end_date || null, is_active == '1' ? 1 : 0, promo_code || null, applicable_category_ids || '[]', applicable_menu_item_ids || '[]', parseInt(usage_limit) || 1, promoId);
            }
        } else {
            if (req.file) {
                const imagePath = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
                await db.prepare(`
                    UPDATE promos SET 
                        title=?, description=?, discount_percent=?, discount_amount=?, image=?, 
                        start_date=?, end_date=?, is_active=?, promo_code=?,
                        applicable_category_ids=?, applicable_menu_item_ids=?,
                        usage_limit=?
                    WHERE id=?
                `).run(title, description, discount_percent || 0, discount_amount || 0, imagePath, start_date || null, end_date || null, is_active == '1' ? 1 : 0, promo_code || null, applicable_category_ids || '[]', applicable_menu_item_ids || '[]', parseInt(usage_limit) || 1, campaignId);
            } else {
                await db.prepare(`
                    UPDATE promos SET 
                        title=?, description=?, discount_percent=?, discount_amount=?,
                        start_date=?, end_date=?, is_active=?, promo_code=?,
                        applicable_category_ids=?, applicable_menu_item_ids=?,
                        usage_limit=?
                    WHERE id=?
                `).run(title, description, discount_percent || 0, discount_amount || 0, start_date || null, end_date || null, is_active == '1' ? 1 : 0, promo_code || null, applicable_category_ids || '[]', applicable_menu_item_ids || '[]', parseInt(usage_limit) || 1, campaignId);
            }
        }

        res.json({ message: 'Campaign updated successfully.' });
    } catch (error) {
        console.error('Update Error:', error);
        if (error.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Promo code must be unique.' });
        }
        res.status(500).json({ error: error.message || 'Internal server error.' });
    }
});

// DELETE /api/promos/cleanup (Admin - Cleanup)
router.delete('/cleanup', requireRole('admin'), async (req, res) => {
    try {
        const expiredTasks = await db.prepare(`
            SELECT id, reward_promo_id FROM promo_tasks 
            WHERE (end_date IS NOT NULL AND datetime(end_date) < datetime('now', '+8 hours')) 
            OR is_active = 0
        `).all();
        let deletedCount = 0;

        for (const t of expiredTasks) {
            const resTask = await db.prepare('DELETE FROM promo_tasks WHERE id = ?').run(t.id);
            deletedCount += resTask.changes;
            if (t.reward_promo_id) {
                const resPromo = await db.prepare('DELETE FROM promos WHERE id = ?').run(t.reward_promo_id);
                deletedCount += resPromo.changes;
            }
        }

        const resPromos = await db.prepare(`
            DELETE FROM promos 
            WHERE (end_date IS NOT NULL AND datetime(end_date) < datetime('now', '+8 hours')) 
            OR is_active = 0
        `).run();
        deletedCount += resPromos.changes;

        res.json({ message: `Purge complete. Removed ${deletedCount} expired/inactive items.` });
    } catch (error) {
        console.error('Purge Error:', error);
        res.status(500).json({ error: 'Failed to purge data.' });
    }
});

// DELETE /api/promos/:id (Admin)
router.delete('/:id', requireRole('admin'), async (req, res) => {
    try {
        const promo = await db.prepare('SELECT id FROM promos WHERE id = ?').get(req.params.id);
        if (!promo) return res.status(404).json({ error: 'Promo not found.' });

        await db.prepare('DELETE FROM promo_tasks WHERE reward_promo_id = ?').run(req.params.id);
        const info = await db.prepare(`DELETE FROM promos WHERE id=?`).run(req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: 'Promo not found.' });
        res.json({ message: 'Promo deleted.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});


// POST /api/promos/ai-generate (Admin)
router.post('/ai-generate', requireRole('admin'), async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Task description is required.' });

    const allowedTaskTypes = [
        "minimum_spend", "buy_specific_item", "buy_from_category",
        "first_order", "order_count", "verify_email",
    ];

    try {
        const menuItems = await db.prepare(`SELECT id, name, category_id FROM menu_items WHERE is_available = 1`).all();
        const categories = await db.prepare(`SELECT id, name FROM categories`).all();

        const schema = {
            type: "object",
            properties: {
                task_type: { type: "string", enum: allowedTaskTypes },
                task_title: { type: "string" },
                customer_description: { type: "string" },
                menu_item_id: { type: "integer", nullable: true },
                category_id: { type: "integer", nullable: true },
                category: { type: "string", nullable: true },
                min_quantity: { type: "integer" },
                min_order_amount: { type: "number", nullable: true },
                reward_discount_percent: { type: "number" },
                reward_promo_code: { type: "string" },
                end_date: { type: "string", nullable: true },
                is_valid: { type: "boolean" },
                error_message: { type: "string", nullable: true }
            },
            required: ["task_type", "task_title", "customer_description", "min_quantity", "reward_discount_percent", "reward_promo_code", "is_valid"]
        };

        const aiPrompt = `
You are a rule engine for a café ordering system.
Convert the admin's task description into a strict JSON rule.

Only use these allowed task types:
- minimum_spend (customer must spend a minimum amount)
- buy_specific_item (customer must buy a specific menu item)
- buy_from_category (customer must buy from a specific category)
- first_order (first-time customer)
- order_count (customer must complete N orders total)
- verify_email (customer must verify their email address)

Available Categories:
${JSON.stringify(categories)}

Available Menu Items:
${JSON.stringify(menuItems)}

Admin's description:
"${prompt}"

Rules:
1. Map the request to the correct task_type. For "verify email", use verify_email.
2. If they mention a specific item, use buy_specific_item and set menu_item_id. If they mention a category, use buy_from_category and set category_id.
3. Set min_quantity based on the request (default 1).
4. Set min_order_amount if they mention a minimum spend (e.g., "spend at least \u20B1200").
5. Generate a short uppercase reward_promo_code (e.g., "VERIFY10OFF").
6. Set reward_discount_percent based on the request (e.g. 10).
7. Write a friendly customer_description explaining the task in 1-2 sentences with emoji.
8. Set is_valid to true UNLESS the request explicitly asks to buy an item/category that is missing from the provided lists. Non-purchase tasks (like verify_email, first_order, order_count, minimum_spend) are ALWAYS valid.
9. If the prompt specifies a deadline or limited timeframe (e.g., "by next week", "until Friday", "before December"), calculate and return an ISO-8601 string for end_date. Current datetime is ${new Date().toISOString()}. Otherwise, leave it null.

Respond ONLY with a valid JSON object. No explanation.`;

        res.json({ prompt: aiPrompt, schema: schema });
    } catch (error) {
        console.error('Task Generation Error:', error);
        res.status(500).json({ error: 'Failed to generate task context. Please try again.' });
    }
});

// POST /api/promos/ai-confirm (Admin)
router.post('/ai-confirm', requireRole('admin'), async (req, res) => {
    const { rule } = req.body;
    if (!rule || !rule.task_type) return res.status(400).json({ error: 'Invalid rule data.' });

    const allowedTaskTypes = [
        "minimum_spend", "buy_specific_item", "buy_from_category",
        "first_order", "order_count", "verify_email"
    ];

    if (!allowedTaskTypes.includes(rule.task_type)) {
        return res.status(400).json({ error: 'Invalid task type.' });
    }

    try {
        const insertPromo = await db.prepare(`
            INSERT INTO promos (title, description, discount_percent, promo_code, is_active, end_date, applicable_category_ids, applicable_menu_item_ids)
            VALUES (?, ?, ?, ?, 1, ?, '[]', '[]')
        `).run(
            rule.task_title + ' Reward',
            rule.customer_description,
            rule.reward_discount_percent,
            rule.reward_promo_code,
            rule.end_date || null
        );
        const newPromoId = insertPromo.lastInsertRowid;

        await db.prepare(`
            INSERT INTO promo_tasks (title, description, task_type, rule_json, customer_description,
                required_menu_item_id, required_category_id, required_quantity, min_order_amount, end_date, reward_promo_id, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(
            rule.task_title,
            rule.customer_description,
            rule.task_type,
            JSON.stringify(rule),
            rule.customer_description,
            rule.menu_item_id || null,
            rule.category_id || null,
            rule.min_quantity || 1,
            rule.min_order_amount || null,
            rule.end_date || null,
            newPromoId
        );

        res.json({ message: 'Coupon task created successfully!', promo_code: rule.reward_promo_code });
    } catch (error) {
        console.error('Task Save Error:', error);
        if (error.message && error.message.includes('UNIQUE constraint')) {
            return res.status(400).json({ error: 'A promo with that code already exists. Please generate again.' });
        }
        res.status(500).json({ error: 'Failed to save task.' });
    }
});

// DELETE /api/promos/tasks/:id (Admin)
router.delete('/tasks/:id', requireRole('admin'), async (req, res) => {
    try {
        const task = await db.prepare('SELECT reward_promo_id FROM promo_tasks WHERE id = ?').get(req.params.id);
        if (!task) return res.status(404).json({ error: 'Task not found.' });

        await db.prepare('DELETE FROM promo_tasks WHERE id = ?').run(req.params.id);
        if (task.reward_promo_id) {
            await db.prepare('DELETE FROM promos WHERE id = ?').run(task.reward_promo_id);
        }
        res.json({ message: 'Task deleted.' });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// PATCH /api/promos/tasks/:id/toggle (Admin)
router.patch('/tasks/:id/toggle', requireRole('admin'), async (req, res) => {
    try {
        const task = await db.prepare('SELECT is_active FROM promo_tasks WHERE id = ?').get(req.params.id);
        if (!task) return res.status(404).json({ error: 'Task not found.' });

        const newStatus = task.is_active ? 0 : 1;
        await db.prepare('UPDATE promo_tasks SET is_active = ? WHERE id = ?').run(newStatus, req.params.id);
        res.json({ message: `Task ${newStatus ? 'activated' : 'deactivated'}.` });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// PATCH /api/promos/:id/toggle (Admin)
router.patch('/:id/toggle', requireRole('admin'), async (req, res) => {
    try {
        const promo = await db.prepare('SELECT is_active FROM promos WHERE id = ?').get(req.params.id);
        if (!promo) return res.status(404).json({ error: 'Promo not found.' });

        const newStatus = promo.is_active ? 0 : 1;
        await db.prepare('UPDATE promos SET is_active = ? WHERE id = ?').run(newStatus, req.params.id);
        res.json({ message: `Promo ${newStatus ? 'activated' : 'deactivated'}.` });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/promos/toggle-all (Admin)
router.post('/toggle-all', requireRole('admin'), async (req, res) => {
    const { action } = req.body;
    if (!['pause', 'resume'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action.' });
    }
    
    const status = action === 'resume' ? 1 : 0;
    
    try {
        await db.prepare('UPDATE promos SET is_active = ?').run(status);
        await db.prepare('UPDATE promo_tasks SET is_active = ?').run(status);
        res.json({ message: `All campaigns have been ${action === 'resume' ? 'activated' : 'paused'}.` });
    } catch (error) {
        console.error('Bulk Toggle Error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

module.exports = router;
