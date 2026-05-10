const Database = require('better-sqlite3');
const db = new Database('C:/var/data/cafe.db');

try {
    const promoQuery = `
        SELECT id, title, description, discount_percent, discount_amount, image, 
               start_date, end_date, promo_code, 'promo' as event_type, created_at
        FROM promos 
        WHERE is_active = 1
    `;

    const taskQuery = `
        SELECT id, title, description, 0 as discount_percent, 0 as discount_amount, NULL as image,
               NULL as start_date, end_date, NULL as promo_code, 'task' as event_type, NULL as created_at
        FROM promo_tasks
        WHERE is_active = 1
    `;

    const unifiedQuery = `
        SELECT * FROM (${promoQuery} UNION ALL ${taskQuery}) as combined
        ORDER BY COALESCE(created_at, '0000-00-00') DESC, id DESC
    `;

    const items = db.prepare(unifiedQuery).all();
    console.log("Unified Items Found:", items.length);
    items.forEach(item => {
        console.log(`- [${item.event_type}] ${item.title} | Code: ${item.promo_code}`);
    });
} catch (e) {
    console.error("Query Error:", e.message);
}

process.exit(0);
