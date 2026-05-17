const express = require('express');
const router = express.Router();
const { db } = require('../database/init');
const { payrex } = require('../services/payrex');
const { trackLoyaltyProgress, incrementPromoUsage } = require('../services/loyalty');

// Helper function to query PayRex to get the exact payment method type (GCash, Card, PayMaya, QR Ph)
async function getPaymentMethodFromPayRex(payrexCheckoutId) {
    try {
        if (!payrexCheckoutId || payrexCheckoutId === 'redirect_success' || payrexCheckoutId === 'webhook_paid') {
            return 'Online Payment';
        }
        
        console.log(`[PAYREX] Retrieving session details for ID: ${payrexCheckoutId}`);
        const session = await payrex.checkoutSessions.retrieve(payrexCheckoutId);
        if (!session) return 'Online Payment';
        
        let paymentIntentId = null;
        if (typeof session.payment_intent === 'string') {
            paymentIntentId = session.payment_intent;
        } else if (session.payment_intent && session.payment_intent.id) {
            paymentIntentId = session.payment_intent.id;
        }
        
        if (paymentIntentId) {
            const pi = await payrex.paymentIntents.retrieve(paymentIntentId);
            if (pi && pi.payments && pi.payments.length > 0) {
                const payment = pi.payments.find(p => p.status === 'paid' || p.status === 'succeeded') || pi.payments[0];
                if (payment && payment.payment_method_type) {
                    const method = payment.payment_method_type.toLowerCase();
                    const mappings = {
                        gcash: 'GCash',
                        card: 'Credit/Debit Card',
                        maya: 'PayMaya',
                        qrph: 'QR Ph'
                    };
                    return mappings[method] || `Online (${method.toUpperCase()})`;
                }
            }
        }
        return 'Online Payment';
    } catch (err) {
        console.error('[PAYREX] Error retrieving payment method:', err.message || err);
        return 'Online Payment';
    }
}

// Helper function to handle successful payment
async function handleSuccessfulPayment(orderId, payrexPaymentId) {
    await db.beginTransaction();
    try {
        const order = await db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
        if (!order) {
            await db.rollback();
            return false;
        }

        // If already paid, do nothing
        if (order.payment_status === 'paid') {
            await db.rollback();
            return true;
        }

        // Fetch actual payment method from PayRex if checkout ID exists
        const actualMethod = await getPaymentMethodFromPayRex(order.payrex_checkout_id);

        // Update order status
        await db.prepare(`
            UPDATE orders 
            SET payment_status = 'paid', status = 'pending', payrex_payment_id = ?, payment_method = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(payrexPaymentId, actualMethod, orderId);

        console.log(`Payment Success: Order #${orderId} marked as PAID via ${actualMethod}.`);

        // Decrement stock
        const items = await db.prepare(`SELECT menu_item_id, quantity FROM order_items WHERE order_id = ?`).all(orderId);
        
        for (let item of items) {
            await db.prepare(`UPDATE menu_items SET stock = stock - ? WHERE id = ?`).run(item.quantity, item.menu_item_id);
        }

        await db.commit();

        // Track loyalty progress AFTER commit (non-breaking)
        await trackLoyaltyProgress(order.user_id, orderId, order.total);
        
        // Increment Promo Usage for online orders
        if (order.promo_id) {
            await incrementPromoUsage(order.user_id, order.promo_id);
        }

        return true;
    } catch (error) {
        await db.rollback();
        console.error("Error in handleSuccessfulPayment:", error);
        return false;
    }
}

// GET /api/payment/success
router.get('/success', async (req, res) => {
    const { order_id } = req.query;
    
    if (!order_id) return res.status(400).send('Missing order ID.');

    try {
        const order = await db.prepare(`SELECT payrex_checkout_id, payment_status FROM orders WHERE id = ?`).get(order_id);
        if (!order) return res.status(404).send('Order not found.');

        if (order.payment_status !== 'paid') {
            await handleSuccessfulPayment(order_id, 'redirect_success');
        }

        res.redirect(`/payment-success?order_id=${order_id}`);
    } catch (error) {
        res.status(500).send('Internal Server Error');
    }
});

// GET /api/payment/cancel
router.get('/cancel', (req, res) => {
    const { order_id } = req.query;
    res.redirect(`/payment-cancel?order_id=${order_id}`);
});

// POST /api/payment/webhook
router.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const event = req.body;

    if (event.type === 'checkout_session.payment.paid') {
        const session = event.data.object;
        
        const order = await db.prepare(`SELECT id FROM orders WHERE payrex_checkout_id = ?`).get(session.id);
        
        if (order) {
            await handleSuccessfulPayment(order.id, session.payment_intent || 'webhook_paid');
        }
    }

    res.json({received: true});
});

module.exports = router;
