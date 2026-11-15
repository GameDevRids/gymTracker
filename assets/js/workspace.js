// The app's empty in-memory workspace, and the cleanup of fictional records that older
// versions saved in browsers. GymPulse no longer ships any sample data: the demo gym is a
// real gym in the database, filled by server/scripts/seed-demo.js.

export function createEmptyState() {
    return {
        gym: {
            name: "My Gym", address: "", phone: "",
            currency: "INR", dateFormat: "DD MMM YYYY",
            preferences: { expiryReminderDays: 7, paymentReminders: true, inactivityReminders: true }
        },
        plans: [],
        members: [],
        attendance: [],
        payments: [],
        notifications: [],
        createdAt: new Date().toISOString()
    };
}

// The fixed ids and gym details of the fictional workspace older versions created
// (32 members GP-1001…GP-1032, five plans, and their check-ins and payments).
const LEGACY_MEMBER_COUNT = 32;
const LEGACY_GYM = { name: "Forge Fitness", address: "Koramangala, Bengaluru", phone: "+91 80 4567 8900" };

function legacyDemoIds() {
    const members = new Set();
    const attendance = new Set();
    const payments = new Set();
    for (let index = 0; index < LEGACY_MEMBER_COUNT; index += 1) {
        members.add(`GP-${1001 + index}`);
        if (!(index % 6 === 2 || index % 9 === 4)) {
            const visits = index % 4 === 0 ? 2 : 5 + (index % 7);
            for (let visit = 0; visit < visits; visit += 1) attendance.add(`AT-${index}-${visit}`);
        }
        const entries = index % 8 === 0 ? 2 : 1;
        for (let item = 0; item < entries; item += 1) payments.add(`TX-${10001 + index * 2 + item}`);
    }
    const plans = new Set(["plan-monthly", "plan-quarterly", "plan-half-yearly", "plan-annual", "plan-custom"]);
    return { members, plans, attendance, payments };
}

/**
 * Removes the fictional records that older versions seeded into every new workspace
 * automatically, before the one-time "move my saved data" step. Records the owner created
 * themselves are kept. A workspace that is nothing but loaded sample data is not passed here.
 */
export function removeLegacyDemoData(saved) {
    if (!saved || typeof saved !== "object" || saved.sampleDataLoaded) return { state: saved, changed: false };
    const demoIds = legacyDemoIds();
    const demoMemberIds = demoIds.members;
    const gym = saved.gym && typeof saved.gym === "object" ? saved.gym : {};
    const demoGymFields = Object.keys(LEGACY_GYM).filter((key) => gym[key] === LEGACY_GYM[key]);
    const hasDemoRecords = Object.entries(demoIds).some(([key, ids]) => Array.isArray(saved[key]) && saved[key].some((item) => ids.has(item?.id)));
    if (!demoGymFields.length && !hasDemoRecords) return { state: saved, changed: false };

    const emptyGym = createEmptyState().gym;
    const cleanedGym = { ...gym };
    demoGymFields.forEach((key) => { cleanedGym[key] = emptyGym[key]; });
    const keep = (list, ids) => (Array.isArray(list) ? list : []).filter((item) => !ids.has(item?.id) && !demoMemberIds.has(item?.memberId));
    const state = {
        ...saved,
        gym: cleanedGym,
        members: (Array.isArray(saved.members) ? saved.members : []).filter((member) => !demoMemberIds.has(member?.id)),
        plans: (Array.isArray(saved.plans) ? saved.plans : []).filter((plan) => !demoIds.plans.has(plan?.id)),
        attendance: keep(saved.attendance, demoIds.attendance),
        payments: keep(saved.payments, demoIds.payments)
    };
    if (state.whatsapp && Array.isArray(state.whatsapp.conversations)) {
        const conversations = state.whatsapp.conversations.filter((conversation) => !demoMemberIds.has(conversation?.memberId));
        state.whatsapp = {
            ...state.whatsapp,
            conversations,
            activeMemberId: demoMemberIds.has(state.whatsapp.activeMemberId) ? conversations[0]?.memberId || "" : state.whatsapp.activeMemberId
        };
    }
    return { state, changed: true };
}
