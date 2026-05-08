# ☕ Kape Kanto Hub — Implementation Plan

A full-stack café restaurant web application with aesthetic café-vibes design, role-based access, menu management, promos, order tracking, and payment processing.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | EJS (Templating), CSS (vanilla), JavaScript |
| Backend | Node.js + Express.js |
| Database | SQLite (swappable to MySQL later) |
| Auth | Express sessions + bcrypt |
| AI Validation | **Google Gemini Vision API** (Senior/PWD ID verification) |
| Font | **Poppins** + **Playfair Display** (Google Fonts — no Times New Roman) |

---

## User Review Required

> [!IMPORTANT]
> **Database Portability**: The SQLite schema will use standard SQL so you can migrate to MySQL later with minimal changes. We'll use the `better-sqlite3` npm package for synchronous, simple SQLite access.

> [!IMPORTANT]
> **PayRex Payment Gateway (Test Mode)**: Real payment processing via PayRex hosted checkout. Supports GCash, Card, Maya, and QRPH. Currently using **test API keys** — switch to live keys for production. Orders are **only confirmed after successful payment**; unpaid/cancelled checkouts do not create active orders.

> [!WARNING]
> **Image Uploads**: Menu item and promo images will be stored as file uploads in a `/public/uploads/` folder. For production with MySQL, you may want to switch to cloud storage (e.g., Cloudinary).

---

## Open Questions

> [!IMPORTANT]
> 1. **Do you want email verification or password reset?** The current plan uses simple username/password login.
> 2. **Should customers be able to register themselves**, or does only Admin create accounts?
> 3. **Senior/PWD discount percentage** — is it the standard **20% discount** mandated by Philippine law?
> 4. **Delivery fee** — should there be a flat delivery fee, or distance-based? (Current plan: no delivery fee, just records the address.)

---

## Folder Structure

```
cafe/
├── server.js                    # Express app entry point
├── package.json
├── .env                         # Gemini API key & secrets
├── database/
│   └── init.js                  # SQLite schema & seed data
├── middleware/
│   ├── auth.js                  # Session auth & role guards
│   └── upload.js                # Multer config for image uploads
├── services/
│   └── gemini.js                # Gemini Vision API integration
├── routes/
│   ├── index.js                 # Page rendering routes (EJS)
│   ├── auth.js                  # Login / Register / Logout API
│   ├── verify.js                # Senior/PWD ID verification endpoint
│   ├── menu.js                  # CRUD for menu items (Admin/Staff) API
│   ├── promo.js                 # CRUD for promos (Admin) API
│   ├── order.js                 # Place order, track, update status API
│   ├── user.js                  # User management (Admin) API
│   └── payment.js               # Payment processing API
├── views/                       # EJS Templates
│   ├── partials/                # Header, footer, nav
│   ├── index.ejs                # Homepage
│   ├── menu.ejs                 # Menu browsing page
│   ├── login.ejs                # Login page
│   ├── register.ejs             # Customer registration + ID upload
│   ├── cart.ejs                 # Cart & checkout
│   ├── order-tracking.ejs       # Order tracking
│   ├── payment-success.ejs
│   ├── payment-cancel.ejs
│   ├── admin/
│   │   ├── dashboard.ejs
│   │   ├── menu-manage.ejs
│   │   ├── promo-manage.ejs
│   │   ├── user-manage.ejs
│   │   └── orders.ejs
│   └── staff/
│       ├── dashboard.ejs
│       ├── orders.ejs
│       └── menu-stock.ejs
├── public/
│   ├── css/
│   │   └── style.css            # All styles (café aesthetic)
│   ├── js/
│   │   ├── main.js              # Shared utilities & nav
│   │   ├── carousel.js          # Homepage carousel
│   │   ├── cart.js              # Cart & checkout logic
│   │   └── dashboard.js         # Admin/Staff panel logic
│   └── uploads/
│       ├── menu/                # Menu item images
│       ├── promos/              # Promo banner images
│       └── ids/                 # Senior/PWD ID card uploads
└── README.md
```

---

## Database Schema

### `users`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | Auto-increment |
| username | TEXT UNIQUE | |
| email | TEXT UNIQUE | |
| password | TEXT | Bcrypt hashed |
| role | TEXT | `customer`, `admin`, `staff` |
| is_senior | BOOLEAN | Default 0 |
| is_pwd | BOOLEAN | Default 0 |
| senior_id_image | TEXT | File path to uploaded Senior ID photo |
| pwd_id_image | TEXT | File path to uploaded PWD ID photo |
| id_verification_status | TEXT | `none`, `pending`, `verified`, `rejected` |
| id_verification_notes | TEXT | AI analysis result / Admin notes |
| created_at | DATETIME | Default CURRENT_TIMESTAMP |

### `categories`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | |
| name | TEXT | e.g. "Hot Coffee", "Pastries", "Meals" |

### `menu_items`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | |
| name | TEXT | |
| description | TEXT | |
| price | REAL | |
| category_id | INTEGER | FK → categories |
| image | TEXT | File path |
| stock | INTEGER | Current stock count |
| is_available | BOOLEAN | Computed from stock > 0, or manually toggled |
| created_at | DATETIME | |
| updated_at | DATETIME | |

### `promos`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | |
| title | TEXT | |
| description | TEXT | |
| discount_percent | REAL | e.g. 15.0 |
| image | TEXT | Banner image path |
| start_date | DATETIME | Promo start |
| end_date | DATETIME | Promo end |
| is_active | BOOLEAN | Manually toggle + auto-check dates |
| promo_code | TEXT | Optional code customers can enter |
| created_at | DATETIME | |

### `promo_items`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | |
| promo_id | INTEGER | FK → promos |
| menu_item_id | INTEGER | FK → menu_items |

### `orders`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | |
| user_id | INTEGER | FK → users |
| status | TEXT | `awaiting_payment`, `pending`, `preparing`, `ready`, `out_for_delivery`, `completed`, `cancelled` |
| subtotal | REAL | Before discounts |
| discount_amount | REAL | Senior/PWD or promo discount |
| discount_type | TEXT | `senior`, `pwd`, `promo`, `none` |
| total | REAL | After discount |
| payment_method | TEXT | `gcash`, `card`, `maya`, `qrph` (set after PayRex checkout) |
| payment_status | TEXT | `awaiting`, `paid`, `failed`, `cancelled` |
| payrex_checkout_id | TEXT | PayRex checkout session ID for tracking |
| payrex_payment_id | TEXT | PayRex payment ID (set after successful payment) |
| order_type | TEXT | `delivery`, `pickup` |
| delivery_address | TEXT | Full address (only for delivery orders, NULL for pickup) |
| scheduled_date | TEXT | Preferred date (YYYY-MM-DD) |
| scheduled_time | TEXT | Preferred time slot (e.g. "10:00 AM", "2:30 PM") |
| notes | TEXT | Special instructions |
| created_at | DATETIME | |
| updated_at | DATETIME | |

### `order_items`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | |
| order_id | INTEGER | FK → orders |
| menu_item_id | INTEGER | FK → menu_items |
| quantity | INTEGER | |
| unit_price | REAL | Price at time of order |
| subtotal | REAL | quantity × unit_price |

---

## API Routes

### Auth (`/api/auth`)
| Method | Route | Access | Description |
|--------|-------|--------|-------------|
| POST | `/register` | Public | Customer registration |
| POST | `/login` | Public | Login (returns session) |
| POST | `/logout` | All | Destroy session |
| GET | `/me` | All | Get current user info |

### Menu (`/api/menu`)
| Method | Route | Access | Description |
|--------|-------|--------|-------------|
| GET | `/` | Public | List all menu items (with stock/availability) |
| GET | `/:id` | Public | Get single menu item |
| POST | `/` | Admin | Create menu item |
| PUT | `/:id` | Admin/Staff | Update menu item |
| DELETE | `/:id` | Admin | Delete menu item |
| PATCH | `/:id/stock` | Admin/Staff | Update stock count |

### Categories (`/api/categories`)
| Method | Route | Access | Description |
|--------|-------|--------|-------------|
| GET | `/` | Public | List all categories |
| POST | `/` | Admin | Create category |
| PUT | `/:id` | Admin | Update category |
| DELETE | `/:id` | Admin | Delete category |

### Promos (`/api/promos`)
| Method | Route | Access | Description |
|--------|-------|--------|-------------|
| GET | `/` | Public | List active promos |
| GET | `/all` | Admin | List all promos (inc. expired) |
| GET | `/:id` | Public | Single promo details |
| POST | `/` | Admin | Create promo |
| PUT | `/:id` | Admin | Update promo |
| DELETE | `/:id` | Admin | Delete promo |
| POST | `/validate` | Customer | Validate promo code |

### Orders (`/api/orders`)
| Method | Route | Access | Description |
|--------|-------|--------|-------------|
| POST | `/` | Customer | Place new order → creates PayRex checkout → returns redirect URL |
| GET | `/my` | Customer | Get own orders (only paid/active orders shown) |
| GET | `/my/:id` | Customer | Track specific order |
| GET | `/all` | Admin/Staff | Get all orders |
| PATCH | `/:id/status` | Admin/Staff | Update order status |

### Payment (`/api/payment`)
| Method | Route | Access | Description |
|--------|-------|--------|-------------|
| GET | `/success` | Customer | PayRex redirects here after successful payment — confirms order |
| GET | `/cancel` | Customer | PayRex redirects here if customer cancels — order stays `awaiting_payment` |
| POST | `/webhook` | PayRex | Webhook endpoint — PayRex sends payment events (backup confirmation) |

### Users (`/api/users`)
| Method | Route | Access | Description |
|--------|-------|--------|-------------|
| GET | `/` | Admin | List all users |
| GET | `/:id` | Admin | Get user details |
| POST | `/` | Admin | Create user (any role) |
| PUT | `/:id` | Admin | Update user |
| DELETE | `/:id` | Admin | Delete user |

### ID Verification (`/api/verify`)
| Method | Route | Access | Description |
|--------|-------|--------|-------------|
| POST | `/upload-id` | Customer | Upload Senior/PWD ID photo for AI verification |
| GET | `/status` | Customer | Check own verification status |
| GET | `/pending` | Admin | List all pending verifications |
| PATCH | `/:userId/approve` | Admin | Manually approve a verification |
| PATCH | `/:userId/reject` | Admin | Manually reject a verification |

### Page Rendering (`/`)
| Method | Route | Access | Description |
|--------|-------|--------|-------------|
| GET | `/` | Public | Render homepage |
| GET | `/menu` | Public | Render menu page |
| GET | `/login` | Public | Render login page |
| GET | `/register` | Public | Render registration |
| GET | `/cart` | Customer | Render cart |
| GET | `/order-tracking` | Customer | Render order tracking |
| GET | `/admin/*` | Admin | Render admin dashboard pages |
| GET | `/staff/*` | Staff | Render staff dashboard pages |

---

## Page Layouts & Features (EJS)

### 🏠 Homepage (`index.ejs`)
- **Hero carousel** rotating through:
  - Featured menu items
  - Active promos/events
  - Café ambiance images
- **Featured menu items** grid (best sellers)
- **Active promos** section with countdown timers
- **About section** — short café story
- **Footer** with contact info & social links

### 📋 Menu Page (`menu.ejs`)
- Category filter tabs (Hot Coffee, Iced Coffee, Pastries, Meals, etc.)
- Menu item cards showing:
  - Image, name, price
  - **Stock badge**: "Available" (green) / "Out of Stock" (red)
  - "Add to Cart" button (disabled if out of stock)
- Search bar for menu items
- Active promo banner at top

### 🛒 Cart & Checkout (`cart.ejs`)
- Cart items list with quantity controls (+/-)
- Promo code input field
- Senior/PWD discount toggle (auto-applied if user profile has verified `is_senior` or `is_pwd`)
- **Discount breakdown**:
  - Subtotal
  - Discount (20% for Senior/PWD, or promo %)
  - **Total**
- **Order type toggle**: 🚚 Delivery | 📦 Pickup
  - **Delivery selected**:
    - 📍 Delivery address text input (street, barangay, city)
    - 📅 Date picker (select preferred delivery date)
    - 🕐 Time picker (select preferred delivery time slot)
  - **Pickup selected**:
    - 📅 Date picker (select preferred pickup date)
    - 🕐 Time picker (select preferred pickup time slot)
    - ℹ️ Info text: "Pick up your order at Kape Kanto Hub"
- Payment method selector: Cash | GCash | Credit Card
- Special notes text area
- Place Order button

### 📦 Order Tracking (`order-tracking.ejs`)
- List of customer's past orders
- Order detail view:
  - Items ordered
  - Order type badge: 🚚 Delivery / 📦 Pickup
  - Scheduled date & time
  - Delivery address (if delivery)
  - **Status progress bar**:
    - Delivery: `Pending → Preparing → Ready → Out for Delivery → Completed`
    - Pickup: `Pending → Preparing → Ready for Pickup → Completed`
  - Payment status
  - Order timestamps

### 👑 Admin Dashboard (`admin/dashboard.ejs`)
- **Stats cards**: Total orders today, revenue, active promos, registered users
- **Quick links** to:
  - Menu Management (full CRUD — add, edit, delete items with image upload)
  - Promo Management (create promos with start/end dates, assign to menu items)
  - User Management (create/edit/delete users, assign roles)
  - All Orders (view & manage all orders)

### 👷 Staff Dashboard (`staff/dashboard.ejs`)
- **Incoming orders** feed (real-time-like with polling)
- **Update order status** buttons
- **Stock management** — quick stock update for menu items
- **Mark payment received**

---

## Design System (Café Vibes Aesthetic)

### Color Palette
| Token | Color | Usage |
|-------|-------|-------|
| `--primary` | `#6F4E37` | Coffee brown — buttons, accents |
| `--primary-light` | `#A0785D` | Lighter brown — hover states |
| `--primary-dark` | `#4A3423` | Dark brown — headers |
| `--secondary` | `#D4A574` | Warm latte — cards, highlights |
| `--accent` | `#E8B86D` | Gold caramel — badges, CTAs |
| `--bg-main` | `#FFF8F0` | Warm cream — page background |
| `--bg-card` | `#FFFFFF` | White — card backgrounds |
| `--bg-dark` | `#2C1A0E` | Dark espresso — dark sections |
| `--text-primary` | `#2C1A0E` | Dark brown — body text |
| `--text-light` | `#8B7355` | Muted brown — secondary text |
| `--success` | `#5B8C5A` | Green — available / success |
| `--danger` | `#C75643` | Terracotta red — out of stock / error |
| `--warning` | `#D4A017` | Amber — warnings |

### Typography
- **Headings**: `Playfair Display` (serif, elegant café feel)
- **Body**: `Poppins` (clean, modern sans-serif)
- **No Times New Roman** anywhere

### UI Elements
- Rounded cards with subtle box shadows
- Soft gradient overlays on hero/carousel
- Smooth hover transitions (0.3s ease)
- Coffee bean / steam decorative SVG accents
- Toast notifications for actions (add to cart, order placed, etc.)
- Status badges with color coding
- Glassmorphism on overlay modals

---

## Proposed Changes

### Phase 1 — Project Setup & Database

#### [NEW] [package.json](file:///c:/Users/LOL/Documents/cafe/package.json)
- npm init with dependencies: `express`, `better-sqlite3`, `bcrypt`, `express-session`, `multer`, `cors`, `dotenv`, `@google/generative-ai`, `payrex-node`, `ejs`
- Dev dependency: `nodemon`

#### [NEW] [.env](file:///c:/Users/LOL/Documents/cafe/.env)
- `GEMINI_API_KEY=AIzaSyA1OZHxngPn2EFrmOu1cpznp3DIsk-NwNI`
- `PAYREX_SECRET_KEY=sk_test_ozwX4MAwTybzc9YjqEj5VA9a5vms4mHz`
- `PAYREX_PUBLIC_KEY=pk_test_v9pvy7c5vRi9BYTZ25sNmDpmSmnw6aZh`
- `SESSION_SECRET=<random-secret>`
- `BASE_URL=http://localhost:3000`

#### [NEW] [server.js](file:///c:/Users/LOL/Documents/cafe/server.js)
- Express app setup, session config, static file serving, route mounting
- Configure EJS as view engine (`app.set('view engine', 'ejs')`)
- Mount `routes/index.js` for rendering EJS views

#### [NEW] [database/init.js](file:///c:/Users/LOL/Documents/cafe/database/init.js)
- Create all tables (users, categories, menu_items, promos, promo_items, orders, order_items)
- Seed default admin account (`admin` / `admin123`)
- Seed sample categories and a few menu items

---

### Phase 2 — Middleware & Auth

#### [NEW] [middleware/auth.js](file:///c:/Users/LOL/Documents/cafe/middleware/auth.js)
- `requireAuth` — check session exists
- `requireRole('admin')`, `requireRole('staff')`, `requireRole('admin', 'staff')` — role guards
- Attach `req.user` from session

#### [NEW] [middleware/upload.js](file:///c:/Users/LOL/Documents/cafe/middleware/upload.js)
- Multer config for menu item and promo images → `public/uploads/`

#### [NEW] [routes/auth.js](file:///c:/Users/LOL/Documents/cafe/routes/auth.js)
- POST `/register`, POST `/login`, POST `/logout`, GET `/me`

---

### Phase 3 — Backend CRUD Routes & AI Verification

#### [NEW] [services/gemini.js](file:///c:/Users/LOL/Documents/cafe/services/gemini.js)
- Initialize Gemini with API key from `.env`
- `verifyIdCard(imagePath, idType)` — sends image to Gemini Vision API
- Prompt instructs Gemini to analyze the photo and determine:
  - Is this a valid Philippine Senior Citizen ID or PWD ID?
  - Does it contain expected fields (name, ID number, expiry, photo, issuing agency)?
  - Is it likely genuine (not a screenshot of text, not a random image)?
- Returns `{ isValid: boolean, confidence: string, details: string }`

#### [NEW] [routes/verify.js](file:///c:/Users/LOL/Documents/cafe/routes/verify.js)
- POST `/upload-id` — accepts ID image upload, calls Gemini for analysis, stores result
- GET `/status` — returns current user's verification status
- GET `/pending` — Admin: list users with `pending` verification
- PATCH `/:userId/approve` — Admin manually approves
- PATCH `/:userId/reject` — Admin manually rejects

#### [NEW] [routes/menu.js](file:///c:/Users/LOL/Documents/cafe/routes/menu.js)
- Full CRUD for menu items with image upload and stock management

#### [NEW] [routes/promo.js](file:///c:/Users/LOL/Documents/cafe/routes/promo.js)
- Full CRUD for promos with date validation and promo code support

#### [NEW] [routes/order.js](file:///c:/Users/LOL/Documents/cafe/routes/order.js)
- Place orders (creates order with `awaiting_payment` status), track orders, update status, apply discounts
- When placing order: calculates total → creates PayRex checkout session → returns checkout URL

#### [NEW] [services/payrex.js](file:///c:/Users/LOL/Documents/cafe/services/payrex.js)
- Initialize PayRex SDK with secret key from `.env`
- `createCheckoutSession(order)` — creates a PayRex checkout session with:
  - `line_items` built from order items (name, amount in centavos, quantity)
  - `currency: 'PHP'`
  - `success_url` → `/api/payment/success?order_id={id}`
  - `cancel_url` → `/api/payment/cancel?order_id={id}`
  - `payment_methods: ['gcash', 'card', 'maya', 'qrph']`
- Returns the checkout session URL for customer redirect

#### [NEW] [routes/payment.js](file:///c:/Users/LOL/Documents/cafe/routes/payment.js)
- GET `/success` — called when PayRex redirects after successful payment:
  - Updates order `payment_status` → `paid`, `status` → `pending`
  - Decrements stock for all order items
  - Shows success page with order confirmation
- GET `/cancel` — called when customer cancels on PayRex page:
  - Order remains `awaiting_payment`
  - Shows cancellation page with option to retry payment
- POST `/webhook` — PayRex webhook (backup):
  - Verifies webhook signature
  - Handles `checkout_session.payment.paid` event
  - Updates order if not already confirmed (idempotent)

#### [NEW] [routes/user.js](file:///c:/Users/LOL/Documents/cafe/routes/user.js)
- Admin user management CRUD (includes ID verification review)

---

### Phase 4 — Frontend: Shared Assets & Homepage

#### [NEW] [public/css/style.css](file:///c:/Users/LOL/Documents/cafe/public/css/style.css)
- Complete design system: variables, resets, typography, layout, components
- Responsive breakpoints (mobile-first)
- Carousel styles, card styles, form styles, dashboard layouts

#### [NEW] [public/js/main.js](file:///c:/Users/LOL/Documents/cafe/public/js/main.js)
- Navigation (role-aware — show/hide admin/staff links)
- Toast notification system
- API helper functions (fetch wrappers)
- Session check and redirect logic

#### [NEW] [public/js/carousel.js](file:///c:/Users/LOL/Documents/cafe/public/js/carousel.js)
- Auto-rotating carousel with dots, prev/next arrows, touch support

#### [NEW] [public/pages/index.html](file:///c:/Users/LOL/Documents/cafe/public/pages/index.html)
- Hero carousel, featured items, active promos, about section, footer

---

### Phase 5 — Frontend: Menu, Cart & Checkout

#### [NEW] [public/pages/menu.html](file:///c:/Users/LOL/Documents/cafe/public/pages/menu.html)
- Category tabs, menu grid, search, stock badges

#### [NEW] [public/js/menu.js](file:///c:/Users/LOL/Documents/cafe/public/js/menu.js)
- Fetch menu items, filter by category, search, add to cart

#### [NEW] [public/pages/cart.html](file:///c:/Users/LOL/Documents/cafe/public/pages/cart.html)
- Cart display, promo code, Senior/PWD toggle, delivery/pickup options, checkout
- No payment method selector (PayRex handles payment method selection on their hosted page)
- "Proceed to Payment" button → sends order to backend → redirects to PayRex checkout

#### [NEW] [public/js/cart.js](file:///c:/Users/LOL/Documents/cafe/public/js/cart.js)
- Cart state (localStorage), quantity controls, discount calculation
- On checkout: POST to `/api/orders` → receive PayRex checkout URL → `window.location.href = url`

#### [NEW] [public/pages/payment-success.html](file:///c:/Users/LOL/Documents/cafe/public/pages/payment-success.html)
- Order confirmed page with confetti animation, order summary, and "Track My Order" link

#### [NEW] [public/pages/payment-cancel.html](file:///c:/Users/LOL/Documents/cafe/public/pages/payment-cancel.html)
- Payment cancelled page with "Return to Cart" and "Retry Payment" buttons

---

### Phase 6 — Frontend: Order Tracking

#### [NEW] [public/pages/order-tracking.html](file:///c:/Users/LOL/Documents/cafe/public/pages/order-tracking.html)
- Order history list, status progress bar

#### [NEW] [public/js/order-tracking.js](file:///c:/Users/LOL/Documents/cafe/public/js/order-tracking.js)
- Fetch orders, display status, auto-refresh

---

### Phase 7 — Frontend: Auth Pages

#### [NEW] [public/pages/login.html](file:///c:/Users/LOL/Documents/cafe/public/pages/login.html)
- Login form with café-themed design

#### [NEW] [public/pages/register.html](file:///c:/Users/LOL/Documents/cafe/public/pages/register.html)
- Registration form with Senior/PWD checkboxes
- **ID Upload Section** (shown when Senior or PWD is checked):
  - File input for ID card photo (front side)
  - Live preview of uploaded image
  - "Verify My ID" button that sends to Gemini API
  - Real-time status display: Analyzing → Verified ✅ / Rejected ❌
  - If rejected, user sees reason and can re-upload

---

### Phase 8 — Frontend: Admin Dashboard

#### [NEW] [public/pages/admin/dashboard.html](file:///c:/Users/LOL/Documents/cafe/public/pages/admin/dashboard.html)
- Stats overview, quick action links

#### [NEW] [public/pages/admin/menu-manage.html](file:///c:/Users/LOL/Documents/cafe/public/pages/admin/menu-manage.html)
- Menu item table with add/edit/delete modals, image upload, stock field

#### [NEW] [public/pages/admin/promo-manage.html](file:///c:/Users/LOL/Documents/cafe/public/pages/admin/promo-manage.html)
- Promo table with date pickers, discount %, promo code, assign menu items

#### [NEW] [public/pages/admin/user-manage.html](file:///c:/Users/LOL/Documents/cafe/public/pages/admin/user-manage.html)
- User table with role assignment, create/edit/delete

#### [NEW] [public/pages/admin/orders.html](file:///c:/Users/LOL/Documents/cafe/public/pages/admin/orders.html)
- All orders with status filter, status update, payment confirmation

#### [NEW] [public/js/admin-dashboard.js](file:///c:/Users/LOL/Documents/cafe/public/js/admin-dashboard.js)
- All admin page logic — CRUD modals, data tables, stats

---

### Phase 9 — Frontend: Staff Dashboard

#### [NEW] [public/pages/staff/dashboard.html](file:///c:/Users/LOL/Documents/cafe/public/pages/staff/dashboard.html)
- Incoming orders feed, quick actions

#### [NEW] [public/pages/staff/orders.html](file:///c:/Users/LOL/Documents/cafe/public/pages/staff/orders.html)
- Order queue with status update buttons

#### [NEW] [public/pages/staff/menu-stock.html](file:///c:/Users/LOL/Documents/cafe/public/pages/staff/menu-stock.html)
- Stock management table with quick increment/decrement

#### [NEW] [public/js/staff-dashboard.js](file:///c:/Users/LOL/Documents/cafe/public/js/staff-dashboard.js)
- Staff page logic — order management, stock updates

---

## Senior/PWD Discount Logic (with Gemini AI Verification)

### Registration Flow
1. Customer checks "I am a Senior Citizen" or "I am a PWD" during registration
2. A **file upload field appears** asking them to upload a photo of their ID card
3. The image is sent to the backend → **Gemini Vision API** analyzes it
4. Gemini checks:
   - Is this a valid Philippine Senior Citizen ID / PWD ID?
   - Does it have required elements: name, photo, ID number, issuing agency, expiry date?
   - Is it a real card photo (not a screenshot, drawing, or unrelated image)?
5. Based on Gemini's analysis:
   - ✅ **Verified** → `is_senior`/`is_pwd` flag is set to `true`, status = `verified`
   - ❌ **Rejected** → flag stays `false`, status = `rejected`, user sees reason
   - ⏳ **Uncertain** → status = `pending`, flagged for **Admin manual review**

### Admin Review
6. Admin can see all `pending` verifications in the User Management page
7. Admin can view the uploaded ID image and Gemini's analysis notes
8. Admin can **manually approve or reject** the verification

### Checkout Flow
9. At **checkout**, only users with `verified` status get the discount
10. A **20% discount** is automatically applied to the subtotal
11. The discount is shown in the breakdown
12. The discount type (`senior` or `pwd`) is recorded on the order
13. **Promo discounts and Senior/PWD discounts do NOT stack** — whichever is higher is applied

### Gemini Vision API Prompt (Example)
```
Analyze this image and determine if it is a valid Philippine Senior Citizen ID 
(or PWD ID). Check for the following:
1. Is this a photo of a physical ID card?
2. Does it contain a person's name, photo, and ID number?
3. Does it mention the issuing government agency (e.g., OSCA, NCDA)?
4. Does it have an expiry date or validity period?
5. Does it appear to be genuine and not digitally fabricated?

Respond in JSON format:
{
  "isValid": true/false,
  "confidence": "high"/"medium"/"low",
  "cardType": "senior_citizen_id"/"pwd_id"/"unknown",
  "detectedFields": ["name", "photo", "id_number", ...],
  "reason": "Brief explanation of your assessment"
}
```

---

## Promo System Logic

1. Admin creates a promo with:
   - Title, description, banner image
   - Discount percentage
   - Start date & end date (limited-time)
   - Optional promo code
   - Linked menu items (which items the promo applies to)
2. Promos **auto-activate/deactivate** based on current date vs. start/end dates
3. Active promos appear in the **homepage carousel** and a dedicated promos section
4. Customers can enter a **promo code** at checkout to apply the discount
5. Expired promos are hidden from customers but visible to Admin

---

## Stock Management

1. Each menu item has a `stock` integer field
2. **Available/Unavailable** is shown on menu cards:
   - Stock > 0 → Green "Available" badge + "Add to Cart" enabled
   - Stock = 0 → Red "Out of Stock" badge + "Add to Cart" disabled
3. When an order is **paid** (PayRex confirms payment), stock is **decremented** automatically
4. Admin and Staff can **update stock** from their dashboards
5. Admin can **toggle availability** manually (override)

---

## Verification Plan

### Automated Tests
```bash
# Start the server
npm run dev

# Test in browser at http://localhost:3000
```

### Manual Verification Checklist
- [ ] Homepage loads with carousel rotating through images/promos
- [ ] Menu page shows items with correct stock status (Available/Out of Stock)
- [ ] Customer can register, login, browse menu, add to cart, checkout
- [ ] Senior/PWD discount applies correctly at 20%
- [ ] Gemini AI correctly identifies valid Senior/PWD IDs from photo uploads
- [ ] Gemini AI rejects invalid/fake/unrelated images
- [ ] Pending verifications appear in Admin dashboard for manual review
- [ ] Admin can approve/reject pending ID verifications
- [ ] Only `verified` users get the Senior/PWD discount at checkout
- [ ] Promo codes validate and apply discount
- [ ] PayRex checkout redirects customer to hosted payment page
- [ ] After successful payment, order status changes from `awaiting_payment` → `pending`
- [ ] After cancelled payment, order stays `awaiting_payment` and customer can retry
- [ ] Unpaid orders do NOT appear in Staff/Admin active order queue
- [ ] PayRex webhook correctly confirms payment as backup
- [ ] Payment success page shows order confirmation with "Track My Order" link
- [ ] Payment cancel page shows "Return to Cart" and "Retry Payment" options
- [ ] Order tracking shows status progress bar
- [ ] Admin can CRUD menu items, promos, and users
- [ ] Staff can update order status and manage stock
- [ ] Responsive design works on mobile/tablet
- [ ] No Times New Roman font appears anywhere
- [ ] All three user roles have correct access permissions
- [ ] Out-of-stock items cannot be added to cart
- [ ] Promo time limits work (expired promos hidden from customers)

### Browser Testing
- Test all pages in browser using the browser tool
- Verify visual design matches café aesthetic
- Test all CRUD operations through the UI
- Verify role-based navigation (different menus for each role)
