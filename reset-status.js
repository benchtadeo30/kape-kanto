const { db } = require('./database/init');
db.prepare("UPDATE users SET id_verification_status = 'none', id_verification_notes = NULL").run();
console.log('Verification status reset for all users');