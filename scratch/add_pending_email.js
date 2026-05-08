const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../database/cafe.db'));

try {
    db.prepare('ALTER TABLE users ADD COLUMN pending_email TEXT').run();
    console.log('Added pending_email column to users table.');
} catch (e) {
    if (e.message.includes('duplicate column name')) {
        console.log('pending_email column already exists.');
    } else {
        console.error(e);
    }
}
