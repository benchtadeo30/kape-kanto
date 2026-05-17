const { db } = require('../database/init');

/**
 * Tracks loyalty task progress for a completed order.
 * Called after order placement (pay_at_store/COD) or after online payment success.
 * 
 * @param {number} userId - The user ID
 * @param {number} orderId - The order ID  
 * @param {number} orderTotal - The order total amount
 */
async function trackLoyaltyProgress(userId, orderId, orderTotal) {
    try {
        console.log(`--- Loyalty Tracking for Order #${orderId}, User #${userId} ---`);

        const orderItems = await db.prepare(`
            SELECT oi.menu_item_id, oi.quantity, m.category_id 
            FROM order_items oi
            JOIN menu_items m ON oi.menu_item_id = m.id
            WHERE oi.order_id = ?
        `).all(orderId);

        console.log(`Order items:`, orderItems.map(i => `Item ${i.menu_item_id} (Cat ${i.category_id}) x${i.quantity}`).join(', '));

        const activeTasks = await db.prepare(`
            SELECT * FROM promo_tasks 
            WHERE is_active = 1 
            AND (start_date IS NULL OR start_date = '' OR datetime(start_date) <= datetime('now', '+8 hours'))
            AND (end_date IS NULL OR end_date = '' OR datetime(end_date) >= datetime('now', '+8 hours'))
        `).all();

        const totalCompletedOrders = (await db.prepare(
            "SELECT COUNT(*) as cnt FROM orders WHERE user_id = ? AND (payment_status = 'paid' OR payment_method IN ('pay_at_store', 'cod'))"
        ).get(userId)).cnt || 0;

        console.log(`Active tasks: ${activeTasks.length}, Total completed orders: ${totalCompletedOrders}`);

        for (const task of activeTasks) {
            let progress = await db.prepare('SELECT * FROM user_promo_progress WHERE user_id = ? AND promo_task_id = ?').get(userId, task.id);
            if (!progress) {
                const progInfo = await db.prepare('INSERT INTO user_promo_progress (user_id, promo_task_id, current_quantity) VALUES (?, ?, 0)').run(userId, task.id);
                progress = { id: progInfo.lastInsertRowid, current_quantity: 0, is_completed: 0 };
            }
            if (progress.is_completed) {
                console.log(`Task "${task.title}" already completed, skipping.`);
                continue;
            }

            const taskType = (task.task_type || 'buy_from_category').toLowerCase();
            let rule = {};
            try { rule = task.rule_json ? JSON.parse(task.rule_json) : {}; } catch(e) {}

            let increment = 0;
            let immediateComplete = false;

            let targetCatIds = [];
            if (rule.category_ids && Array.isArray(rule.category_ids)) {
                targetCatIds = rule.category_ids.map(Number);
            } else if (task.required_category_id) {
                targetCatIds = [Number(task.required_category_id)];
            }
            const currentQty = Number(progress.current_quantity) || 0;
            const numericOrderTotal = Number(orderTotal) || 0;

            console.log(`Checking task: "${task.title}" (type: ${taskType}, targetCats: ${JSON.stringify(targetCatIds)})`);

            switch (taskType) {
                case 'buy_from_category':
                case 'buy from category':
                    orderItems.forEach(item => {
                        const itemCatId = Number(item.category_id);
                        if (targetCatIds.length === 0 || targetCatIds.includes(itemCatId)) {
                            increment += Number(item.quantity) || 0;
                        }
                    });
                    break;
                case 'minimum_spend':
                case 'minimum spend':
                    increment += numericOrderTotal;
                    // The target is stored in min_order_amount
                    const requiredAmount = Number(rule.min_order_amount || task.min_order_amount || 0);
                    if ((currentQty + increment) >= requiredAmount) {
                        immediateComplete = true;
                    }
                    break;
                default:
                    console.log(`Unsupported task type: "${taskType}", skipping.`);
                    break;
            }

            if (immediateComplete) {
                console.log(`✅ Task "${task.title}" completed immediately!`);
                const targetVal = taskType === 'minimum_spend' || taskType === 'minimum spend' ? Number(rule.min_order_amount || task.min_order_amount || 0) : (Number(task.required_quantity) || 1);
                await db.prepare('UPDATE user_promo_progress SET current_quantity = ?, is_completed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                    .run(targetVal, progress.id);
                if (task.reward_promo_id) {
                    const promo = await db.prepare('SELECT usage_limit FROM promos WHERE id = ?').get(task.reward_promo_id);
                    const limit = promo ? (Number(promo.usage_limit) || 1) : 1;
                    const existing = await db.prepare('SELECT id FROM user_coupons WHERE user_id = ? AND promo_id = ? AND is_used = 0').get(userId, task.reward_promo_id);
                    if (!existing) {
                        await db.prepare('INSERT INTO user_coupons (user_id, promo_id, usage_limit) VALUES (?, ?, ?)').run(userId, task.reward_promo_id, limit);
                    }
                    console.log(`🎫 Coupon awarded for promo ID ${task.reward_promo_id} with limit ${limit}`);
                }
            } else if (increment > 0) {
                const newQty = currentQty + increment;
                const targetVal = taskType === 'minimum_spend' || taskType === 'minimum spend' ? Number(rule.min_order_amount || task.min_order_amount || 0) : (Number(task.required_quantity) || 1);
                console.log(`📊 Task "${task.title}" progress: ${currentQty} → ${newQty} / ${targetVal}`);
                if (newQty >= targetVal) {
                    console.log(`✅ Task "${task.title}" COMPLETED!`);
                    await db.prepare('UPDATE user_promo_progress SET current_quantity = ?, is_completed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                        .run(newQty, progress.id);
                    if (task.reward_promo_id) {
                        const promo = await db.prepare('SELECT usage_limit FROM promos WHERE id = ?').get(task.reward_promo_id);
                        const limit = promo ? (Number(promo.usage_limit) || 1) : 1;
                        const existing = await db.prepare('SELECT id FROM user_coupons WHERE user_id = ? AND promo_id = ? AND is_used = 0').get(userId, task.reward_promo_id);
                        if (!existing) {
                            await db.prepare('INSERT INTO user_coupons (user_id, promo_id, usage_limit) VALUES (?, ?, ?)').run(userId, task.reward_promo_id, limit);
                        }
                        console.log(`🎫 Coupon awarded for promo ID ${task.reward_promo_id} with limit ${limit}`);
                    }
                } else {
                    await db.prepare('UPDATE user_promo_progress SET current_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                        .run(newQty, progress.id);
                }
            } else {
                console.log(`⏭️ Task "${task.title}" - no matching items (increment: 0)`);
            }
        }

        console.log(`--- Loyalty Tracking Complete ---`);
    } catch (error) {
        console.error("Loyalty Tracking Error (Non-breaking):", error);
    }
}

/**
 * Increments promo usage for a user.
 */
async function incrementPromoUsage(userId, promoId) {
    if (!promoId) return;
    try {
        const promo = await db.prepare('SELECT * FROM promos WHERE id = ?').get(promoId);
        if (!promo) {
            console.error(`[PROMO] Promo ID ${promoId} not found in database.`);
            return;
        }

        console.log(`[PROMO] Incrementing usage for Promo #${promoId} ("${promo.title}"), User #${userId}`);

        let userCoupon = await db.prepare('SELECT * FROM user_coupons WHERE user_id = ? AND promo_id = ?').get(userId, promoId);
        
        if (userCoupon) {
            const newTimesUsed = (userCoupon.times_used || 0) + 1;
            const limit = Math.max(userCoupon.usage_limit || 0, promo.usage_limit || 1);
            const isUsed = newTimesUsed >= limit ? 1 : 0;
            
            await db.prepare('UPDATE user_coupons SET times_used = ?, is_used = ? WHERE id = ?')
                .run(newTimesUsed, isUsed, userCoupon.id);
            console.log(`[PROMO] Updated usage for Coupon #${userCoupon.id}: ${newTimesUsed}/${limit} (is_used: ${isUsed})`);
        } else {
            // If it's a public promo or first-time use of a promo, track usage by creating a record
            const limit = promo.usage_limit || 1;
            const isUsed = 1 >= limit ? 1 : 0;
            await db.prepare('INSERT INTO user_coupons (user_id, promo_id, times_used, usage_limit, is_used) VALUES (?, ?, ?, ?, ?)')
                .run(userId, promoId, 1, limit, isUsed);
            console.log(`[PROMO] Created usage record for Promo #${promoId} for User #${userId}: 1/${limit} (is_used: ${isUsed})`);
        }
    } catch (error) {
        console.error("[PROMO] Increment Promo Usage Error:", error);
    }
}

/**
 * Reverts promo usage (for cancellations).
 */
async function revertPromoUsage(userId, promoId) {
    if (!promoId) return;
    try {
        let userCoupon = await db.prepare('SELECT * FROM user_coupons WHERE user_id = ? AND promo_id = ?').get(userId, promoId);
        if (userCoupon && userCoupon.times_used > 0) {
            const newTimesUsed = userCoupon.times_used - 1;
            const limit = userCoupon.usage_limit || 1;
            const isUsed = newTimesUsed >= limit ? 1 : 0;
            
            await db.prepare('UPDATE user_coupons SET times_used = ?, is_used = ? WHERE id = ?')
                .run(newTimesUsed, isUsed, userCoupon.id);
            console.log(`[PROMO] Reverted usage for Coupon #${userCoupon.id}: ${newTimesUsed}/${limit}`);
        }
    } catch (error) {
        console.error("Revert Promo Usage Error:", error);
    }
}

/**
 * Reverts loyalty progress for a cancelled/dismissed order.
 */
async function revertLoyaltyProgress(userId, orderId, orderTotal) {
    try {
        console.log(`--- Reverting Loyalty for Order #${orderId}, User #${userId} ---`);

        const orderItems = await db.prepare(`
            SELECT oi.menu_item_id, oi.quantity, m.category_id 
            FROM order_items oi
            JOIN menu_items m ON oi.menu_item_id = m.id
            WHERE oi.order_id = ?
        `).all(orderId);

        const activeTasks = await db.prepare('SELECT * FROM promo_tasks WHERE is_active = 1').all();

        for (const task of activeTasks) {
            let progress = await db.prepare('SELECT * FROM user_promo_progress WHERE user_id = ? AND promo_task_id = ?').get(userId, task.id);
            if (!progress || progress.current_quantity === 0) continue;

            const taskType = (task.task_type || 'buy_from_category').toLowerCase();
            let rule = {};
            try { rule = task.rule_json ? JSON.parse(task.rule_json) : {}; } catch(e) {}

            let decrement = 0;
            let immediateRevert = false;

            let targetCatIds = [];
            if (rule.category_ids && Array.isArray(rule.category_ids)) {
                targetCatIds = rule.category_ids.map(Number);
            } else if (task.required_category_id) {
                targetCatIds = [Number(task.required_category_id)];
            }
            const currentQty = Number(progress.current_quantity) || 0;
            const numericOrderTotal = Number(orderTotal) || 0;

            switch (taskType) {
                case 'buy_from_category':
                case 'buy from category':
                    orderItems.forEach(item => {
                        const itemCatId = Number(item.category_id);
                        if (targetCatIds.length === 0 || targetCatIds.includes(itemCatId)) {
                            decrement += Number(item.quantity) || 0;
                        }
                    });
                    break;
                case 'minimum_spend':
                case 'minimum spend':
                    const requiredAmount = Number(rule.min_order_amount || task.min_order_amount || 0);
                    if (numericOrderTotal >= requiredAmount) {
                        immediateRevert = true;
                    }
                    break;
                default:
                    console.log(`Unsupported task type during revert: "${taskType}", skipping.`);
                    break;
            }

            if (immediateRevert || decrement > 0) {
                const decVal = immediateRevert ? Number(rule.min_order_amount || task.min_order_amount || 0) : decrement;
                let newQty = Math.max(0, currentQty - decVal);
                console.log(`Reverting Task "${task.title}": ${currentQty} -> ${newQty}`);
                
                const targetVal = taskType === 'minimum_spend' || taskType === 'minimum spend' ? Number(rule.min_order_amount || task.min_order_amount || 0) : (Number(task.required_quantity) || 1);
                const isStillCompleted = newQty >= targetVal ? 1 : 0;

                await db.prepare('UPDATE user_promo_progress SET current_quantity = ?, is_completed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                    .run(newQty, isStillCompleted, progress.id);
            }
        }

        console.log(`--- Reversal Complete ---`);
    } catch (error) {
        console.error("Loyalty Reversal Error:", error);
    }
}

module.exports = { trackLoyaltyProgress, revertLoyaltyProgress, incrementPromoUsage, revertPromoUsage };
