const express = require('express');
const router = express.Router();
const { db } = require('../database/init');
const { payrex } = require('../services/payrex');
const { trackLoyaltyProgress } = require('../services/loyalty');

// Helper function to handle successful payment
function handleSuccessfulPayment(orderId, payrexPaymentId) {
    db.prepare('BEGIN TRANSACTION').run();
    try {
        const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
        if (!order) {
            db.prepare('ROLLBACK').run();
            return false;
        }

        // If already paid, do nothing
        if (order.payment_status === 'paid') {
            db.prepare('ROLLBACK').run();
            return true;
        }

        // Update order status
        db.prepare(`
            UPDATE orders 
            SET payment_status = 'paid', status = 'pending', payrex_payment_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(payrexPaymentId, orderId);

        console.log(`Payment Success: Order #${orderId} marked as PAID and PENDING.`);

        // Decrement stock
        const items = db.prepare(`SELECT menu_item_id, quantity FROM order_items WHERE order_id = ?`).all(orderId);
        const updateStock = db.prepare(`UPDATE menu_items SET stock = stock - ? WHERE id = ?`);
        
        for (let item of items) {
            updateStock.run(item.quantity, item.menu_item_id);
        }

        db.prepare('COMMIT').run();

        // Track loyalty progress AFTER commit (non-breaking)
        trackLoyaltyProgress(order.user_id, orderId, order.total);

        return true;
    } catch (error) {
        db.prepare('ROLLBACK').run();
        console.error("Error in handleSuccessfulPayment:", error);
        return false;
    }
}

// GET /api/payment/success
router.get('/success', async (req, res) => {
    const { order_id } = req.query;
    
    if (!order_id) return res.status(400).send('Missing order ID.');

    try {
        const order = db.prepare(`SELECT payrex_checkout_id, payment_status FROM orders WHERE id = ?`).get(order_id);
        if (!order) return res.status(404).send('Order not found.');

        // Proactively mark as paid since the user landed on the success URL
        // The webhook will also fire, but this ensures immediate UI update
        if (order.payment_status !== 'paid') {
            handleSuccessfulPayment(order_id, 'redirect_success');
        }

        // Redirect to frontend success page
        res.redirect(`/payment-success?order_id=${order_id}`);
    } catch (error) {
        res.status(500).send('Internal Server Error');
    }
});

// GET /api/payment/cancel
router.get('/cancel', (req, res) => {
    const { order_id } = req.query;
    // Order stays 'awaiting_payment'
    res.redirect(`/payment-cancel?order_id=${order_id}`);
});

// POST /api/payment/webhook
router.post('/webhook', express.raw({type: 'application/json'}), (req, res) => {
    // Note: In production, verify the webhook signature here using PayRex SDK
    const event = req.body; // Assuming express.json() handled it, or parsed via raw

    if (event.type === 'checkout_session.payment.paid') {
        const session = event.data.object;
        
        // Find order by checkout session id
        const order = db.prepare(`SELECT id FROM orders WHERE payrex_checkout_id = ?`).get(session.id);
        
        if (order) {
            handleSuccessfulPayment(order.id, session.payment_intent || 'webhook_paid');
        }
    }

    res.json({received: true});
});

module.exports = router;
