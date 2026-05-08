const { db } = require('../database/init');

// Delete test promos
const deleted = db.prepare(`
    DELETE FROM promos 
    WHERE title IN ('Future', 'Expired', 'Active', 'Test Flash Sale', 'Quick Test Promo')
`).run();

console.log(`Deleted ${deleted.changes} test promos.`);

// Rename tasks to better names
const rename1 = db.prepare(`
    UPDATE promo_tasks 
    SET title = 'Americano Connoisseur',
        customer_description = 'Buy 5 Americanos to earn a special 20% discount coupon! ☕️'
    WHERE title = 'Buy 5 Americanos' OR title = 'Loyalty Test Final'
`).run();

console.log(`Renamed/Updated ${rename1.changes} tasks.`);

const rename2 = db.prepare(`
    UPDATE promo_tasks 
    SET title = 'Pastry Enthusiast'
    WHERE title = 'Pastries Lover'
`).run();

console.log(`Renamed ${rename2.changes} pastry tasks.`);
