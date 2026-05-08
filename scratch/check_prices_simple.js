const { db } = require('../database/init');
const item = db.prepare("SELECT name, price FROM menu_items WHERE name = 'Kanto Americano'").get();
console.log('ITEM_PRICE_CHECK:', item);
const items = db.prepare("SELECT name, price FROM menu_items").all();
console.log('ALL_ITEMS:', items);
