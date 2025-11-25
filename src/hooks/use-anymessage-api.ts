type AnyMessageResponse = Record<string, any>;

async function safeFetch(path: string) {
    const res = await fetch(path);
    const text = await res.text();
    try {
        return JSON.parse(text) as AnyMessageResponse;
    } catch (e) {
        return text as any;
    }
}

export async function getBalance(/* token is handled by proxy */) {
    return safeFetch(`/api/user/balance`);
}

export async function getEmailQuantity(site: string) {
    return safeFetch(`/api/email/quantity?site=${encodeURIComponent(site)}`);
}

export async function orderEmail(site: string, domain?: string, regex?: string, subject?: string) {
    const params = new URLSearchParams({ site });
    if (domain) params.set("domain", domain);
    if (regex) params.set("regex", regex);
    if (subject) params.set("subject", subject);
    return safeFetch(`/api/email/order?${params.toString()}`);
}

export async function getMessage(id: string, preview = false) {
    const params = new URLSearchParams({ id });
    if (preview) params.set("preview", "1");
    return safeFetch(`/api/email/getmessage?${params.toString()}`);
}

export async function reorderEmailById(id: string) {
    return safeFetch(`/api/email/reorder?id=${encodeURIComponent(id)}`);
}

export async function reorderEmailByEmail(email: string, site: string) {
    return safeFetch(`/api/email/reorder?email=${encodeURIComponent(email)}&site=${encodeURIComponent(site)}`);
}

export async function cancelEmail(id: string) {
    return safeFetch(`/api/email/cancel?id=${encodeURIComponent(id)}`);
}

export default {
    getBalance,
    getEmailQuantity,
    orderEmail,
    getMessage,
    reorderEmailById,
    reorderEmailByEmail,
    cancelEmail,
};
