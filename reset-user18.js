const { db } = require('./database/init');
db.prepare("UPDATE users SET id_verification_status = 'none', senior_id_image = NULL, pwd_id_image = NULL, id_verification_notes = NULL WHERE id = 18").run();
console.log('Reset status for user ID 18 (tadeorafael41@gmail.com)');