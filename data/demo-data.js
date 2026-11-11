const firstNames = ["Aarav", "Aisha", "Kabir", "Diya", "Arjun", "Meera", "Rohan", "Ishita", "Vivaan", "Ananya", "Reyansh", "Sana", "Aditya", "Kavya", "Ibrahim", "Tara", "Dev", "Nisha", "Neil", "Simran", "Kunal", "Myra", "Zoya", "Rahul", "Anika", "Samar", "Ira", "Yash", "Riya", "Om", "Sahil", "Avni"];
const lastNames = ["Sharma", "Patel", "Mehta", "Rao", "Kapoor", "Iyer", "Khan", "Singh", "Desai", "Joshi", "Nair", "Verma", "Malhotra", "Das", "Chopra", "Kulkarni"];
const planList = [
    { id: "plan-monthly", name: "Monthly", durationDays: 30, price: 1800, description: "Flexible month-to-month training", active: true },
    { id: "plan-quarterly", name: "Quarterly", durationDays: 90, price: 4800, description: "Three months of consistent training", active: true },
    { id: "plan-half-yearly", name: "Half-yearly", durationDays: 180, price: 8500, description: "Six-month membership with great value", active: true },
    { id: "plan-annual", name: "Annual", durationDays: 365, price: 15000, description: "Best value for long-term commitment", active: true },
    { id: "plan-custom", name: "Personal training", durationDays: 30, price: 3500, description: "Custom coaching add-on package", active: true }
];

function dayOffset(offset) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + offset);
    return date.toISOString().slice(0, 10);
}

const members = firstNames.map((first, index) => {
    const plan = planList[index % planList.length];
    const duration = plan.durationDays;
    const isNew = index % 10 === 2;
    const isExpired = index % 9 === 0;
    const isExpiring = !isExpired && index % 7 === 0;
    const expiryOffset = isNew
        ? -(index % 3) * 5 + duration
        : isExpired ? -(2 + index % 20)
            : isExpiring ? 1 + index % 7
                : 10 + (index * 13 % Math.max(1, duration - 10));
    const startOffset = isNew
        ? -(index % 3) * 5
        : Math.min(0, expiryOffset - duration);
    const joinedOffset = isNew ? startOffset : Math.min(-((index * 17 + 25) % 450), startOffset);
    const expiry = new Date(`${dayOffset(startOffset)}T12:00:00`);
    expiry.setDate(expiry.getDate() + duration);
    const amountPaid = index % 9 === 0 ? Math.round(plan.price * .55) : plan.price;
    return {
        id: `GP-${String(1001 + index)}`,
        name: `${first} ${lastNames[(index * 3) % lastNames.length]}`,
        phone: `+91 98${String(41002000 + index * 137).slice(-8)}`,
        email: `${first.toLowerCase()}${index + 1}@example.com`,
        dob: index % 4 === 0 ? dayOffset(-((index + 1) * 700)) : "",
        gender: index % 3 === 0 ? "Female" : index % 3 === 1 ? "Male" : "Prefer not to say",
        joinedAt: dayOffset(joinedOffset),
        planId: plan.id,
        startDate: dayOffset(startOffset),
        expiryDate: expiry.toISOString().slice(0, 10),
        status: index === 23 ? "suspended" : "active",
        totalFees: plan.price,
        charges: [{ amount: plan.price, date: dayOffset(startOffset) }],
        amountPaid,
        emergencyContact: "",
        notes: "",
        followUpStatus: "pending",
        renewals: []
    };
});

const attendance = [];
members.forEach((member, index) => {
    if (index % 6 === 2 || index % 9 === 4) return;
    const visits = index % 4 === 0 ? 2 : 5 + (index % 7);
    for (let visit = 0; visit < visits; visit += 1) {
        const daysAgo = visit === 0 ? index % 19 : (visit * 3 + index * 2) % 35;
        const date = new Date(`${dayOffset(-daysAgo)}T${String(6 + ((visit + index) % 13)).padStart(2, "0")}:${visit % 2 ? "20" : "05"}:00`);
        attendance.push({
            id: `AT-${index}-${visit}`,
            memberId: member.id,
            checkedInAt: date.toISOString(),
            checkedOutAt: "",
            source: "manual"
        });
    }
});

const payments = [];
members.forEach((member, index) => {
    const entries = index % 8 === 0 ? 2 : 1;
    const daysSinceStart = Math.max(0, Math.floor((new Date(`${dayOffset(0)}T12:00:00`) - new Date(`${member.startDate}T12:00:00`)) / 86400000));
    for (let item = 0; item < entries; item += 1) {
        const firstPart = Math.floor(member.amountPaid / 2);
        const amount = entries === 2 ? (item === 0 ? firstPart : member.amountPaid - firstPart) : member.amountPaid;
        const daysAgo = Math.min((index * 3 + item * 12) % 95, daysSinceStart);
        payments.push({
            id: `TX-${10001 + index * 2 + item}`,
            memberId: member.id,
            amount,
            date: dayOffset(-daysAgo),
            method: ["UPI", "Cash", "Card", "Bank transfer"][(index + item) % 4],
            status: "paid",
            notes: item ? "Part payment" : ""
        });
    }
});

// Fictional gym details used only by the explicit "Load sample data" action.
// Older versions also seeded these into every new workspace automatically.
const demoGymDetails = { name: "Forge Fitness", address: "Koramangala, Bengaluru", phone: "+91 80 4567 8900" };

export function createDemoState() {
    return {
        gym: {
            ...demoGymDetails,
            currency: "INR", dateFormat: "DD MMM YYYY",
            preferences: { expiryReminderDays: 7, paymentReminders: true, inactivityReminders: true }
        },
        plans: structuredClone(planList),
        members: structuredClone(members),
        attendance: structuredClone(attendance),
        payments: structuredClone(payments),
        notifications: [],
        createdAt: new Date().toISOString()
    };
}

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

/**
 * Removes the fictional records that older versions seeded into every new
 * workspace automatically. Records the owner created themselves are kept.
 * Workspaces where the owner explicitly loaded sample data are left alone.
 */
export function removeLegacyDemoData(saved) {
    if (!saved || typeof saved !== "object" || saved.sampleDataLoaded) return { state: saved, changed: false };
    const demo = createDemoState();
    const idsOf = (list) => new Set(list.map((item) => item.id));
    const demoMemberIds = idsOf(demo.members);
    const demoIds = {
        members: demoMemberIds,
        plans: idsOf(demo.plans),
        attendance: idsOf(demo.attendance),
        payments: idsOf(demo.payments)
    };
    const gym = saved.gym && typeof saved.gym === "object" ? saved.gym : {};
    const demoGymFields = Object.keys(demoGymDetails).filter((key) => gym[key] === demoGymDetails[key]);
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
