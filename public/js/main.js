// ─── Toast Notification System ─────────────────────────────────────────────
function showToast(message, type = 'success', duration = null) {
    const defaultDurations = { success: 3500, error: 8000, warning: 5000, info: 4000 };
    const ms = duration || defaultDurations[type] || 4000;

    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };
    const icon = icons[type] || 'fa-circle-info';

    toast.innerHTML = `
        <i class="fa-solid ${icon}" style="flex-shrink:0;"></i>
        <span>${message}</span>
        <button onclick="this.closest('.toast').remove()" style="background:none;border:none;cursor:pointer;opacity:0.6;padding:0;margin-left:auto;font-size:1rem;color:inherit;">
            <i class="fa-solid fa-xmark"></i>
        </button>`;

    toast.style.cssText = 'display:flex;align-items:center;gap:10px;';
    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => toast.classList.add('toast-show'));

    const timer = setTimeout(() => {
        toast.classList.remove('toast-show');
        toast.classList.add('toast-hide');
        setTimeout(() => toast.remove(), 400);
    }, ms);

    toast.addEventListener('click', (e) => {
        if (e.target.closest('button')) {
            clearTimeout(timer);
        }
    });
}

// ─── Custom Confirm Modal ──────────────────────────────────────────────────
function showConfirm(message, onConfirm, { title = 'Confirm Action', confirmText = 'Confirm', cancelText = 'Cancel', type = 'warning' } = {}) {
    // Remove any existing confirm modal
    document.getElementById('kk-confirm-modal')?.remove();

    const icons = { warning: 'fa-triangle-exclamation', danger: 'fa-circle-xmark', info: 'fa-circle-info', success: 'fa-circle-check' };
    const colors = { warning: '#f57f17', danger: '#c62828', info: '#6F4E37', success: '#2e7d32' };
    const icon = icons[type] || icons.warning;
    const color = colors[type] || colors.warning;

    const modal = document.createElement('div');
    modal.id = 'kk-confirm-modal';
    modal.className = 'kk-modal-overlay';
    modal.innerHTML = `
        <div class="kk-confirm-backdrop"></div>
        <div class="kk-confirm-box">
            <div class="kk-confirm-icon" style="color:${color};">
                <i class="fa-solid ${icon}"></i>
            </div>
            <h3 class="kk-confirm-title">${title}</h3>
            <p class="kk-confirm-msg">${message}</p>
            <div class="kk-confirm-actions">
                <button id="kk-confirm-cancel" class="kk-confirm-btn kk-confirm-btn-cancel">${cancelText}</button>
                <button id="kk-confirm-ok" class="kk-confirm-btn kk-confirm-btn-ok" style="background:${color};">${confirmText}</button>
            </div>
        </div>`;

    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('kk-confirm-show'));

    const close = () => {
        modal.classList.remove('kk-confirm-show');
        setTimeout(() => modal.remove(), 300);
    };

    document.getElementById('kk-confirm-ok').addEventListener('click', () => { close(); onConfirm(); });
    document.getElementById('kk-confirm-cancel').addEventListener('click', close);
    modal.querySelector('.kk-confirm-backdrop').addEventListener('click', close);
}

// ─── Custom Alert Modal ────────────────────────────────────────────────────
function showAlert(message, { title = 'Notice', okText = 'OK', type = 'info' } = {}) {
    document.getElementById('kk-alert-modal')?.remove();

    const icons = { info: 'fa-circle-info', success: 'fa-circle-check', warning: 'fa-triangle-exclamation', danger: 'fa-circle-xmark' };
    const colors = { info: '#6F4E37', success: '#2e7d32', warning: '#f57f17', danger: '#c62828' };
    const icon = icons[type] || icons.info;
    const color = colors[type] || colors.info;

    const modal = document.createElement('div');
    modal.id = 'kk-alert-modal';
    modal.className = 'kk-modal-overlay';
    modal.innerHTML = `
        <div class="kk-confirm-backdrop"></div>
        <div class="kk-confirm-box">
            <div class="kk-confirm-icon" style="color:${color};">
                <i class="fa-solid ${icon}"></i>
            </div>
            <h3 class="kk-confirm-title">${title}</h3>
            <p class="kk-confirm-msg">${message}</p>
            <div class="kk-confirm-actions" style="justify-content: center;">
                <button id="kk-alert-ok" class="kk-confirm-btn kk-confirm-btn-ok" style="background:${color}; width: 100%; max-width: 120px;">${okText}</button>
            </div>
        </div>`;

    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('kk-confirm-show'));

    const close = () => {
        modal.classList.remove('kk-confirm-show');
        setTimeout(() => modal.remove(), 300);
    };

    document.getElementById('kk-alert-ok').addEventListener('click', close);
    modal.querySelector('.kk-confirm-backdrop').addEventListener('click', close);
}

// ─── Cart System — LocalStorage ─────────────────────────────────────────────
function getCart() {
    try {
        const cart = localStorage.getItem('cafe_cart');
        return cart ? JSON.parse(cart) : [];
    } catch { return []; }
}

function saveCart(cart) {
    localStorage.setItem('cafe_cart', JSON.stringify(cart));
    updateCartBadge();
}

function updateCartBadge() {
    const badge = document.getElementById('cart-badge');
    const mobileBadge = document.getElementById('mobile-cart-badge');
    if (badge || mobileBadge) {
        const cart = getCart();
        const count = cart.reduce((total, item) => total + item.quantity, 0);
        if (badge) {
            badge.innerText = count;
            badge.style.display = count > 0 ? 'flex' : 'none';
        }
        if (mobileBadge) {
            mobileBadge.innerText = count;
            mobileBadge.style.display = count > 0 ? 'flex' : 'none';
        }
    }
}

function clearCart() {
    localStorage.removeItem('cafe_cart');
    updateCartBadge();
}

function addToCart(id, name, price, image, customizations = null, category_id = null) {
    const user = window.KapeKantoUser || { role: 'guest', isVerified: 0 };
    
    if (user.role === 'guest') {
        showToast('Please login to start ordering! ☕', 'error');
        setTimeout(() => window.location.href = '/login', 1500);
        return;
    }
    
    if (user.role === 'customer' && user.isVerified != 1) {
        showToast('Please verify your email address before ordering.', 'warning');
        return;
    }

    const cart = getCart();
    const existing = cart.find(item =>
        item.id === id &&
        JSON.stringify(item.customizations) === JSON.stringify(customizations)
    );
    if (existing) {
        existing.quantity += 1;
    } else {
        cart.push({ id, name, price, image, quantity: 1, customizations, category_id });
    }
    saveCart(cart);
    showToast(`${name} added to cart!`, 'success');
}

// ─── Logout Helper ─────────────────────────────────────────────────────────
async function logout() {
    showConfirm('Are you sure you want to logout?', async () => {
        try {
            const res = await fetch('/api/auth/logout', { method: 'POST' });
            if (res.ok) window.location.href = '/login';
        } catch (e) {
            showToast('Logout failed.', 'error');
        }
    }, { title: 'Logout', confirmText: 'Logout', cancelText: 'Stay', type: 'info' });
}

// ─── Page Transition ────────────────────────────────────────────────────────
// ─── Form Validation System ────────────────────────────────────────────────
function validateForm(form) {
    const inputs = form.querySelectorAll('input[required], select[required], textarea[required], input[pattern], input[minlength], input[maxlength]');
    let isValid = true;
    let firstInvalid = null;

    // Clear all existing tooltips first
    form.querySelectorAll('.kk-error-tooltip').forEach(t => t.remove());

    inputs.forEach(input => {
        input.classList.remove('is-invalid');
        
        // Use native validation API but custom UI
        if (!input.checkValidity()) {
            isValid = false;
            input.classList.add('is-invalid');
            
            if (!firstInvalid) {
                firstInvalid = input;
                showValidationError(input);
            }
            
            // Auto-clear on input
            input.addEventListener('input', function handler() {
                this.classList.remove('is-invalid');
                removeValidationError(this);
                this.removeEventListener('input', handler);
            });
        }
    });

    if (!isValid && firstInvalid) {
        firstInvalid.focus();
        // Fallback toast if for some reason tooltip isn't enough
        showToast('Please check the highlighted fields.', 'error', 3000);
    }

    return isValid;
}

function showValidationError(input) {
    removeValidationError(input); // Clean up
    
    const message = input.getAttribute('data-error') || input.validationMessage || 'This field is required';
    
    const tooltip = document.createElement('div');
    tooltip.className = 'kk-error-tooltip';
    tooltip.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> ${message}`;
    
    // Ensure parent is relative for positioning
    const parent = input.parentElement;
    parent.style.position = 'relative';
    parent.appendChild(tooltip);
    
    input.dataset.hasTooltip = 'true';
}

function removeValidationError(input) {
    const parent = input.parentElement;
    parent.querySelectorAll('.kk-error-tooltip').forEach(t => t.remove());
    delete input.dataset.hasTooltip;
}

document.addEventListener('DOMContentLoaded', () => {
    // Fade-in on page load
    document.body.classList.add('page-loaded');

    updateCartBadge();

    // Mobile hamburger navigation
    const navToggle = document.querySelector('.nav-toggle');
    const navLinks = document.getElementById('primary-navigation');
    const closeMobileNav = () => {
        document.body.classList.remove('nav-open');
        navToggle?.setAttribute('aria-expanded', 'false');
    };

    if (navToggle && navLinks) {
        navToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = document.body.classList.toggle('nav-open');
            navToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        });

        navLinks.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', closeMobileNav);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeMobileNav();
        });

        document.addEventListener('click', (e) => {
            if (!document.body.classList.contains('nav-open')) return;
            if (navLinks.contains(e.target) || navToggle.contains(e.target)) return;
            closeMobileNav();
        });

        window.addEventListener('resize', () => {
            if (window.innerWidth > 1024) closeMobileNav();
        });
    }

    // Disable default browser validation globally and use custom logic
    document.querySelectorAll('form').forEach(form => {
        form.setAttribute('novalidate', true);
    });

    // Global Form Validation Interceptor
    document.addEventListener('submit', (e) => {
        const form = e.target;
        if (form.tagName === 'FORM') {
            if (!validateForm(form)) {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        }
    }, true);

    // Intercept nav links for smooth page transitions
    document.querySelectorAll('a[href]:not([href^="#"]):not([href^="javascript"]):not([onclick])').forEach(link => {
        const href = link.getAttribute('href');
        if (!href || href.startsWith('http') || href.startsWith('mailto') || href.startsWith('tel')) return;
        link.addEventListener('click', (e) => {
            // Allow if modifier keys pressed
            if (e.ctrlKey || e.metaKey || e.shiftKey) return;
            e.preventDefault();
            document.body.classList.add('page-exit');
            setTimeout(() => { window.location.href = href; }, 280);
        });
    });

    // Profile Dropdown Toggle Logic
    // Support for multiple dropdowns (e.g. mobile/desktop)
    document.querySelectorAll('.nav-profile-dropdown').forEach(container => {
        const btn = container.querySelector('.nav-avatar-btn');
        const content = container.querySelector('.dropdown-content');
        if (btn && content) {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Close others
                document.querySelectorAll('.dropdown-content.show').forEach(d => {
                    if (d !== content) d.classList.remove('show');
                });
                content.classList.toggle('show');
            });
        }
    });

    document.addEventListener('click', (e) => {
        document.querySelectorAll('.dropdown-content.show').forEach(d => {
            if (!d.contains(e.target)) {
                d.classList.remove('show');
            }
        });
    });
});

// ─── Global namespace ──────────────────────────────────────────────────────
window.KapeKanto = {
    toast: showToast,
    confirm: showConfirm,
    alert: showAlert,
    validate: validateForm,
    updateCartBadge,
    getCart,
    saveCart,
    clearCart,
    logout
};
