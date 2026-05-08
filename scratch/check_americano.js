const { db } = require('../database/init');
const item = db.prepare("SELECT * FROM menu_items WHERE name LIKE '%Americano%'").get();
console.log(item);
