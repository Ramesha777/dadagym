/**
 * Shared rendering helper: paints membership plan cards
 * (the `.ms-card` design) into any grid element.
 *
 * Used by both `membership.js` (full plans page) and
 * `index-plans.js` (homepage plans section).
 */
import { PLANS, YEARLY_MONTHS } from './plans.js';

function hexToRgba(hex, alpha) {
    var h = (hex || '#FF6B35').replace('#', '');
    if (h.length === 3) h = h.split('').map(function(c) { return c + c; }).join('');
    var n = parseInt(h, 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

/**
 * @param {HTMLElement}        grid    Container to render into.
 * @param {'monthly'|'yearly'} period  Billing period.
 */
export function renderPlanCards(grid, period) {
    if (!grid) return;
    grid.innerHTML = '';

    Object.values(PLANS).forEach(function(plan) {
        var amount = period === 'yearly'
            ? plan.priceMonthly * YEARLY_MONTHS
            : plan.priceMonthly;
        var periodLabel = period === 'yearly' ? '/year' : '/month';
        var sym = plan.currencySymbol;
        var save = period === 'yearly'
            ? '<div class="ms-yearly-save"><i class="fas fa-circle-check"></i> Save ' +
                  sym + (plan.priceMonthly * 2) + ' vs monthly</div>'
            : '';

        var featuresHtml = plan.features.map(function(f) {
            return '<li><i class="fas fa-check"></i><span>' + f + '</span></li>';
        }).join('');

        var card = document.createElement('article');
        card.className = 'ms-card' + (plan.featured ? ' featured' : '');
        card.style.setProperty('--ms-glow', hexToRgba(plan.accent, 0.18));
        card.style.setProperty('--ms-glow-strong', plan.accent);
        card.innerHTML =
            '<span class="ms-card-badge">' + plan.badge + '</span>' +
            '<div class="ms-card-icon"><i class="fas ' + plan.icon + '"></i></div>' +
            '<div>' +
                '<h3>' + plan.name + '</h3>' +
                '<p class="ms-tagline">' + plan.tagline + '</p>' +
            '</div>' +
            '<div class="ms-price">' +
                '<span class="ms-price-amount">' + sym + amount + '</span>' +
                '<span class="ms-price-period">' + periodLabel + '</span>' +
            '</div>' +
            save +
            '<ul class="ms-features">' + featuresHtml + '</ul>' +
            '<a href="payment.html?plan=' + encodeURIComponent(plan.id) +
                '&period=' + period + '" ' +
                'class="btn ' + (plan.featured ? '' : 'btn-outline') + ' btn-full">' +
                'Choose ' + plan.name +
            '</a>' +
            '<code class="ms-plan-id" title="Unique plan identifier">ID: ' + plan.id + '</code>';

        grid.appendChild(card);
    });
}

/**
 * Wires up a group of `.ms-billing-btn` toggles so that clicking one
 * activates it and invokes the supplied callback with the new period.
 *
 * @param {NodeList|HTMLElement[]} buttons
 * @param {(period: 'monthly'|'yearly') => void} onChange
 * @param {'monthly'|'yearly'} initialPeriod
 */
export function setupBillingToggle(buttons, onChange, initialPeriod) {
    var initial = initialPeriod === 'yearly' ? 'yearly' : 'monthly';

    function activate(btn) {
        Array.prototype.forEach.call(buttons, function(b) {
            b.classList.remove('active');
            b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
    }

    Array.prototype.forEach.call(buttons, function(btn) {
        if (btn.dataset.period === initial) activate(btn);
        btn.addEventListener('click', function() {
            activate(btn);
            onChange(btn.dataset.period);
        });
    });
}
