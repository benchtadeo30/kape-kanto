const { db, initDb } = require('../database/init');
try {
    console.log("Running initDb()...");
    initDb();
    const info = db.prepare("PRAGMA table_info(users)").all();
    console.log("Table info:", JSON.stringify(info, null, 2));
} catch (e) {
    console.error("Error:", e);
}
process.exit();
