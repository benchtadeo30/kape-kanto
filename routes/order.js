const express = require('express');
const router = express.Router();
const { db } = require('../database/init');
const { requireAuth, requireRole } = require('../middleware/auth');
const { createCheckoutSession } = require('../services/payrex');
const { trackLoyaltyProgress, revertLoyaltyProgress, incrementPromoUsage, revertPromoUsage } = require('../services/loyalty');

// POST /api/orders (Place new order)
router.post('/', requireAuth, async (req, res) => {
    const { items, order_type, delivery_address, scheduled_date, scheduled_time, schedule_mode, notes, promo_code, payment_method } = req.body;
    const userId = req.session.userId;

    if (!items || !items.length) return res.status(400).json({ error: 'Cart is empty.' });
    if (!order_type || !['delivery', 'pickup'].includes(order_type)) return res.status(400).json({ error: 'Invalid order type.' });

    try {
        await db.beginTransaction();

        // Clean up any stale awaiting_payment orders from this user (prevents duplicates)
        const staleOrders = await db.prepare(
            `SELECT id FROM orders WHERE user_id = ? AND status = 'awaiting_payment' AND payment_status = 'awaiting'`
        ).all(userId);
        for (const stale of staleOrders) {
            await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(stale.id);
            await db.prepare('DELETE FROM orders WHERE id = ?').run(stale.id);
            console.log(`[ORDER] Cleaned up stale awaiting_payment order #${stale.id}`);
        }

        // 1. Get user details
        const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);

        // Check if user is email verified
        if (user.role === 'customer' && user.is_verified != 1) {
            await db.rollback();
            return res.status(403).json({ error: 'You must verify your email before placing an order.' });
        }

        // Phone Verification Check for Cash on Delivery Orders
        if (payment_method === 'cod' && !user.is_phone_verified && user.role === 'customer') {
            await db.rollback();
            return res.status(403).json({ 
                requires_phone_verification: true, 
                reason: 'cod_verification_required' 
            });
        }
        
        // 2. Validate items and calculate subtotal
        let subtotal = 0;
        const validItems = [];
        
        for (let item of items) {
            const dbItem = await db.prepare(`SELECT id, name, price, stock, is_available, category_id FROM menu_items WHERE id = ?`).get(item.id);
            if (!dbItem || dbItem.is_available === 0 || dbItem.stock < item.quantity) {
                await db.rollback();
                return res.status(400).json({ error: `Item ${item.name} is unavailable or out of stock.` });
            }
            
            // Account for customization price adjustments
            let adjustedPrice = dbItem.price;
            if (item.customizations) {
                for (const optName in item.customizations) {
                    const choiceName = item.customizations[optName];
                    const choice = await db.prepare(`
                        SELECT c.price_adjustment 
                        FROM menu_item_option_choices c
                        JOIN menu_item_options o ON c.option_id = o.id
                        WHERE o.menu_item_id = ? 
                        AND (LOWER(o.name) = LOWER(?) OR o.name = ?)
                        AND (LOWER(c.name) = LOWER(?) OR c.name = ?)
                        LIMIT 1
                    `).get(item.id, optName, optName, choiceName, choiceName);
                    
                    if (choice) {
                        adjustedPrice += (choice.price_adjustment || 0);
                    } else {
                        console.log(`[Order] No adjustment found for ${dbItem.name} > ${optName}: ${choiceName}`);
                    }
                }
            }

            const itemSubtotal = adjustedPrice * item.quantity;
            subtotal += itemSubtotal;
            validItems.push({
                ...dbItem,
                quantity: item.quantity,
                unit_price: adjustedPrice,
                subtotal: itemSubtotal,
                customizations: item.customizations ? JSON.stringify(item.customizations) : null
            });
        }

        // 3. Calculate discounts and VAT according to Philippine SC/PWD Law + Establishment Promos
        const isSeniorOrPWD = user.id_verification_status === 'verified' && (user.is_senior || user.is_pwd);
        
        let vat_exempt_sales = subtotal / 1.12;
        let sc_discount = 0;
        let vat_amount = 0;

        let discount_type = 'none';
        if (isSeniorOrPWD) {
            // SC/PWD: VAT Exempt + 20% Discount on Net
            sc_discount = vat_exempt_sales * 0.20;
            vat_amount = 0;
            discount_type = user.is_senior ? 'senior' : 'pwd';
        } else {
            // Standard: VAT Inclusive
            vat_amount = vat_exempt_sales * 0.12; 
        }

        // Promo Code Logic
        let promo_discount_amount = 0;
        let promoObj = null;
        if (promo_code) {
            const promo = await db.prepare(`
                SELECT p.*,
                       (SELECT id FROM promo_tasks WHERE reward_promo_id = p.id LIMIT 1) as is_loyalty_reward
                FROM promos p
                WHERE UPPER(p.promo_code) = UPPER(?) AND p.is_active = 1
                AND (p.start_date IS NULL OR p.start_date = '' OR datetime(p.start_date) <= datetime('now', '+8 hours'))
                AND (p.end_date IS NULL OR p.end_date = '' OR datetime(p.end_date) >= datetime('now', '+8 hours'))
            `).get(promo_code);

            if (promo) {
                // Check loyalty requirement and usage limits
                let canUsePromo = true;
                const coupon = await db.prepare(`SELECT * FROM user_coupons WHERE user_id = ? AND promo_id = ?`).get(req.session.userId, promo.id);
                
                if (promo.is_loyalty_reward) {
                    if (!coupon) {
                        canUsePromo = false; // Must have earned this reward
                    } else {
                        const currentLimit = Math.max(coupon.usage_limit || 0, promo.usage_limit || 1);
                        if (coupon.times_used >= currentLimit) {
                            canUsePromo = false;
                        }
                    }
                } else if (promo.usage_limit > 0) {
                    // Public promo with usage limit — check dynamically against current global limit
                    if (coupon) {
                        const currentLimit = Math.max(coupon.usage_limit || 0, promo.usage_limit || 0);
                        if (coupon.times_used >= currentLimit) {
                            canUsePromo = false;
                        }
                    }
                }

                if (canUsePromo) {
                    promoObj = promo;
                    let applicableGross = 0;
                    let appItemIds = [];
                    let appCatIds = [];
                    try {
                        if (promo.applicable_menu_item_ids) {
                            const parsed = JSON.parse(promo.applicable_menu_item_ids);
                            if (Array.isArray(parsed)) appItemIds = appItemIds.concat(parsed);
                        }
                        if (promo.applicable_category_ids) {
                            const parsed = JSON.parse(promo.applicable_category_ids);
                            if (Array.isArray(parsed)) appCatIds = appCatIds.concat(parsed);
                        }
                    } catch(e) {}

                    if (promo.applicable_menu_item_id) appItemIds.push(promo.applicable_menu_item_id);
                    if (promo.applicable_category_id) appCatIds.push(promo.applicable_category_id);
                    
                    appItemIds = appItemIds.filter(v => v !== null).map(String);
                    appCatIds = appCatIds.filter(v => v !== null).map(String);

                    const hasRestrictions = appItemIds.length > 0 || appCatIds.length > 0;

                    if (!hasRestrictions) {
                        applicableGross = subtotal;
                    } else {
                        const match = validItems.filter(i => {
                            const itemMatch = appItemIds.includes(String(i.id));
                            const catMatch = appCatIds.includes(String(i.category_id || ''));
                            return itemMatch || catMatch;
                        });
                        applicableGross = match.reduce((sum, i) => sum + i.subtotal, 0);
                    }

                    // Apply promo on the net amount (VAT-exempted)
                    let applicableNet = applicableGross / 1.12;
                    if (isSeniorOrPWD) {
                        applicableNet = applicableNet * 0.8; // Apply on the amount after 20% discount
                    }
                    
                    if (promo.discount_percent > 0) {
                        promo_discount_amount = applicableNet * (promo.discount_percent / 100);
                    } else if (promo.discount_amount > 0) {
                        // Flat amount discount - capped by the applicable balance
                        promo_discount_amount = Math.min(promo.discount_amount, applicableNet);
                    }
                    
                    if (promo_discount_amount > 0 && !isSeniorOrPWD) {
                        discount_type = 'promo';
                    }
                }
            }
        }

        const total_discount = sc_discount + promo_discount_amount;
        const delivery_fee = (order_type === 'delivery') ? 50 : 0;
        
        let final_vat_amount = vat_amount;
        if (!isSeniorOrPWD) {
            final_vat_amount = (vat_exempt_sales - promo_discount_amount) * 0.12;
        }
        const final_discount_amount = total_discount;

        const total = Math.round(((vat_exempt_sales - sc_discount - promo_discount_amount) + final_vat_amount + delivery_fee) * 100) / 100;

        console.log(`[ORDER] === Order Summary ===`);
        console.log(`[ORDER] Promo Code Received: "${promo_code || 'NONE'}"`);
        console.log(`[ORDER] Promo Object: ${promoObj ? promoObj.title + ' (ID:' + promoObj.id + ')' : 'NULL'}`);
        console.log(`[ORDER] Subtotal (Gross): \u20B1${subtotal}`);
        console.log(`[ORDER] SC/PWD Discount: \u20B1${sc_discount}`);
        console.log(`[ORDER] Promo Discount: \u20B1${promo_discount_amount}`);
        console.log(`[ORDER] VAT: \u20B1${final_vat_amount}`);
        console.log(`[ORDER] Delivery Fee: \u20B1${delivery_fee}`);
        console.log(`[ORDER] FINAL TOTAL: \u20B1${total}`);
        console.log(`[ORDER] Payment Method: ${payment_method}`);

        const isOnline = payment_method === 'online' || payment_method === 'payrex';
        const finalStatus = isOnline ? 'awaiting_payment' : 'pending';
        const finalPaymentMethod = isOnline ? 'payrex' : payment_method;

        const finalScheduleMode = schedule_mode || 'scheduled';
        let estimatedReadyTime = null;
        let finalScheduledDate = scheduled_date || null;
        let finalScheduledTime = scheduled_time || null;

        if (finalScheduleMode === 'asap') {
            const now = new Date();
            // Convert to PHT (UTC+8) — server may run in UTC
            const phtOffset = 8 * 60 * 60000;
            const phtNow = new Date(now.getTime() + phtOffset);
            const leadMinutes = order_type === 'delivery' ? 45 : 20;
            const eta = new Date(phtNow.getTime() + leadMinutes * 60000);
            // Store as ISO but in PHT context
            const pad = (n) => String(n).padStart(2, '0');
            estimatedReadyTime = `${eta.getUTCFullYear()}-${pad(eta.getUTCMonth()+1)}-${pad(eta.getUTCDate())}T${pad(eta.getUTCHours())}:${pad(eta.getUTCMinutes())}:${pad(eta.getUTCSeconds())}`;
            finalScheduledDate = `${eta.getUTCFullYear()}-${pad(eta.getUTCMonth()+1)}-${pad(eta.getUTCDate())}`;
            finalScheduledTime = `${pad(eta.getUTCHours())}:${pad(eta.getUTCMinutes())}`;
        }

        // 4. Create Order
        const insertOrder = await db.prepare(`
            INSERT INTO orders (
                user_id, status, subtotal, vat_amount, delivery_fee, total, 
                discount_amount, discount_type, sc_discount_amount, promo_discount_amount,
                payment_method, payment_status, order_type, delivery_address, notes, 
                promo_id, schedule_mode, scheduled_date, scheduled_time, estimated_ready_time
            ) VALUES (
                @user_id, @status, @subtotal, @vat_amount, @delivery_fee, @total, 
                @discount_amount, @discount_type, @sc_discount_amount, @promo_discount_amount,
                @payment_method, 'awaiting', @order_type, @delivery_address, @notes, 
                @promo_id, @schedule_mode, @scheduled_date, @scheduled_time, @estimated_ready_time
            )
        `).run({
            user_id: userId,
            status: finalStatus,
            subtotal: subtotal,
            vat_amount: final_vat_amount,
            delivery_fee: delivery_fee,
            total: total,
            discount_amount: final_discount_amount,
            discount_type: discount_type,
            sc_discount_amount: sc_discount,
            promo_discount_amount: promo_discount_amount,
            payment_method: finalPaymentMethod,
            order_type: order_type,
            delivery_address: delivery_address || null,
            notes: notes || null,
            promo_id: promoObj ? promoObj.id : null,
            schedule_mode: finalScheduleMode,
            scheduled_date: finalScheduledDate,
            scheduled_time: finalScheduledTime,
            estimated_ready_time: estimatedReadyTime
        });
        
        const orderId = insertOrder.lastInsertRowid;

        // 5. Insert Order Items
        for (let item of validItems) {
            await db.prepare(`
                INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, subtotal, customizations)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(orderId, item.id, item.quantity, item.unit_price, item.subtotal, item.customizations);
        }

        await db.commit();
        
        // Increment Promo Usage for offline orders
        if (!isOnline && promoObj) {
            console.log(`[ORDER] Incrementing promo usage for offline order #${orderId}, Promo: ${promoObj.promo_code}`);
            await incrementPromoUsage(userId, promoObj.id);
        } else if (isOnline && promoObj) {
            console.log(`[ORDER] Online order #${orderId} with promo ${promoObj.promo_code} - usage will be incremented after payment.`);
        }

        // 6. Handle Payment Redirection or Success
        if (isOnline) {
            // Re-fetch promo details to ensure accurate itemized calculation for PayRex
            let appItemIds = [];
            let appCatIds = [];
            let hasRestrictions = false;
            
            if (promoObj) {
                try {
                    if (promoObj.applicable_menu_item_ids) {
                        const parsed = JSON.parse(promoObj.applicable_menu_item_ids);
                        if (Array.isArray(parsed)) appItemIds = appItemIds.concat(parsed);
                    }
                    if (promoObj.applicable_category_ids) {
                        const parsed = JSON.parse(promoObj.applicable_category_ids);
                        if (Array.isArray(parsed)) appCatIds = appCatIds.concat(parsed);
                    }
                } catch(e) {}
                if (promoObj.applicable_menu_item_id) appItemIds.push(promoObj.applicable_menu_item_id);
                if (promoObj.applicable_category_id) appCatIds.push(promoObj.applicable_category_id);
                
                appItemIds = appItemIds.filter(v => v !== null).map(String);
                appCatIds = appCatIds.filter(v => v !== null).map(String);
                hasRestrictions = appItemIds.length > 0 || appCatIds.length > 0;
            }

            // Calculate exact final price for each item to avoid proportional distribution errors in PayRex
            validItems.forEach(item => {
                let net = item.unit_price / 1.12;
                let totalDiscountOnItem = 0;
                
                // Senior/PWD Discount (Establishment rule: apply on net price)
                if (isSeniorOrPWD) {
                    totalDiscountOnItem += net * 0.20;
                    net = net * 0.80;
                }
                
                // Promo Discount
                if (promoObj) {
                    const itemMatch = appItemIds.includes(String(item.id));
                    const catMatch = appCatIds.includes(String(item.category_id || ''));
                    const isEligible = !hasRestrictions || itemMatch || catMatch;
                    
                    if (isEligible) {
                        if (promoObj.discount_percent > 0) {
                            totalDiscountOnItem += net * (promoObj.discount_percent / 100);
                        } else if (promoObj.discount_amount > 0 && applicableGross > 0) {
                            // Pro-rate flat discount based on item's share of total applicable gross
                            const itemShareOfApplicable = item.subtotal / applicableGross;
                            const itemTotalPromoDiscount = promo_discount_amount * itemShareOfApplicable;
                            totalDiscountOnItem += itemTotalPromoDiscount / item.quantity;
                        }
                    }
                }
                
                const finalNet = (item.unit_price / 1.12) - totalDiscountOnItem;
                const vat = isSeniorOrPWD ? 0 : (finalNet * 0.12);
                item.final_unit_price = Math.max(0, finalNet + vat);
            });

            const orderData = { 
                id: orderId, 
                customer_email: user.email,
                subtotal: subtotal,
                vat_amount: final_vat_amount,
                discount_amount: final_discount_amount,
                discount_type: discount_type,
                delivery_fee: delivery_fee,
                total: total
            };
            try {
                const sessionData = await createCheckoutSession(orderData, validItems, final_discount_amount, discount_type);
                
                await db.prepare(`UPDATE orders SET payrex_checkout_id = ? WHERE id = ?`).run(sessionData.sessionId, orderId);

                res.json({ 
                    message: 'Order placed, awaiting payment.', 
                    orderId: orderId,
                    checkoutUrl: sessionData.url
                });
            } catch (payrexError) {
                console.error('PayRex Error:', payrexError);
                res.status(500).json({ error: payrexError.message || 'Failed to create payment session.' });
            }
        } else {
            // Physical payment — track loyalty progress immediately
            await trackLoyaltyProgress(userId, orderId, total);

            // Decrement stock for non-online orders
            for (let item of validItems) {
                await db.prepare('UPDATE menu_items SET stock = stock - ? WHERE id = ?').run(item.quantity, item.id);
            }

            res.json({
                message: 'Order placed successfully.',
                orderId: orderId
            });
        }

    } catch (error) {
        await db.rollback();
        console.error('CRITICAL ORDER ERROR:', error);
        res.status(500).json({ 
            error: 'Internal server error while placing order.',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// GET /api/orders/my
router.get('/my', requireAuth, async (req, res) => {
    try {
        const orders = await db.prepare(`
            SELECT * FROM orders 
            WHERE user_id = ? 
            ORDER BY created_at DESC
        `).all(req.session.userId);
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// GET /api/orders/my/:id
router.get('/my/:id', requireAuth, async (req, res) => {
    try {
        const user = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
        let order;
        
        if (user.role === 'admin' || user.role === 'staff') {
            order = await db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
        } else {
            order = await db.prepare(`SELECT * FROM orders WHERE id = ? AND user_id = ?`).get(req.params.id, req.session.userId);
        }
        
        if (!order) return res.status(404).json({ error: 'Order not found.' });

        const items = await db.prepare(`
            SELECT oi.*, m.name, m.image 
            FROM order_items oi
            JOIN menu_items m ON oi.menu_item_id = m.id
            WHERE oi.order_id = ?
        `).all(order.id);

        order.items = items;
        res.json(order);
    } catch (error) {
        console.error('Order Details Error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// POST /api/orders/my/:id/cancel
router.post('/my/:id/cancel', requireAuth, async (req, res) => {
    try {
        await db.beginTransaction();

        const order = await db.prepare(`SELECT * FROM orders WHERE id = ? AND user_id = ?`).get(req.params.id, req.session.userId);
        if (!order) {
            await db.rollback();
            return res.status(404).json({ error: 'Order not found.' });
        }

        if (order.status !== 'awaiting_payment' && order.status !== 'pending') {
            await db.rollback();
            return res.status(400).json({ error: 'Order cannot be cancelled at this stage.' });
        }

        if (order.status === 'pending' && ['pay_at_store', 'cod'].includes(order.payment_method)) {
            const items = await db.prepare('SELECT menu_item_id, quantity FROM order_items WHERE order_id = ?').all(order.id);
            for (let item of items) {
                await db.prepare('UPDATE menu_items SET stock = stock + ? WHERE id = ?').run(item.quantity, item.menu_item_id);
            }
            await revertLoyaltyProgress(order.user_id, order.id, order.total);
            if (order.promo_id) {
                await revertPromoUsage(order.user_id, order.promo_id);
            }
        }

        await db.prepare(`UPDATE orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(order.id);
        await db.commit();
        res.json({ message: 'Order cancelled successfully.' });
    } catch (error) {
        await db.rollback();
        console.error('Customer cancel error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// GET /api/orders/all (Admin/Staff)
router.get('/all', requireRole('admin', 'staff'), async (req, res) => {
    const limit = parseInt(req.query.limit);
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status || 'all';

    try {
        let query = `
            SELECT o.*, u.username, u.email 
            FROM orders o
            JOIN users u ON o.user_id = u.id
            WHERE 1=1
        `;
        let countQuery = `
            SELECT COUNT(*) as total 
            FROM orders o
            WHERE 1=1
        `;
        const params = [];

        if (status !== 'all') {
            query += ` AND o.status = ?`;
            countQuery += ` AND o.status = ?`;
            params.push(status);
        }

        query += ` ORDER BY o.updated_at DESC, o.created_at DESC`;

        if (!isNaN(limit)) {
            query += ` LIMIT ? OFFSET ?`;
            params.push(limit, offset);
        }

        const orders = await db.prepare(query).all(...params);
        
        const countParams = status !== 'all' ? [status] : [];
        const total = (await db.prepare(countQuery).get(...countParams)).total;

        if (!isNaN(limit)) {
            res.json({ items: orders, total });
        } else {
            res.json(orders);
        }
    } catch (error) {
        console.error('All orders fetch error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// PATCH /api/orders/:id/status (Admin/Staff)
router.patch('/:id/status', requireRole('admin', 'staff'), async (req, res) => {
    const { status, rider_name, rider_contact } = req.body;
    const validStatuses = ['pending', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled'];
    
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    
    try {
        const order = await db.prepare('SELECT order_type FROM orders WHERE id = ?').get(req.params.id);
        if (!order) return res.status(404).json({ error: 'Order not found.' });

        if (status === 'out_for_delivery' && order.order_type === 'pickup') {
            return res.status(400).json({ error: 'Pickup orders cannot be out for delivery.' });
        }

        let query = `UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP`;
        const params = [status];

        if (status === 'out_for_delivery') {
            if (rider_name)    { query += ', rider_name = ?';    params.push(rider_name); }
            if (rider_contact) { query += ', rider_contact = ?'; params.push(rider_contact); }
        }
        query += ` WHERE id = ?`;
        params.push(req.params.id);

        const info = await db.prepare(query).run(...params);
        if (info.changes === 0) return res.status(404).json({ error: 'Order not found.' });

        if (status === 'completed') {
            const completedOrder = await db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
            if (completedOrder && !['online', 'payrex'].includes(completedOrder.payment_method)) {
                await trackLoyaltyProgress(completedOrder.user_id, completedOrder.id, completedOrder.total);
            }
        }

        res.json({ message: 'Order status updated.' });
    } catch (error) {
        console.error('Status update error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// PATCH /api/orders/:id/dismiss (Admin/Staff)
router.patch('/:id/dismiss', requireRole('admin', 'staff'), async (req, res) => {
    const orderId = req.params.id;

    try {
        await db.beginTransaction();

        const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        if (!order) {
            await db.rollback();
            return res.status(404).json({ error: 'Order not found.' });
        }

        if (['completed', 'cancelled'].includes(order.status)) {
            await db.rollback();
            return res.status(400).json({ error: 'Only active orders can be dismissed.' });
        }

        const items = await db.prepare('SELECT menu_item_id, quantity FROM order_items WHERE order_id = ?').all(orderId);
        for (let item of items) {
            await db.prepare('UPDATE menu_items SET stock = stock + ? WHERE id = ?').run(item.quantity, item.menu_item_id);
        }

        await revertLoyaltyProgress(order.user_id, orderId, order.total);

        await db.prepare(`
            UPDATE orders
            SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(orderId);

        await db.commit();
        res.json({ message: 'Order dismissed. Stock was returned and loyalty progress was reverted.' });
    } catch (error) {
        await db.rollback();
        console.error('Dismiss order error:', error);
        res.status(500).json({ error: 'Failed to dismiss order.' });
    }
});

// DELETE /api/orders/:id (Admin/Staff)
router.delete('/:id', requireRole('admin', 'staff'), async (req, res) => {
    const orderId = req.params.id;
    try {
        await db.beginTransaction();
        
        const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        if (!order) {
            await db.rollback();
            return res.status(404).json({ error: 'Order not found.' });
        }

        const shouldReturnStock = !['cancelled', 'completed', 'awaiting_payment'].includes(order.status)
            && ['pay_at_store', 'cod'].includes(order.payment_method);

        if (shouldReturnStock) {
            await revertLoyaltyProgress(order.user_id, orderId, order.total);

            const items = await db.prepare('SELECT menu_item_id, quantity FROM order_items WHERE order_id = ?').all(orderId);
            for (let item of items) {
                await db.prepare('UPDATE menu_items SET stock = stock + ? WHERE id = ?').run(item.quantity, item.menu_item_id);
            }
        }

        await db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
        await db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);

        await db.commit();
        res.json({ message: shouldReturnStock ? 'Order deleted. Stock returned and loyalty progress reverted.' : 'Order permanently deleted.' });
    } catch (error) {
        await db.rollback();
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Failed to delete order.' });
    }
});

// GET /api/orders/:id/messages (Customer/Staff/Admin)
router.get('/:id/messages', requireAuth, async (req, res) => {
    const orderId = req.params.id;
    const userId = req.session.userId;
    const role = req.session.role;

    try {
        const order = await db.prepare('SELECT user_id FROM orders WHERE id = ?').get(orderId);
        if (!order) return res.status(404).json({ error: 'Order not found' });
        
        if (role === 'customer' && order.user_id !== userId) {
            return res.status(403).json({ error: 'Unauthorized access' });
        }

        const messages = await db.prepare(`
            SELECT m.*, u.username, u.role 
            FROM order_messages m
            LEFT JOIN users u ON m.user_id = u.id
            WHERE m.order_id = ?
            ORDER BY m.created_at ASC
        `).all(orderId);

        // Mark messages as read for the recipient
        if (messages.length > 0) {
            if (role === 'customer') {
                // Customer marks staff/admin messages as read
                await db.prepare(`
                    UPDATE order_messages SET is_read = 1 
                    WHERE order_id = ? AND user_id IN (SELECT id FROM users WHERE role IN ('admin', 'staff'))
                `).run(orderId);
            } else if (role === 'admin' || role === 'staff') {
                // Staff/Admin marks customer messages as read
                await db.prepare(`
                    UPDATE order_messages SET is_read = 1 
                    WHERE order_id = ? AND user_id IN (SELECT id FROM users WHERE role = 'customer')
                `).run(orderId);
            }
        }

        res.json(messages);
    } catch (e) {
        console.error('Fetch messages error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/orders/unread-messages (Admin/Staff)
router.get('/unread-messages', requireRole('admin', 'staff'), async (req, res) => {
    try {
        const unreadOrders = await db.prepare(`
            SELECT m.order_id, COUNT(*) as unread_count, u.username as customer_name
            FROM order_messages m
            JOIN users sender ON m.user_id = sender.id
            JOIN orders o ON m.order_id = o.id
            JOIN users u ON o.user_id = u.id
            WHERE m.is_read = 0 AND sender.role = 'customer'
            GROUP BY m.order_id
            ORDER BY MAX(m.created_at) DESC
        `).all();
        res.json(unreadOrders);
    } catch (e) {
        console.error('Unread messages fetch error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/orders/my/unread-messages (Customer)
router.get('/my/unread-messages', requireAuth, async (req, res) => {
    try {
        const unreadOrders = await db.prepare(`
            SELECT m.order_id, COUNT(*) as unread_count
            FROM order_messages m
            JOIN users sender ON m.user_id = sender.id
            WHERE m.is_read = 0 
            AND sender.role IN ('admin', 'staff')
            AND m.order_id IN (SELECT id FROM orders WHERE user_id = ?)
            GROUP BY m.order_id
        `).all(req.session.userId);
        res.json(unreadOrders);
    } catch (e) {
        console.error('Customer unread messages fetch error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/orders/:id/messages (Customer/Staff/Admin)
router.post('/:id/messages', requireAuth, async (req, res) => {
    const orderId = req.params.id;
    const userId = req.session.userId;
    const role = req.session.role;
    const { message } = req.body;

    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

    try {
        const order = await db.prepare('SELECT user_id FROM orders WHERE id = ?').get(orderId);
        if (!order) return res.status(404).json({ error: 'Order not found' });
        
        if (role === 'customer' && order.user_id !== userId) {
            return res.status(403).json({ error: 'Unauthorized access' });
        }

        const result = await db.prepare(
            'INSERT INTO order_messages (order_id, user_id, message) VALUES (?, ?, ?)'
        ).run(orderId, userId, message.trim());

        const insertedMessage = await db.prepare(`
            SELECT m.*, u.username, u.role 
            FROM order_messages m
            LEFT JOIN users u ON m.user_id = u.id
            WHERE m.id = ?
        `).get(result.lastInsertRowid);

        res.json(insertedMessage);
    } catch (e) {
        console.error('Post message error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
