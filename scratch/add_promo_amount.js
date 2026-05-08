const Database = require('better-sqlite3');
const db = new Database('database/cafe.db');

try {
    db.prepare('ALTER TABLE promos ADD COLUMN discount_amount REAL DEFAULT 0').run();
    console.log('Column discount_amount added successfully.');
} catch (err) {
    if (err.message.includes('duplicate column name')) {
        console.log('Column already exists.');
    } else {
        console.error('Error adding column:', err);
    }
} finally {
    db.close();
}
