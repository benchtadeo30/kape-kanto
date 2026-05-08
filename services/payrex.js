const PayRex = require('payrex-node');

// Initialize PayRex SDK
const payrex = new PayRex(process.env.PAYREX_SECRET_KEY);

/**
 * Creates a PayRex checkout session.
 * @param {Object} order - The order details from the database.
 * @param {Array} orderItems - The items belonging to the order.
 * @returns {Promise<string>} The URL of the checkout session to redirect the user.
 */
async function createCheckoutSession(order, orderItems, discountAmount = 0, discountType = 'none') {
    try {
        console.log(`--- Creating PayRex Session for Order #${order.id} ---`);
        
        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        let line_items = [];
        
        // Calculate the total gross amount of all items before any discounts
        let grossSubtotal = 0;
        orderItems.forEach(item => grossSubtotal += item.subtotal);

        let totalLineItemsCents = 0;

        // 1. Add Itemized Products (Baking VAT and Discounts into the price)
        // We distribute the (Total - Delivery Fee) across items proportionally
        const netTotalToDistribute = order.total - (order.delivery_fee || 0);
        
        orderItems.forEach((item) => {
            const itemWeight = grossSubtotal > 0 ? (item.subtotal / grossSubtotal) : 0;
            const itemTargetTotal = netTotalToDistribute * itemWeight;
            
            // Calculate unit price such that unitPrice * quantity approx = itemTargetTotal
            // We use the full target amount here to keep it simple for the user
            const unitAmountCents = Math.round((itemTargetTotal / item.quantity) * 100);
            const lineItemTotalCents = unitAmountCents * item.quantity;
            totalLineItemsCents += lineItemTotalCents;

            line_items.push({
                name: item.name,
                amount: unitAmountCents,
                quantity: item.quantity,
                currency: 'PHP'
            });
        });

        // 2. Add Delivery Fee as a separate explicit line item
        const deliveryCents = Math.round((order.delivery_fee || 0) * 100);
        if (deliveryCents > 0) {
            totalLineItemsCents += deliveryCents;
            line_items.push({
                name: 'Delivery Fee',
                amount: deliveryCents,
                quantity: 1,
                currency: 'PHP'
            });
        }

        // 4. Final verification: Ensure sum of line items equals target grand total
        const targetTotalCents = Math.round(order.total * 100);
        let currentTotalCents = line_items.reduce((sum, li) => sum + (li.amount * li.quantity), 0);
        let diffCents = targetTotalCents - currentTotalCents;

        if (diffCents !== 0 && line_items.length > 0) {
            console.log(`Adjusting PayRex Rounding: ${diffCents} cents`);
            // Find the most expensive item (usually best to adjust this one to minimize % impact)
            // or just the first item.
            const adjItem = line_items.find(li => li.quantity === 1) || line_items[0];
            
            if (adjItem.quantity === 1) {
                adjItem.amount += diffCents;
            } else {
                // If quantity > 1, we can't just add diffCents to amount without multiplying total by quantity.
                // We add as much as possible to unit amount, then handle remainder with a new adjustment line if necessary
                const unitAdj = Math.floor(diffCents / adjItem.quantity);
                adjItem.amount += unitAdj;
                
                const newTotalCents = line_items.reduce((sum, li) => sum + (li.amount * li.quantity), 0);
                const remainingDiff = targetTotalCents - newTotalCents;
                
                if (remainingDiff !== 0) {
                    line_items.push({
                        name: 'Rounding Adjustment',
                        amount: remainingDiff,
                        quantity: 1,
                        currency: 'PHP'
                    });
                }
            }
        }

        console.log("Final PayRex Target Total Cents:", targetTotalCents);
        console.log("Final PayRex Line Items:", JSON.stringify(line_items));

        const sessionPayload = {
            payment_methods: ['gcash', 'card', 'maya', 'qrph'],
            currency: 'PHP',
            line_items: line_items,
            success_url: `${baseUrl}/api/payment/success?order_id=${order.id}`,
            cancel_url: `${baseUrl}/api/payment/cancel?order_id=${order.id}`,
            reference_number: `OR-${order.id}-${Math.floor(Date.now()/1000)}`, // Shorter unique reference
            customer_email: order.customer_email || 'customer@example.com'
        };

        console.log("Creating PayRex Session...");

        const checkoutSession = await payrex.checkoutSessions.create(sessionPayload);
        return { url: checkoutSession.url, sessionId: checkoutSession.id };
    } catch (error) {
        console.error("PayRex API Error:", error.message || error);
        throw error; // Throw the actual error so order.js can catch it
    }
}

module.exports = {
    payrex,
    createCheckoutSession
};
