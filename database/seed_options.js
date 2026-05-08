const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'cafe.db');
const db = new Database(dbPath);

function seedMoreOptions() {
    console.log("Seeding more menu item options...");

    const items = db.prepare('SELECT id, name FROM menu_items').all();

    const insertOption = db.prepare('INSERT INTO menu_item_options (menu_item_id, name) VALUES (?, ?)');
    const insertChoice = db.prepare('INSERT INTO menu_item_option_choices (option_id, name, price_adjustment) VALUES (?, ?, ?)');

    items.forEach(item => {
        // Skip Kanto Americano as it already has options from initDb
        if (item.name === 'Kanto Americano') return;

        if (item.name.includes('Coffee') || item.name.includes('Latte')) {
            // Add Sugar Level
            const sugarOptId = insertOption.run(item.id, 'Sugar Level').lastInsertRowid;
            insertChoice.run(sugarOptId, 'No Sugar', 0);
            insertChoice.run(sugarOptId, '25%', 0);
            insertChoice.run(sugarOptId, '50%', 0);
            insertChoice.run(sugarOptId, '75%', 0);
            insertChoice.run(sugarOptId, '100%', 0);

            // Add Size
            const sizeOptId = insertOption.run(item.id, 'Size').lastInsertRowid;
            insertChoice.run(sizeOptId, 'Regular', 0);
            insertChoice.run(sizeOptId, 'Medium', 20);
            insertChoice.run(sizeOptId, 'Large', 40);
        } else if (item.name.includes('Pastries') || item.name.includes('Croissant') || item.name.includes('Cookie')) {
            // Add Warmth
            const warmOptId = insertOption.run(item.id, 'Serving Preference').lastInsertRowid;
            insertChoice.run(warmOptId, 'Standard', 0);
            insertChoice.run(warmOptId, 'Warmed Up', 0);
            
            // Add Toppings
            const toppingOptId = insertOption.run(item.id, 'Extra Toppings').lastInsertRowid;
            insertChoice.run(toppingOptId, 'None', 0);
            insertChoice.run(toppingOptId, 'Extra Chocolate', 15);
            insertChoice.run(toppingOptId, 'Whipped Cream', 10);
        }
    });

    console.log("Seeding complete.");
}

seedMoreOptions();
