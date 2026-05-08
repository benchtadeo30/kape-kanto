function calculateFrontend(subtotal, isSeniorOrPWD, promoPercent = 0) {
    const vatExemptSales = subtotal / 1.12;
    let scDiscount = 0;
    if (isSeniorOrPWD) {
        scDiscount = vatExemptSales * 0.20;
    }

    let promoDiscount = 0;
    let applicableNet = vatExemptSales;
    if (isSeniorOrPWD) {
        applicableNet = applicableNet * 0.8;
    }
    promoDiscount = applicableNet * (promoPercent / 100);

    let finalVatAmount = 0;
    if (isSeniorOrPWD) {
        finalVatAmount = 0;
    } else {
        finalVatAmount = (vatExemptSales - promoDiscount) * 0.12;
    }

    const total = (vatExemptSales - scDiscount - promoDiscount) + finalVatAmount;
    return { total, scDiscount, promoDiscount, finalVatAmount };
}

function calculateBackend(subtotal, isSeniorOrPWD, promoPercent = 0) {
    let vat_exempt_sales = subtotal / 1.12;
    let sc_discount = 0;
    let vat_amount = 0;

    if (isSeniorOrPWD) {
        sc_discount = vat_exempt_sales * 0.20;
        vat_amount = 0;
    } else {
        vat_amount = vat_exempt_sales * 0.12;
    }

    let applicableNet = vat_exempt_sales;
    if (isSeniorOrPWD) {
        applicableNet = applicableNet * 0.8;
    }
    let promo_discount_amount = applicableNet * (promoPercent / 100);

    let final_vat_amount = vat_amount;
    if (!isSeniorOrPWD) {
        final_vat_amount = (vat_exempt_sales - promo_discount_amount) * 0.12;
    }

    const total = (vat_exempt_sales - sc_discount - promo_discount_amount) + final_vat_amount;
    return { total, sc_discount, promo_discount_amount, final_vat_amount };
}

// Test cases
const cases = [
    { subtotal: 110, isSC: true, promo: 0 },
    { subtotal: 110, isSC: false, promo: 0 },
    { subtotal: 500, isSC: true, promo: 10 },
    { subtotal: 500, isSC: false, promo: 10 },
];

console.log("Running calculation parity check...");
cases.forEach((c, i) => {
    const f = calculateFrontend(c.subtotal, c.isSC, c.promo);
    const b = calculateBackend(c.subtotal, c.isSC, c.promo);
    
    console.log(`Case ${i+1}: Subtotal=${c.subtotal}, SC=${c.isSC}, Promo=${c.promo}%`);
    console.log(`  Frontend Total: ${f.total.toFixed(4)}`);
    console.log(`  Backend Total:  ${b.total.toFixed(4)}`);
    if (Math.abs(f.total - b.total) < 0.0001) {
        console.log("  ✅ MATCH");
    } else {
        console.log("  ❌ MISMATCH");
    }
});
