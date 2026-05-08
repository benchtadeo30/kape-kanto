const path = require('path');
const { db } = require(path.resolve(__dirname, '../database/init'));

// Run exactly the same query used in routes/promo.js validate endpoint
const code = 'FUTURE50';
const promoFuture = db.prepare(`
    SELECT p.*
    FROM promos p
    WHERE UPPER(p.promo_code) = UPPER(?) 
    AND p.is_active = 1 
    AND (p.start_date IS NULL OR p.start_date = '' OR datetime(p.start_date) <= datetime('now', 'localtime'))
    AND (p.end_date IS NULL OR p.end_date = '' OR datetime(p.end_date) >= datetime('now', 'localtime'))
`).get(code);

console.log("Future50 Valid?", !!promoFuture);

const promoExpired = db.prepare(`
    SELECT p.*
    FROM promos p
    WHERE UPPER(p.promo_code) = UPPER(?) 
    AND p.is_active = 1 
    AND (p.start_date IS NULL OR p.start_date = '' OR datetime(p.start_date) <= datetime('now', 'localtime'))
    AND (p.end_date IS NULL OR p.end_date = '' OR datetime(p.end_date) >= datetime('now', 'localtime'))
`).get('EXPIRED50');

console.log("Expired50 Valid?", !!promoExpired);

const active = db.prepare(`
    SELECT p.*
    FROM promos p
    WHERE UPPER(p.promo_code) = UPPER(?) 
    AND p.is_active = 1 
    AND (p.start_date IS NULL OR p.start_date = '' OR datetime(p.start_date) <= datetime('now', 'localtime'))
    AND (p.end_date IS NULL OR p.end_date = '' OR datetime(p.end_date) >= datetime('now', 'localtime'))
`).get('ACTIVE50');

console.log("Active50 Valid?", !!active);
