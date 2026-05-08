const { db } = require('../database/init');

const orders = db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 5").all();

console.log("--- ORDER AUDIT ---");
orders.forEach(o => {
    const items = JSON.parse(o.items || '[]');
    let subtotal = 0;
    items.forEach(item => {
        // We simulate the backend calculation logic here
        const dbItem = db.prepare("SELECT price FROM menu_items WHERE id = ?").get(item.id);
        if (dbItem) {
            let adjusted = dbItem.price;
            // Note: simple audit, doesn't account for complex customization prices from the past
            subtotal += adjusted * item.quantity;
        }
    });

    const isSC = o.is_senior || o.is_pwd;
    const vatExempt = subtotal / 1.12;
    const scDisc = isSC ? vatExempt * 0.2 : 0;
    // Assuming no promo for audit simplicity
    const vat = isSC ? 0 : (vatExempt * 0.12);
    const expected = (vatExempt - scDisc) + vat + (o.delivery_fee || 0);

    console.log(`Order #${o.id} (${o.status}):`);
    console.log(`  Stored Total:   ${o.total}`);
    console.log(`  Audited Total:  ${expected.toFixed(2)}`);
    if (Math.abs(o.total - expected) > 1) {
        console.log(`  ⚠️ DISCREPANCY DETECTED`);
    } else {
        console.log(`  ✅ OK`);
    }
});
