const { db } = require('../database/init');

const item = db.prepare("SELECT * FROM menu_items WHERE name = 'Kanto Americano'").get();
console.log('Item:', item);

if (item) {
    const options = db.prepare("SELECT * FROM menu_item_options WHERE menu_item_id = ?").all(item.id);
    for (const opt of options) {
        const choices = db.prepare("SELECT * FROM menu_item_option_choices WHERE option_id = ?").all(opt.id);
        console.log(`Option: ${opt.name}`, choices);
    }
}
