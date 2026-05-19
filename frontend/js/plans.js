/**
 * Shared membership plan catalogue.
 * Each plan has a globally unique id used as the lookup key in URLs
 * (e.g. payment.html?plan=plan_premium_49) and for any future
 * persistence in Firestore / payment provider metadata.
 *
 * IDs follow the convention:  plan_<tier>_<monthlyPriceUSD>
 */
export const PLANS = {
    plan_basic_29: {
        id: 'plan_basic_29',
        name: 'Basic',
        badge: 'Starter',
        tagline: 'Perfect to begin your fitness journey',
        priceMonthly: 29,
        currency: 'GBP',
        currencySymbol: '£',
        accent: '#5b8def',
        icon: 'fa-bolt',
        features: [
            '24/7 gym access',
            'Cardio & weight area',
            'Locker room access',
            'Member mobile app',
            'Basic progress tracking'
        ]
    },
    plan_premium_49: {
        id: 'plan_premium_49',
        name: 'Premium',
        badge: 'Most Popular',
        tagline: 'Our most-loved plan with classes & amenities',
        priceMonthly: 49,
        currency: 'GBP',
        currencySymbol: '£',
        accent: '#FF6B35',
        icon: 'fa-fire',
        featured: true,
        features: [
            'Everything in Basic',
            'Unlimited group classes',
            'Sauna & steam room',
            '2 guest passes per month',
            '1 nutrition consultation'
        ]
    },
    plan_vip_99: {
        id: 'plan_vip_99',
        name: 'VIP',
        badge: 'Elite',
        tagline: 'The complete experience with personal coaching',
        priceMonthly: 99,
        currency: 'GBP',
        currencySymbol: '£',
        accent: '#a855f7',
        icon: 'fa-crown',
        features: [
            'Everything in Premium',
            '4 personal-trainer sessions / month',
            'Custom nutrition plan',
            'Priority class booking',
            'Spa & recovery services'
        ]
    }
};

/** Tax rate used for the simulated checkout (purely cosmetic). */
export const TAX_RATE = 0.08;

/** Yearly billing applies a 2-months-free discount (pay 10 × monthly). */
export const YEARLY_MONTHS = 10;

/**
 * Compute the price for a plan given a billing period.
 * @param {object} plan  An entry from PLANS.
 * @param {'monthly'|'yearly'} period
 * @returns {{ subtotal:number, tax:number, total:number, label:string }}
 */
export function priceFor(plan, period) {
    var subtotal = period === 'yearly'
        ? plan.priceMonthly * YEARLY_MONTHS
        : plan.priceMonthly;
    var tax = +(subtotal * TAX_RATE).toFixed(2);
    var total = +(subtotal + tax).toFixed(2);
    return {
        subtotal: subtotal,
        tax: tax,
        total: total,
        label: period === 'yearly' ? 'per year' : 'per month'
    };
}

/** Look up a plan by id, returning null if not found. */
export function getPlan(id) {
    return Object.prototype.hasOwnProperty.call(PLANS, id) ? PLANS[id] : null;
}

/** Generate a fake transaction id for the simulation receipt. */
export function fakeTxnId() {
    var rand = Math.random().toString(36).slice(2, 10).toUpperCase();
    var ts = Date.now().toString(36).toUpperCase();
    return 'SIM-' + ts + '-' + rand;
}
