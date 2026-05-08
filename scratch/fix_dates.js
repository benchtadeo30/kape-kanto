const path = require('path');
const { db } = require(path.resolve(__dirname, '../database/init'));

try {
    const updatePromos = db.prepare(`UPDATE promos SET start_date = REPLACE(start_date, 'T', ' '), end_date = REPLACE(end_date, 'T', ' ')`);
    const resultPromos = updatePromos.run();
    console.log('Fixed promos dates:', resultPromos.changes);

    const updateTasks = db.prepare(`UPDATE promo_tasks SET end_date = REPLACE(end_date, 'T', ' ')`);
    const resultTasks = updateTasks.run();
    console.log('Fixed promo_tasks dates:', resultTasks.changes);
} catch(e) {
    console.error('Error:', e);
}
