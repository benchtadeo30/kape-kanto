const { db } = require('./database/init');
const users = db.prepare("SELECT id, email, id_verification_status, id_verification_notes FROM users").all();
console.log('Current verification statuses:');
users.forEach(u => console.log(`ID: ${u.id}, Email: ${u.email}, Status: ${u.id_verification_status}, Notes: ${u.id_verification_notes}`));