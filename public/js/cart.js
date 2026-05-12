let activePromo = null;
let addressSearchTimer = null;

document.addEventListener('DOMContentLoaded', () => {
    renderCartItems();

    // ── Flatpickr Unified Date/Time Picker ─────────────────────────────────
    const now = new Date();
    const minLeadTime = new Date(now.getTime() + 30 * 60000); // 30 mins from now

    const fp = flatpickr('#scheduled-datetime', {
        enableTime: true,
        dateFormat: 'Y-m-d H:i',
        minDate: 'today',
        minuteIncrement: 15,
        minTime: "08:00",
        maxTime: "22:00",
        defaultDate: minLeadTime,
        disableMobile: true,
        onReady: (selectedDates, dateStr, instance) => {
            updatePickerLimits(instance);
        },
        onChange: (selectedDates, dateStr, instance) => {
            updatePickerLimits(instance);
            updateTotals();
        }
    });

    function updatePickerLimits(instance) {
        const selectedDate = instance.selectedDates[0];
        const today = new Date();

        if (selectedDate && selectedDate.toDateString() === today.toDateString()) {
            const lead = new Date(new Date().getTime() + 30 * 60000);
            let h = lead.getHours();
            let m = Math.ceil(lead.getMinutes() / 15) * 15;
            if (m >= 60) { h++; m = 0; }
            const finalH = Math.max(8, h);
            const minTimeStr = `${String(finalH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            instance.set('minTime', minTimeStr);
        } else {
            instance.set('minTime', "08:00");
        }
    }

    // Listeners
    syncCartPrices().then(() => {
        toggleDeliveryFields();
        updateScheduleUI();
        updateCheckoutUI();
        checkHotWarning();
    });
});

/**
 * Syncs cart item prices with the server to ensure they are up to date.
 */
async function syncCartPrices() {
    const cart = getCart();
    if (cart.length === 0) return;

    try {
        const res = await fetch('/api/menu');
        if (res.ok) {
            const menuItems = await res.json();
            let changed = false;

            for (let cartItem of cart) {
                const dbItem = menuItems.find(mi => mi.id === cartItem.id);
                if (dbItem) {
                    let syncedPrice = Number(dbItem.price) || 0;
                    const customizations = cartItem.customizations || {};

                    if (Object.keys(customizations).length > 0) {
                        try {
                            const optionsRes = await fetch(`/api/menu/${cartItem.id}/options`);
                            if (optionsRes.ok) {
                                const options = await optionsRes.json();
                                Object.entries(customizations).forEach(([optionName, choiceName]) => {
                                    const option = options.find(opt => String(opt.name).toLowerCase() === String(optionName).toLowerCase());
                                    const choice = option?.choices?.find(ch => String(ch.name).toLowerCase() === String(choiceName).toLowerCase());
                                    syncedPrice += Number(choice?.price_adjustment || 0);
                                });
                            }
                        } catch (e) {
                            console.error(`Option price sync failed for item ${cartItem.id}`, e);
                        }
                    }

                    if (Number(cartItem.price) !== syncedPrice) {
                        cartItem.price = syncedPrice;
                        changed = true;
                    }

                    if (cartItem.name !== dbItem.name) {
                        cartItem.name = dbItem.name;
                        changed = true;
                    }

                    if (cartItem.category_id !== dbItem.category_id) {
                        cartItem.category_id = dbItem.category_id;
                        changed = true;
                    }
                }
            }

            if (changed) {
                saveCart(cart);
                renderCartItems();
            }
        }
    } catch (e) { console.error('Price sync failed', e); }
}

// ── Render Cart Items ────────────────────────────────────────
function renderCartItems() {
    const cart = getCart();
    const container = document.getElementById('cart-items-container');
    const checkoutBtn = document.getElementById('checkout-btn');

    if (cart.length === 0) {
        container.innerHTML = `
            <div style="text-align:center;padding:3rem;color:var(--text-light);">
                <i class="fa-solid fa-cart-shopping" style="font-size:2.5rem;opacity:0.3;display:block;margin-bottom:1rem;"></i>
                <p>Your cart is empty.</p>
                <a href="/menu" class="btn btn-primary" style="margin-top:1rem;">Browse Menu</a>
            </div>`;
        if (checkoutBtn) checkoutBtn.disabled = true;
        updateTotals();
        return;
    }

    if (checkoutBtn) checkoutBtn.disabled = false;
    let html = '';

    cart.forEach((item, index) => {
        let customizationHtml = '';
        if (item.customizations) {
            const keys = Object.keys(item.customizations);
            if (keys.length > 0) {
                customizationHtml = '<div style="font-size:0.8rem;color:var(--text-light);margin-top:5px;">';
                keys.forEach(k => {
                    customizationHtml += `<span style="background:#f5f0eb;padding:2px 8px;border-radius:20px;margin-right:4px;">${k}: <strong>${item.customizations[k]}</strong></span>`;
                });
                customizationHtml += '</div>';
            }
        }

        html += `
            <div style="display:flex;align-items:center;gap:1rem;padding:1.25rem 0;border-bottom:1px solid #f0ebe3;">
                <img src="${item.image}" alt="${item.name}"
                    style="width:80px;height:80px;object-fit:cover;border-radius:14px;box-shadow:var(--shadow-soft);"
                    onerror="this.src='https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&q=80&w=200'">
                <div style="flex:1;min-width:0;">
                    <h4 style="margin:0;font-size:1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${item.name}</h4>
                    <p style="margin:3px 0;color:var(--primary);font-weight:700;">₱${item.price.toFixed(2)}</p>
                    ${customizationHtml}
                </div>
                <div style="display:flex;align-items:center;background:#f5f5f5;border-radius:50px;padding:4px 10px;gap:0.75rem;">
                    <button class="btn" style="padding:3px 10px;background:transparent;" onclick="updateQuantityByIndex(${index},-1)">−</button>
                    <span style="font-weight:700;min-width:18px;text-align:center;">${item.quantity}</span>
                    <button class="btn" style="padding:3px 10px;background:transparent;" onclick="updateQuantityByIndex(${index},1)">+</button>
                </div>
                <button onclick="removeItemByIndex(${index})" style="background:transparent;border:none;color:var(--danger);cursor:pointer;padding:6px;font-size:1.1rem;">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>`;
    });

    container.innerHTML = html;
    updateTotals();
    checkHotWarning();
}

function updateQuantityByIndex(index, change) {
    const cart = getCart();
    if (cart[index]) {
        cart[index].quantity += change;
        if (cart[index].quantity <= 0) cart.splice(index, 1);
        saveCart(cart);
        renderCartItems();
    }
}

function removeItemByIndex(index) {
    const cart = getCart();
    cart.splice(index, 1);
    saveCart(cart);
    renderCartItems();
}

// ── Delivery / Pickup Toggle ─────────────────────────────────
function setOrderType(type) {
    document.getElementById('order-type').value = type;
    document.querySelectorAll('.cart-tab-btn[data-group="order"]').forEach(btn => {
        if (btn.dataset.type === type) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    toggleDeliveryFields();
}

// ── Payment Method Toggle ────────────────────────────────────
function setPaymentMethod(type) {
    document.getElementById('payment-method').value = type;
    document.querySelectorAll('.cart-tab-btn[data-group="payment"]').forEach(btn => {
        if (btn.dataset.type === type) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    updateCheckoutUI();
}

function toggleDeliveryFields() {
    const type = document.getElementById('order-type').value;
    const fields = document.getElementById('delivery-fields');
    const addressInput = document.getElementById('delivery-address');

    if (type === 'delivery') {
        fields.style.display = 'block';
        if (addressInput) addressInput.required = true;
    } else {
        fields.style.display = 'none';
        if (addressInput) addressInput.required = false;
    }

    updateTotals();
    updateScheduleUI();
    updateCheckoutUI();
    checkHotWarning();
}

// ── Schedule Mode Toggle ─────────────────────────────────────
function setScheduleMode(mode) {
    document.getElementById('schedule-mode').value = mode;
    document.querySelectorAll('.cart-tab-btn[data-group="schedule"]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === mode);
    });
    updateScheduleUI();
}

function updateScheduleUI() {
    const mode = document.getElementById('schedule-mode').value;
    const orderType = document.getElementById('order-type').value;
    const asapBadge = document.getElementById('asap-badge');
    const pickerWrap = document.getElementById('scheduled-picker-wrap');
    const asapLabel = document.getElementById('asap-label');
    const heading = document.getElementById('schedule-heading');

    if (orderType === 'pickup') {
        heading.textContent = 'When should we have it ready?';
    } else {
        heading.textContent = 'When should it arrive?';
    }

    if (mode === 'asap') {
        asapBadge.style.display = 'flex';
        pickerWrap.style.display = 'none';
        if (orderType === 'delivery') {
            asapLabel.textContent = 'Delivered in ~45 minutes';
        } else {
            asapLabel.textContent = 'Ready in ~20 minutes';
        }
    } else {
        asapBadge.style.display = 'none';
        pickerWrap.style.display = 'block';
    }
}

function updateCheckoutUI() {
    const btn = document.getElementById('checkout-btn');
    const note = document.getElementById('checkout-note');
    const desc = document.getElementById('payment-method-desc');
    const physicalLabel = document.getElementById('payment-physical-label');

    const orderType = document.getElementById('order-type').value;
    const paymentMethod = document.getElementById('payment-method').value;

    // Update Payment Labels based on Order Type
    if (orderType === 'pickup') {
        physicalLabel.innerText = 'Pay at Store';
        if (paymentMethod === 'physical') {
            desc.innerText = 'You will pay at the counter when you pick up your order.';
            note.innerText = 'No online payment required now.';
            btn.innerHTML = '<i class="fa-solid fa-store"></i> Place Order & Pickup';
        } else {
            desc.innerText = 'Securely pay online via PayRex (Credit/Debit/Gcash).';
            note.innerText = 'You will be redirected to the payment gateway.';
            btn.innerHTML = '<i class="fa-solid fa-globe"></i> Pay & Pickup';
        }
    } else {
        physicalLabel.innerText = 'Cash on Delivery';
        if (paymentMethod === 'physical') {
            desc.innerText = 'Pay with cash once your rider arrives at your doorstep.';
            note.innerText = 'Please prepare exact change if possible.';
            btn.innerHTML = '<i class="fa-solid fa-motorcycle"></i> Place Delivery Order';
        } else {
            desc.innerText = 'Securely pay online via PayRex (Credit/Debit/Gcash).';
            note.innerText = 'You will be redirected to the payment gateway.';
            btn.innerHTML = '<i class="fa-solid fa-globe"></i> Pay & Order Delivery';
        }
    }
}

// ── Philippines Address Search ───────────────────────────────
function handleAddressInput(val) {
    clearTimeout(addressSearchTimer);
    const suggestions = document.getElementById('address-suggestions');

    if (!val || val.length < 3) {
        suggestions.classList.remove('open');
        suggestions.innerHTML = '';
        return;
    }

    suggestions.innerHTML = '<div class="suggestion-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Searching…</div>';
    suggestions.classList.add('open');

    addressSearchTimer = setTimeout(() => searchAddress(val), 500);
}

async function searchAddress(query) {
    const suggestions = document.getElementById('address-suggestions');
    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=ph&limit=6&addressdetails=1`;
        const res = await fetch(url, {
            headers: { 'Accept-Language': 'en', 'User-Agent': 'KapeKantoHub/1.0' }
        });
        const results = await res.json();

        if (!results.length) {
            suggestions.innerHTML = '<div class="suggestion-loading">No results found in Philippines.</div>';
            return;
        }

        suggestions.innerHTML = results.map(r => `
            <div class="suggestion-item" onclick="selectAddress('${r.display_name.replace(/'/g, "\\'")}')">
                <i class="fa-solid fa-location-dot"></i>
                <span>${r.display_name}</span>
            </div>`).join('');
    } catch (e) {
        suggestions.innerHTML = '<div class="suggestion-loading">Search failed. Please type your address manually.</div>';
    }
}

function selectAddress(addr) {
    const input = document.getElementById('delivery-address');
    if (input) input.value = addr;
    const suggestions = document.getElementById('address-suggestions');
    if (suggestions) {
        suggestions.classList.remove('open');
        suggestions.innerHTML = '';
    }
}

async function detectMyLocation() {
    const btn = document.getElementById('detect-btn');
    if (!navigator.geolocation) {
        showToast('Geolocation is not supported by your browser.', 'error');
        return;
    }

    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Detecting…';
    btn.disabled = true;

    navigator.geolocation.getCurrentPosition(async (pos) => {
        try {
            const { latitude, longitude } = pos.coords;
            const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&countrycodes=ph`;
            const res = await fetch(url, {
                headers: { 'Accept-Language': 'en', 'User-Agent': 'KapeKantoHub/1.0' }
            });
            const data = await res.json();

            if (data && data.display_name) {
                document.getElementById('delivery-address').value = data.display_name;
                showToast('Location detected!', 'success');
            } else {
                showToast('Could not get your full address. Please type manually.', 'warning');
            }
        } catch (e) {
            showToast('Location detection failed.', 'error');
        } finally {
            btn.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i> Use My Current Location';
            btn.disabled = false;
        }
    }, () => {
        showToast('Location access denied. Please type your address.', 'warning');
        btn.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i> Use My Current Location';
        btn.disabled = false;
    });
}

// Close suggestions when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.address-input-wrap')) {
        document.getElementById('address-suggestions')?.classList.remove('open');
    }
});

async function applyPromo() {
    const codeInput = document.getElementById('promo-code');
    const code = codeInput.value.trim();
    const btn = document.getElementById('promo-btn');

    if (!code) { showToast('Please enter a promo code.', 'warning'); return; }

    console.log('[PROMO] Sending POST request to validate code:', code);
    try {
        const res = await fetch('/api/promos/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        const data = await res.json();

        if (res.ok) {
            activePromo = data;
            showToast(`Promo applied! ${data.discount_percent}% OFF`, 'success');

            // Show dedicated status and remove button
            const statusDiv = document.getElementById('promo-status');
            const removeBtn = document.getElementById('remove-promo-btn');
            if (statusDiv) {
                statusDiv.innerHTML = `<span style="color:var(--success); font-weight:600;"><i class="fa-solid fa-check-circle"></i> Promo Active: ${data.promo_code} (${data.discount_percent}%)</span>`;
            }
            if (removeBtn) removeBtn.style.display = 'block';
            
            // Disable input
            codeInput.readOnly = true;
            codeInput.style.opacity = '0.7';
            btn.disabled = true;

            updateTotals();
        } else {
            showToast(data.error || 'Invalid promo code.', 'error');
            activePromo = null;
            updateTotals();
        }
    } catch (e) {
        showToast('Error validating promo code.', 'error');
    }
}

function removePromo() {
    activePromo = null;

    const codeInput = document.getElementById('promo-code');
    const btn = document.getElementById('promo-btn');
    const statusDiv = document.getElementById('promo-status');
    const removeBtn = document.getElementById('remove-promo-btn');

    // Restore UI
    codeInput.value = '';
    codeInput.readOnly = false;
    codeInput.style.opacity = '1';
    btn.disabled = false;
    if (statusDiv) statusDiv.innerHTML = '';
    if (removeBtn) removeBtn.style.display = 'none';

    showToast('Promo code removed.', 'info');
    updateTotals();
}

// ── Update Totals ────────────────────────────────────────────
function updateTotals() {
    const cart = getCart();
    let subtotal = 0; 
    cart.forEach(item => { subtotal += item.price * item.quantity; });

    let discountAmount = 0;
    let scDiscount = 0;
    let promoDiscount = 0;
    let discountLabelStr = 'None';
    
    const isSeniorOrPWD = window.userDiscounts && window.userDiscounts.isEligible === 'true';
    const vatExemptSales = subtotal / 1.12;

    // 1. Calculate Senior/PWD Discount (PH Law: VAT-Exempt + 20% off Net)
    if (isSeniorOrPWD) {
        scDiscount = vatExemptSales * 0.20;
        discountLabelStr = `20% ${window.userDiscounts.type.toUpperCase()} (VAT-Exempt)`;
    }

    // 2. Calculate Promo Code Discount
    if (activePromo) {
        let applicableGross = 0;
        let validCats = [];
        let validItems = [];

        const getArray = (val) => {
            if (!val) return [];
            if (Array.isArray(val)) return val;
            try { return JSON.parse(val); } catch(e) { return []; }
        };

        validCats = getArray(activePromo.applicable_category_ids);
        if (activePromo.applicable_category_id) validCats.push(activePromo.applicable_category_id);
        validItems = getArray(activePromo.applicable_menu_item_ids);
        if (activePromo.applicable_menu_item_id) validItems.push(activePromo.applicable_menu_item_id);

        validCats = validCats.filter(v => v != null).map(String);
        validItems = validItems.filter(v => v != null).map(String);

        const hasRestrictions = validCats.length > 0 || validItems.length > 0;

        if (!hasRestrictions) {
            applicableGross = subtotal;
        } else {
            cart.forEach(item => {
                const itemCatId = String(item.category_id || item.categoryId || '');
                const itemId = String(item.id);
                if (validItems.includes(itemId) || validCats.includes(itemCatId)) {
                    applicableGross += item.price * item.quantity;
                }
            });
        }

        // Apply promo on the net amount (VAT-exempted)
        let applicableNet = applicableGross / 1.12;
        if (isSeniorOrPWD) {
            applicableNet = applicableNet * 0.8; // Apply on the amount after 20% SC discount
        }
        
        if (activePromo.discount_percent > 0) {
            promoDiscount = applicableNet * (activePromo.discount_percent / 100);
        } else if (activePromo.discount_amount > 0) {
            promoDiscount = Math.min(activePromo.discount_amount, applicableNet);
        }

        if (promoDiscount > 0) {
            if (isSeniorOrPWD) {
                const label = activePromo.discount_percent > 0 ? `${activePromo.discount_percent}%` : `₱${activePromo.discount_amount}`;
                discountLabelStr += ` + ${label} Promo`;
            } else {
                const label = activePromo.discount_percent > 0 ? `${activePromo.discount_percent}%` : `₱${activePromo.discount_amount}`;
                discountLabelStr = `🏷️ Promo (${label} off)`;
            }
        } else if ((activePromo.discount_percent > 0 || activePromo.discount_amount > 0) && applicableGross === 0 && hasRestrictions) {
            showToast('This promo code is not applicable to items in your cart.', 'warning');
        }
    }

    discountAmount = scDiscount + promoDiscount;

    // 3. Final Calculations
    let finalVatAmount = 0;
    let vatRemovedAmount = 0; // The 12% VAT that was removed for SC/PWD
    let displayDiscountAmount = discountAmount;
    
    if (isSeniorOrPWD) {
        finalVatAmount = 0; 
        vatRemovedAmount = subtotal - vatExemptSales;
        displayDiscountAmount = discountAmount + vatRemovedAmount;
    } else {
        finalVatAmount = (vatExemptSales - promoDiscount) * 0.12;
        // Subtotal is VAT-inclusive, so a promo applied to net sales also reduces the VAT portion.
        displayDiscountAmount = promoDiscount * 1.12;
    }

    const orderType = document.getElementById('order-type').value;
    const deliveryFee = orderType === 'delivery' ? 50 : 0;
    
    const total = Math.round(((vatExemptSales - scDiscount - promoDiscount) + finalVatAmount + deliveryFee) * 100) / 100;
    const taxFees = deliveryFee;

    // 4. Update UI
    const setVal = (id, val, isDeduction = false) => {
        const el = document.getElementById(id);
        if (el) el.innerText = `${isDeduction ? '-' : ''}₱${val.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    };

    setVal('summary-subtotal', subtotal);
    
    // Transparent Discount Breakdown
    const discountContainer = document.getElementById('summary-discount');
    if (isSeniorOrPWD) {
        let scHtml = `
            <div style="font-size: 0.85rem; color: var(--text-light); margin-top: 4px;">
                <div style="display:flex; justify-content:space-between;">
                    <span>VAT-Exempt Discount (12%):</span>
                    <span>-₱${vatRemovedAmount.toFixed(2)}</span>
                </div>
                <div style="display:flex; justify-content:space-between;">
                    <span>${window.userDiscounts.type} Disc (20%):</span>
                    <span>-₱${scDiscount.toFixed(2)}</span>
                </div>
            </div>
        `;
        if (promoDiscount > 0) {
            scHtml += `
                <div style="display:flex; justify-content:space-between;">
                    <span>Promo Discount:</span>
                    <span>-₱${promoDiscount.toFixed(2)}</span>
                </div>
            `;
        }
        discountContainer.innerHTML = scHtml;
        document.getElementById('summary-discount-total').innerText = `-₱${(discountAmount + vatRemovedAmount).toFixed(2)}`;
    } else {
        setVal('summary-discount-total', displayDiscountAmount, true);
        if (promoDiscount > 0) {
            const vatPromoReduction = displayDiscountAmount - promoDiscount;
            discountContainer.innerHTML = `
                <div style="font-size: 0.85rem; color: var(--text-light); margin-top: 4px;">
                    <div style="display:flex; justify-content:space-between;">
                        <span>Promo Discount:</span>
                        <span>-PHP ${promoDiscount.toFixed(2)}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between;">
                        <span>VAT Reduction from Promo:</span>
                        <span>-PHP ${vatPromoReduction.toFixed(2)}</span>
                    </div>
                </div>
            `;
        } else {
            discountContainer.innerHTML = '';
        }
    }

    setVal('summary-vat', finalVatAmount);
    setVal('summary-delivery', deliveryFee);
    setVal('summary-tax-fees', taxFees);
    setVal('summary-total', total);
    
    const dLabel = document.getElementById('discount-label');
    if (dLabel) dLabel.innerText = discountLabelStr;

    const vLabel = document.getElementById('vat-label');
    const vRow = document.getElementById('vat-row');
    const tfRow = document.getElementById('tax-fees-row');
    
    if (vRow) {
        // Only show VAT row for Senior/PWD (as a deduction)
        if (isSeniorOrPWD) {
            vRow.style.display = 'flex';
            if (vLabel) vLabel.innerText = 'VAT (Exempt):';
        } else {
            vRow.style.display = 'none';
        }
    }

    if (tfRow) {
        tfRow.style.display = 'none';
    }
}

// ── Place Order ──────────────────────────────────────────────
async function placeOrder() {
    const cart = getCart();
    if (cart.length === 0) return;

    const btn = document.getElementById('checkout-btn');
    const orderType = document.getElementById('order-type').value;
    const paymentMethod = document.getElementById('payment-method').value;
    const scheduleMode = document.getElementById('schedule-mode').value;
    const address = document.getElementById('delivery-address')?.value || '';
    const datetimeInput = document.getElementById('scheduled-datetime');
    const notes = document.getElementById('notes').value;

    if (orderType === 'delivery' && !address.trim()) {
        showToast('Please enter a delivery address.', 'error');
        document.getElementById('delivery-address').focus();
        return;
    }

    let date = null;
    let time = null;

    if (scheduleMode === 'scheduled') {
        const datetimeVal = datetimeInput._flatpickr ? datetimeInput._flatpickr.input.value : datetimeInput.value;
        if (!datetimeVal || !datetimeVal.includes(' ')) {
            showToast('Please select a valid scheduled date and time.', 'error');
            return;
        }
        [date, time] = datetimeVal.split(' ');
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Processing…';

    const orderData = {
        items: cart.map(item => ({
            id: item.id,
            quantity: item.quantity,
            name: item.name,
            customizations: item.customizations
        })),
        order_type: orderType,
        delivery_address: address || null,
        schedule_mode: scheduleMode,
        scheduled_date: date,
        scheduled_time: time,
        notes: notes,
        promo_code: activePromo ? activePromo.promo_code : null,
        payment_method: paymentMethod === 'online' ? 'payrex' : (orderType === 'delivery' ? 'cod' : 'pay_at_store')
    };

    try {
        const res = await fetch('/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderData)
        });

        const data = await res.json();

        if (res.ok) {
            if (data.checkoutUrl) {
                window.location.href = data.checkoutUrl;
            } else {
                clearCart();
                showToast('Order placed successfully! 🎉', 'success');
                setTimeout(() => window.location.href = '/order-tracking', 1200);
            }
        } else {
            showToast(data.error || 'Failed to place order.', 'error');
            btn.disabled = false;
            updateCheckoutUI();
        }
    } catch (e) {
        showToast('An error occurred. Please try again.', 'error');
        btn.disabled = false;
        updateCheckoutUI();
    }
}
