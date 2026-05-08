const { db } = require('../database/init');
try {
    const items = db.prepare("SELECT * FROM order_items LIMIT 5").all();
    console.log(items);
} catch (e) {
    console.log("Error:", e.message);
}
