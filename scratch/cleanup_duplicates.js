const { db } = require('../database/init');

function cleanup() {
    console.log("--- Starting Menu Duplication Cleanup ---");
    
    try {
        db.prepare('BEGIN TRANSACTION').run();

        // 1. Get all menu items
        const menuItems = db.prepare('SELECT id, name FROM menu_items').all();

        for (const item of menuItems) {
            // Get all options for this item
            const options = db.prepare('SELECT id, name FROM menu_item_options WHERE menu_item_id = ?').all(item.id);
            
            const seenOptions = {}; // name -> primaryId

            for (const opt of options) {
                const name = opt.name.trim();
                if (!seenOptions[name]) {
                    seenOptions[name] = opt.id;
                } else {
                    const primaryId = seenOptions[name];
                    console.log(`Merging duplicate option "${name}" (ID ${opt.id} -> ${primaryId}) for item ${item.name}`);

                    // Re-link choices from the duplicate option to the primary one
                    db.prepare('UPDATE menu_item_option_choices SET option_id = ? WHERE option_id = ?').run(primaryId, opt.id);
                    
                    // Delete the duplicate option
                    db.prepare('DELETE FROM menu_item_options WHERE id = ?').run(opt.id);
                }
            }
        }

        // 2. Clean up duplicate choices within each primary option
        const allOptions = db.prepare('SELECT id, name FROM menu_item_options').all();
        for (const opt of allOptions) {
            const choices = db.prepare('SELECT id, name FROM menu_item_option_choices WHERE option_id = ?').all(opt.id);
            const seenChoices = {}; // name -> primaryId

            for (const choice of choices) {
                const name = choice.name.trim();
                if (!seenChoices[name]) {
                    seenChoices[name] = choice.id;
                } else {
                    console.log(`Deleting duplicate choice "${name}" (ID ${choice.id}) in option "${opt.name}"`);
                    db.prepare('DELETE FROM menu_item_option_choices WHERE id = ?').run(choice.id);
                }
            }
        }

        db.prepare('COMMIT').run();
        console.log("--- Cleanup Complete! ---");
    } catch (e) {
        if (db.inTransaction) db.prepare('ROLLBACK').run();
        console.error("Cleanup failed:", e);
    }
}

cleanup();
