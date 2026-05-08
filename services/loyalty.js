const { db } = require('../database/init');

/**
 * Tracks loyalty task progress for a completed order.
 * Called after order placement (pay_at_store/COD) or after online payment success.
 * 
 * @param {number} userId - The user ID
 * @param {number} orderId - The order ID  
 * @param {number} orderTotal - The order total amount
 */
function trackLoyaltyProgress(userId, orderId, orderTotal) {
    try {
        console.log(`--- Loyalty Tracking for Order #${orderId}, User #${userId} ---`);

        const orderItems = db.prepare(`
            SELECT oi.menu_item_id, oi.quantity, m.category_id 
            FROM order_items oi
            JOIN menu_items m ON oi.menu_item_id = m.id
            WHERE oi.order_id = ?
        `).all(orderId);

        console.log(`Order items:`, orderItems.map(i => `Item ${i.menu_item_id} (Cat ${i.category_id}) x${i.quantity}`).join(', '));

        const activeTasks = db.prepare(`
            SELECT * FROM promo_tasks 
            WHERE is_active = 1 
            AND (end_date IS NULL OR end_date = '' OR datetime(end_date) >= datetime('now', 'localtime'))
        `).all();

        const totalCompletedOrders = db.prepare(
            "SELECT COUNT(*) as cnt FROM orders WHERE user_id = ? AND (payment_status = 'paid' OR payment_method IN ('pay_at_store', 'cod'))"
        ).get(userId).cnt || 0;

        console.log(`Active tasks: ${activeTasks.length}, Total completed orders: ${totalCompletedOrders}`);

        activeTasks.forEach(task => {
            let progress = db.prepare('SELECT * FROM user_promo_progress WHERE user_id = ? AND promo_task_id = ?').get(userId, task.id);
            if (!progress) {
                const progInfo = db.prepare('INSERT INTO user_promo_progress (user_id, promo_task_id, current_quantity) VALUES (?, ?, 0)').run(userId, task.id);
                progress = { id: progInfo.lastInsertRowid, current_quantity: 0, is_completed: 0 };
            }
            if (progress.is_completed) {
                console.log(`Task "${task.title}" already completed, skipping.`);
                return;
            }

            const taskType = (task.task_type || 'buy_specific_item').toLowerCase();
            let rule = {};
            try { rule = task.rule_json ? JSON.parse(task.rule_json) : {}; } catch(e) {}

            let increment = 0;
            let immediateComplete = false;

            const targetItemId = Number(rule.menu_item_id || task.required_menu_item_id || 0);
            const targetCatId = Number(rule.category_id || task.required_category_id || 0);

            console.log(`Checking task: "${task.title}" (type: ${taskType}, targetItem: ${targetItemId}, targetCat: ${targetCatId})`);

            switch (taskType) {
                case 'buy_specific_item':
                case 'buy specific item':
                    orderItems.forEach(item => {
                        if (Number(item.menu_item_id) === targetItemId) {
                            increment += item.quantity;
                        }
                    });
                    break;
                case 'buy_from_category':
                case 'buy from category':
                    orderItems.forEach(item => {
                        if (Number(item.category_id) === targetCatId) {
                            increment += item.quantity;
                        }
                    });
                    break;
                case 'minimum_spend':
                case 'minimum spend':
                    if (orderTotal >= (rule.min_order_amount || task.min_order_amount || 0)) {
                        immediateComplete = true;
                    }
                    break;
                case 'first_order':
                case 'first order':
                    if (totalCompletedOrders <= 1) immediateComplete = true;
                    break;
                case 'order_count':
                case 'order count':
                    if (totalCompletedOrders >= (task.required_quantity || 1)) immediateComplete = true;
                    break;
                default:
                    orderItems.forEach(item => {
                        if (Number(item.menu_item_id) === targetItemId) increment += item.quantity;
                    });
                    break;
            }

            if (immediateComplete) {
                console.log(`✅ Task "${task.title}" completed immediately!`);
                db.prepare('UPDATE user_promo_progress SET current_quantity = ?, is_completed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                    .run(task.required_quantity || 1, progress.id);
                if (task.reward_promo_id) {
                    // Check if user already has an unused coupon for this promo
                    const existing = db.prepare('SELECT id FROM user_coupons WHERE user_id = ? AND promo_id = ? AND is_used = 0').get(userId, task.reward_promo_id);
                    if (!existing) {
                        db.prepare('INSERT INTO user_coupons (user_id, promo_id) VALUES (?, ?)').run(userId, task.reward_promo_id);
                    }
                    console.log(`🎫 Coupon awarded for promo ID ${task.reward_promo_id}`);
                }
            } else if (increment > 0) {
                const newQty = (progress.current_quantity || 0) + increment;
                console.log(`📊 Task "${task.title}" progress: ${progress.current_quantity} → ${newQty} / ${task.required_quantity}`);
                if (newQty >= (task.required_quantity || 1)) {
                    console.log(`✅ Task "${task.title}" COMPLETED!`);
                    db.prepare('UPDATE user_promo_progress SET current_quantity = ?, is_completed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                        .run(newQty, progress.id);
                    if (task.reward_promo_id) {
                        // Check if user already has an unused coupon for this promo
                        const existing = db.prepare('SELECT id FROM user_coupons WHERE user_id = ? AND promo_id = ? AND is_used = 0').get(userId, task.reward_promo_id);
                        if (!existing) {
                            db.prepare('INSERT INTO user_coupons (user_id, promo_id) VALUES (?, ?)').run(userId, task.reward_promo_id);
                        }
                        console.log(`🎫 Coupon awarded for promo ID ${task.reward_promo_id}`);
                    }
                } else {
                    db.prepare('UPDATE user_promo_progress SET current_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                        .run(newQty, progress.id);
                }
            } else {
                console.log(`⏭️ Task "${task.title}" - no matching items (increment: 0)`);
            }
        });

        console.log(`--- Loyalty Tracking Complete ---`);
    } catch (error) {
        console.error("Loyalty Tracking Error (Non-breaking):", error);
    }
}

/**
 * Reverts loyalty progress for a cancelled/dismissed order.
 */
function revertLoyaltyProgress(userId, orderId, orderTotal) {
    try {
        console.log(`--- Reverting Loyalty for Order #${orderId}, User #${userId} ---`);

        const orderItems = db.prepare(`
            SELECT oi.menu_item_id, oi.quantity, m.category_id 
            FROM order_items oi
            JOIN menu_items m ON oi.menu_item_id = m.id
            WHERE oi.order_id = ?
        `).all(orderId);

        const activeTasks = db.prepare('SELECT * FROM promo_tasks WHERE is_active = 1').all();

        activeTasks.forEach(task => {
            let progress = db.prepare('SELECT * FROM user_promo_progress WHERE user_id = ? AND promo_task_id = ?').get(userId, task.id);
            if (!progress || progress.current_quantity === 0) return;

            const taskType = task.task_type || 'buy_specific_item';
            let rule = {};
            try { rule = task.rule_json ? JSON.parse(task.rule_json) : {}; } catch(e) {}

            let decrement = 0;
            let immediateRevert = false;

            const targetItemId = Number(rule.menu_item_id || task.required_menu_item_id || 0);
            const targetCatId = Number(rule.category_id || task.required_category_id || 0);

            switch (taskType) {
                case 'buy_specific_item':
                    orderItems.forEach(item => {
                        if (Number(item.menu_item_id) === targetItemId) decrement += item.quantity;
                    });
                    break;
                case 'buy_from_category':
                    orderItems.forEach(item => {
                        if (Number(item.category_id) === targetCatId) decrement += item.quantity;
                    });
                    break;
                case 'minimum_spend':
                    if (orderTotal >= (rule.min_order_amount || task.min_order_amount || 0)) immediateRevert = true;
                    break;
                case 'order_count':
                    decrement = 1;
                    break;
                case 'first_order':
                    // Hard to revert perfectly without a full order history check, but we can reset if it was the only order
                    immediateRevert = true; 
                    break;
            }

            if (immediateRevert || decrement > 0) {
                let newQty = Math.max(0, (progress.current_quantity || 0) - (immediateRevert ? 1 : decrement));
                console.log(`Reverting Task "${task.title}": ${progress.current_quantity} -> ${newQty}`);
                
                // If it was completed but now isn't
                const wasCompleted = progress.is_completed;
                const isStillCompleted = newQty >= (task.required_quantity || 1) && !immediateRevert ? 1 : 0;

                db.prepare('UPDATE user_promo_progress SET current_quantity = ?, is_completed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                    .run(newQty, isStillCompleted, progress.id);

                // Note: We don't automatically delete the user's coupon if they already saw the code, 
                // but we mark the progress as incomplete so they can't "double dip" easily.
            }
        });

        console.log(`--- Reversal Complete ---`);
    } catch (error) {
        console.error("Loyalty Reversal Error:", error);
    }
}

module.exports = { trackLoyaltyProgress, revertLoyaltyProgress };
