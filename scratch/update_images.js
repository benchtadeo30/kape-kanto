const Database = require('better-sqlite3');
const db = new Database('database/cafe.db');

const IMAGE_MAP = [
    { keywords: ['spanish latte'], url: 'https://images.unsplash.com/photo-1570968015863-d39600be750b?auto=format&fit=crop&q=80&w=600' },
    { keywords: ['latte'], url: 'https://images.unsplash.com/photo-1594132225292-a0d5ad0ecf17?auto=format&fit=crop&q=80&w=600' },
    { keywords: ['cappuccino'], url: 'https://images.unsplash.com/photo-1572442388796-11668a67e53d?auto=format&fit=crop&q=80&w=600' },
    { keywords: ['espresso'], url: 'https://images.unsplash.com/photo-1510707577719-af7c183f1e59?auto=format&fit=crop&q=80&w=600' },
    { keywords: ['americano'], url: 'https://images.unsplash.com/photo-1551033406-611cf9a28f67?auto=format&fit=crop&q=80&w=600' },
    { keywords: ['mocha'], url: 'https://images.unsplash.com/photo-1578314675249-a6910f80cc4e?auto=format&fit=crop&q=80&w=600' },
    { keywords: ['frappe', 'blended'], url: 'https://images.unsplash.com/photo-1572490122747-3968b75cc699?auto=format&fit=crop&q=80&w=600' },
    { keywords: ['macchiato'], url: 'https://images.unsplash.com/photo-1485808191679-5f86510681a2?auto=format&fit=crop&q=80&w=600' },
    { keywords: ['chocolate', 'cocoa'], url: 'https://images.unsplash.com/photo-1544787210-2211d24733e7?auto=format&fit=crop&q=80&w=600' },
    { keywords: ['matcha'], url: 'https://images.unsplash.com/photo-1582736143158-a4688e7d32c8?auto=format&fit=crop&q=80&w=600' },
    { keywords: ['croissant', 'bread', 'pastry'], url: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?auto=format&fit=crop&q=80&w=600' },
    { keywords: ['sandwich', 'burger', 'rice', 'meal'], url: 'https://images.unsplash.com/photo-1525351484163-7529414344d8?auto=format&fit=crop&q=80&w=600' },
    { keywords: ['tea'], url: 'https://images.unsplash.com/photo-1544787210-2211d24733e7?auto=format&fit=crop&q=80&w=600' }
];

const items = db.prepare("SELECT id, name FROM menu_items").all();

const updateStmt = db.prepare("UPDATE menu_items SET image = ? WHERE id = ?");

let updatedCount = 0;

for (const item of items) {
    const name = item.name.toLowerCase();
    let bestUrl = null;
    
    for (const mapping of IMAGE_MAP) {
        if (mapping.keywords.some(k => name.includes(k))) {
            bestUrl = mapping.url;
            break;
        }
    }
    
    if (bestUrl) {
        updateStmt.run(bestUrl, item.id);
        updatedCount++;
    }
}

console.log(`Updated ${updatedCount} items with realistic images.`);
db.close();
