// The WhatsApp message on a follow-up (Renewals › Follow-ups), opened in WhatsApp (wa.me) with the
// text filled in. Friendly and short. Two kinds: a member who has not visited for a while
// (days is how long), and a general "how is it going". No DOM imports, so tests can build the same text.

const MESSAGES = {
    en: {
        inactive: ({ name, days, gymName }) => `Hi ${name}, we haven't seen you at ${gymName} for ${days} days. We hope all is well! Come back whenever you're ready: we'd love to see you.`,
        checkin: ({ name, gymName }) => `Hi ${name}, how is your training going at ${gymName}? Let us know if there is anything we can help with.`,
        contact: (phone) => `Questions? Call or WhatsApp us on ${phone}.`
    },
    hi: {
        inactive: ({ name, days, gymName }) => `नमस्ते ${name}, हमने आपको ${gymName} में ${days} दिनों से नहीं देखा। उम्मीद है सब ठीक है! जब चाहें वापस आइए, हमें आपसे मिलकर खुशी होगी।`,
        checkin: ({ name, gymName }) => `नमस्ते ${name}, ${gymName} में आपकी ट्रेनिंग कैसी चल रही है? किसी भी मदद के लिए हमें बताइए।`,
        contact: (phone) => `कोई सवाल? हमें ${phone} पर कॉल या WhatsApp करें।`
    },
    mr: {
        inactive: ({ name, days, gymName }) => `नमस्कार ${name}, आम्ही तुम्हाला ${gymName} मध्ये ${days} दिवसांपासून पाहिले नाही. आशा आहे सर्व ठीक आहे! तुम्हाला जमेल तेव्हा परत या, तुम्हाला भेटून आनंद होईल.`,
        checkin: ({ name, gymName }) => `नमस्कार ${name}, ${gymName} मध्ये तुमचे ट्रेनिंग कसे चालले आहे? काही मदत हवी असल्यास आम्हाला सांगा.`,
        contact: (phone) => `काही प्रश्न? आम्हाला ${phone} वर कॉल किंवा WhatsApp करा.`
    }
};

/**
 * The message in the gym's language (English if unknown). days: whole days without a visit; 14 or more
 * gives the "we haven't seen you" message, anything else (or unknown) the general one.
 */
export function buildFollowupMessage({ language = "en", name, days = null, gymName, gymPhone = "" }) {
    const set = MESSAGES[language] || MESSAGES.en;
    const first = String(name || "").trim().split(/\s+/)[0] || "there";
    const fields = { name: first, days, gymName: String(gymName || "").trim() || "the gym" };
    const kind = Number.isInteger(days) && days >= 14 ? "inactive" : "checkin";
    const phone = String(gymPhone || "").trim();
    return [set[kind](fields), phone ? set.contact(phone) : ""].filter(Boolean).join("\n\n");
}
