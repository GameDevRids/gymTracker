// What an older version of GymPulse kept only in one browser, sorted into what can be moved to
// the database ("Move my saved data to the cloud"). No DOM or browser-state imports, so the
// rules are tested in Node.
import { DEFAULT_REMINDER_TEMPLATES } from "./reminderMessage.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LANGUAGES = ["en", "hi", "mr"];
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Only preferences that differ from the defaults; the server fills only ones the gym has not chosen.
function savedPreferences(gym, legacyLanguage) {
    const preferences = {};
    if (gym.dateFormat === "DD/MM/YYYY") preferences.date_format = "DD/MM/YYYY";
    if (["hi", "mr"].includes(legacyLanguage)) preferences.language = legacyLanguage;
    const chosen = isObject(gym.preferences) ? gym.preferences : {};
    if (Number.isInteger(chosen.expiryReminderDays) && chosen.expiryReminderDays >= 0 && chosen.expiryReminderDays <= 90 && chosen.expiryReminderDays !== 7) {
        preferences.expiry_reminder_days = chosen.expiryReminderDays;
    }
    if (chosen.paymentReminders === false) preferences.payment_reminders = false;
    if (chosen.inactivityReminders === false) preferences.inactivity_reminders = false;
    return preferences;
}

// "Reminded" marks were saved as { "<membership id>:<end date>": "<time>" }.
function savedReminders(saved) {
    const marks = isObject(saved.expiryReminders) ? saved.expiryReminders : {};
    return Object.entries(marks).map(([key, sentAt]) => {
        const separator = key.lastIndexOf(":");
        const membershipId = key.slice(0, separator);
        const endDate = key.slice(separator + 1);
        const time = Date.parse(sentAt);
        return UUID.test(membershipId) && ISO_DATE.test(endDate) && Number.isFinite(time)
            ? { membership_id: membershipId, end_date: endDate, sent_at: new Date(time).toISOString() }
            : null;
    }).filter(Boolean);
}

// Members, payments and renewals from a version before the database: their ids are not the
// database's, so they cannot be matched to members. They are offered as a CSV download instead.
function oldRecords(saved) {
    const members = (Array.isArray(saved.members) ? saved.members : []).filter((member) => isObject(member) && !member.memberCode && !UUID.test(String(member.id || "")));
    const names = new Map(members.map((member) => [member.id, member.name]));
    const payments = (Array.isArray(saved.payments) ? saved.payments : []).filter((payment) => isObject(payment) && !UUID.test(String(payment.id || "")));
    return [
        ...members.map((member) => ({ record: "member", id: member.id, name: member.name || "", phone: member.phone || "", date: member.joinedAt || "", amount: member.totalFees ?? "", details: [member.startDate, member.expiryDate].filter(Boolean).join(" to ") })),
        ...payments.map((payment) => ({ record: "payment", id: payment.id, name: names.get(payment.memberId) || "", phone: "", date: payment.date || "", amount: payment.amount ?? "", details: [payment.method, payment.notes].filter(Boolean).join(" · ") })),
        ...members.flatMap((member) => (Array.isArray(member.renewals) ? member.renewals : []).map((renewal) => ({ record: "renewal", id: member.id, name: member.name || "", phone: "", date: renewal.date || "", amount: renewal.amount ?? "", details: [renewal.startDate, renewal.expiryDate].filter(Boolean).join(" to ") })))
    ];
}

/**
 * Sorts a saved browser workspace (never sample data) into what can be moved.
 * Copies of database members are not listed: the database already has them.
 */
export function collectLocalData(saved, { legacyLanguage = "" } = {}) {
    if (!isObject(saved)) return null;
    const gym = isObject(saved.gym) ? saved.gym : {};
    const reminderBody = typeof saved.whatsapp?.expiryReminderTemplate === "string" ? saved.whatsapp.expiryReminderTemplate.trim() : "";
    const checkIns = (Array.isArray(saved.attendance) ? saved.attendance : [])
        .filter((record) => isObject(record) && UUID.test(String(record.memberId || "")) && Number.isFinite(Date.parse(record.checkedInAt))).length;
    const data = {
        preferences: savedPreferences(gym, legacyLanguage),
        reminderTemplate: reminderBody && reminderBody !== DEFAULT_REMINDER_TEMPLATES.en
            ? { language: LANGUAGES.includes(legacyLanguage) ? legacyLanguage : "en", body: reminderBody }
            : null,
        reminders: savedReminders(saved),
        checkIns,
        contact: {
            phone: typeof gym.phone === "string" ? gym.phone.trim() : "",
            address: typeof gym.address === "string" ? gym.address.trim() : ""
        },
        oldRecords: oldRecords(saved)
    };
    data.any = Boolean(Object.keys(data.preferences).length || data.reminderTemplate || data.reminders.length
        || data.checkIns || data.contact.phone || data.contact.address || data.oldRecords.length);
    return data;
}
