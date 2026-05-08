const path = require('path');
const { db } = require(path.resolve(__dirname, '../database/init'));

function toLocalISO(date) {
    // Manually offset to +8 (Philippines) for the simulation
    const offsetDate = new Date(date.getTime() + (8 * 60 * 60 * 1000));
    return offsetDate.toISOString().replace('T', ' ').slice(0, 16);
}

async function simulateCheckout(promoCode, isSenior = false) {
    console.log(`\n--- Simulating Checkout (${promoCode || 'None'}, SC: ${isSenior}) ---`);
    
    const items = [{ id: 1, name: 'Americano', price: 100, quantity: 1, subtotal: 100, category_id: 1 }];
    const subtotal = 100;
    let vat_exempt_sales = subtotal / 1.12;
    let vat_amount = vat_exempt_sales * 0.12;
    let sc_discount = 0;
    if (isSenior) {
        sc_discount = vat_exempt_sales * 0.20;
        vat_amount = 0;
    }

    let promo_discount_amount = 0;
    if (promoCode) {
        const promo = db.prepare(`
            SELECT * FROM promos 
            WHERE UPPER(promo_code) = UPPER(?) AND is_active = 1
            AND (start_date IS NULL OR start_date = '' OR datetime(start_date) <= datetime('now', 'localtime'))
            AND (end_date IS NULL OR end_date = '' OR datetime(end_date) >= datetime('now', 'localtime'))
        `).get(promoCode);

        if (promo) {
            console.log("Promo Applied!");
            let applicableNet = vat_exempt_sales;
            if (isSenior) applicableNet = vat_exempt_sales * 0.8;
            if (promo.discount_percent > 0) promo_discount_amount = applicableNet * (promo.discount_percent / 100);
            else if (promo.discount_amount > 0) promo_discount_amount = Math.min(promo.discount_amount, applicableNet);
        } else {
            console.log("Promo not found or invalid dates.");
        }
    }

    let final_vat_amount = vat_amount;
    if (!isSenior) {
        final_vat_amount = (vat_exempt_sales - promo_discount_amount) * 0.12;
    }

    const total = (vat_exempt_sales - sc_discount - promo_discount_amount) + final_vat_amount + 0;
    console.log(`Final Total: ${total.toFixed(2)}`);
}

(async () => {
    const now = new Date();
    const tomorrow = toLocalISO(new Date(now.getTime() + 24 * 60 * 60 * 1000));
    const yesterday = toLocalISO(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const todayPast = toLocalISO(new Date(now.getTime() - 3600000));
    const todayFuture = toLocalISO(new Date(now.getTime() + 3600000));

    db.prepare("DELETE FROM promos WHERE promo_code IN ('F50', 'E50', 'A50')").run();
    db.prepare("INSERT INTO promos (title, promo_code, discount_percent, start_date, is_active) VALUES (?, ?, ?, ?, ?)").run('Future', 'F50', 50, tomorrow, 1);
    db.prepare("INSERT INTO promos (title, promo_code, discount_percent, start_date, end_date, is_active) VALUES (?, ?, ?, ?, ?, ?)").run('Expired', 'E50', 50, todayPast, yesterday, 1);
    db.prepare("INSERT INTO promos (title, promo_code, discount_percent, start_date, end_date, is_active) VALUES (?, ?, ?, ?, ?, ?)").run('Active', 'A50', 50, todayPast, todayFuture, 1);

    await simulateCheckout('F50'); // Rejection
    await simulateCheckout('E50'); // Rejection
    await simulateCheckout('A50'); // Success
})();
