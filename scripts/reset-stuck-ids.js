const { db } = require('../database/init');

try {
    const info = db.prepare(`
        UPDATE users 
        SET id_verification_status = 'none', 
            id_verification_message = NULL,
            id_verification_notes = NULL
        WHERE id_verification_status = 'pending'
    `).run();
    console.log(`Successfully reset ${info.changes} stuck verification processes.`);
    process.exit(0);
} catch (error) {
    console.error('Failed to reset status:', error);
    process.exit(1);
}
