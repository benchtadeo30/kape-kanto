const Database = require('better-sqlite3');
const db = new Database('C:/var/data/cafe.db');

const tableInfo = db.prepare('PRAGMA table_info(promos)').all();
console.log("Current Promos Columns:", tableInfo.map(c => c.name).join(', '));

const requiredColumns = [
    { name: 'event_type', def: "TEXT DEFAULT 'promo'" },
    { name: 'discount_amount', def: "REAL DEFAULT 0" }
];

requiredColumns.forEach(col => {
    if (!tableInfo.find(c => c.name === col.name)) {
        try {
            db.prepare(`ALTER TABLE promos ADD COLUMN ${col.name} ${col.def}`).run();
            console.log(`Successfully added column: ${col.name}`);
        } catch (e) {
            console.error(`Error adding column ${col.name}:`, e.message);
        }
    } else {
        console.log(`Column already exists: ${col.name}`);
    }
});

process.exit(0);
