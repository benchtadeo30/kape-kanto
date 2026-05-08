const path = require('path');
const { db } = require(path.resolve(__dirname, '../database/init'));

async function simulateCheckout(promoCode, isSenior = false) {
    console.log(`\n--- Simulating Checkout (${promoCode || 'None'}, SC: ${isSenior}) ---`);
    
    // 1. Mock Cart Items
    const items = [
        { id: 1, name: 'Americano', price: 100, quantity: 1, subtotal: 100, category_id: 1 },
        { id: 2, name: 'Cafe Latte', price: 120, quantity: 1, subtotal: 120, category_id: 1 }
    ];
    const subtotal = 220;

    // 2. Initial Calculations
    let vat_exempt_sales = subtotal / 1.12;
    let vat_amount = vat_exempt_sales * 0.12;
    
    let sc_discount = 0;
    if (isSenior) {
        sc_discount = vat_exempt_sales * 0.20;
        vat_amount = 0; // Exempt
    }

    // 3. Promo Calculation
    let promo_discount_amount = 0;
    if (promoCode) {
        const promo = db.prepare(`
            SELECT * FROM promos 
            WHERE UPPER(promo_code) = UPPER(?) AND is_active = 1
            AND (start_date IS NULL OR start_date = '' OR datetime(start_date) <= datetime('now', 'localtime'))
            AND (end_date IS NULL OR end_date = '' OR datetime(end_date) >= datetime('now', 'localtime'))
        `).get(promoCode);

        if (promo) {
            let applicableNet = vat_exempt_sales;
            if (isSenior) {
                applicableNet = vat_exempt_sales * 0.8; // Apply on net after 20% discount
            }

            if (promo.discount_percent > 0) {
                promo_discount_amount = applicableNet * (promo.discount_percent / 100);
            } else if (promo.discount_amount > 0) {
                promo_discount_amount = Math.min(promo.discount_amount, applicableNet);
            }
        } else {
            console.log("Promo not found or invalid dates.");
        }
    }

    // 4. Final VAT Recalculation (The fix I just added)
    let final_vat_amount = vat_amount;
    if (!isSenior) {
        final_vat_amount = (vat_exempt_sales - promo_discount_amount) * 0.12;
    }

    const delivery_fee = 0;
    const total = (vat_exempt_sales - sc_discount - promo_discount_amount) + final_vat_amount + delivery_fee;

    console.log(`Subtotal: ${subtotal}`);
    console.log(`Net Sales: ${vat_exempt_sales.toFixed(2)}`);
    console.log(`SC Discount: ${sc_discount.toFixed(2)}`);
    console.log(`Promo Discount: ${promo_discount_amount.toFixed(2)}`);
    console.log(`VAT: ${final_vat_amount.toFixed(2)}`);
    console.log(`Total: ${total.toFixed(2)}`);
    
    return total;
}

(async () => {
    // 1. Setup Test Promos in DB
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 16);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 16);
    const todayPast = new Date(now.getTime() - 3600000).toISOString().replace('T', ' ').slice(0, 16);
    const todayFuture = new Date(now.getTime() + 3600000).toISOString().replace('T', ' ').slice(0, 16);

    db.prepare("DELETE FROM promos WHERE promo_code IN ('FUTURE50', 'EXPIRED50', 'ACTIVE50')").run();
    db.prepare("INSERT INTO promos (title, promo_code, discount_percent, start_date, is_active) VALUES (?, ?, ?, ?, ?)").run('Future', 'FUTURE50', 50, tomorrow, 1);
    db.prepare("INSERT INTO promos (title, promo_code, discount_percent, start_date, end_date, is_active) VALUES (?, ?, ?, ?, ?, ?)").run('Expired', 'EXPIRED50', 50, todayPast, yesterday, 1);
    db.prepare("INSERT INTO promos (title, promo_code, discount_percent, start_date, end_date, is_active) VALUES (?, ?, ?, ?, ?, ?)").run('Active', 'ACTIVE50', 50, todayPast, todayFuture, 1);

    await simulateCheckout('FUTURE50');
    await simulateCheckout('EXPIRED50');
    await simulateCheckout('ACTIVE50');
    await simulateCheckout('ACTIVE50', true); // Senior Citizen
})();
