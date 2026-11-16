// The "Send renewal message" for lapsed and old members, opened in WhatsApp (wa.me) with the text
// filled in. Friendly, says when their plan ended, and gives the gym's number. No DOM imports, so
// the server and tests can build the same text.

const MESSAGES = {
    en: ({ name, plan, endedOn, gymName, gymPhone }) => [
        `Hi ${name}, we miss you at ${gymName}!`,
        `Your ${plan} membership ended on ${endedOn}. Come back whenever you're ready: renewing takes a minute at the desk, and your new plan starts on the day you renew.`,
        gymPhone ? `Questions? Call or WhatsApp us on ${gymPhone}.` : ""
    ],
    hi: ({ name, plan, endedOn, gymName, gymPhone }) => [
        `नमस्ते ${name}, ${gymName} में हमें आपकी कमी महसूस हो रही है!`,
        `आपकी ${plan} सदस्यता ${endedOn} को समाप्त हो गई। जब चाहें वापस आइए: डेस्क पर नवीनीकरण में एक मिनट लगता है, और नया प्लान उसी दिन से शुरू होता है।`,
        gymPhone ? `कोई सवाल? हमें ${gymPhone} पर कॉल या WhatsApp करें।` : ""
    ],
    mr: ({ name, plan, endedOn, gymName, gymPhone }) => [
        `नमस्कार ${name}, ${gymName} मध्ये आम्हाला तुमची आठवण येते!`,
        `तुमची ${plan} सदस्यता ${endedOn} रोजी संपली. तुम्हाला जमेल तेव्हा परत या: डेस्कवर नूतनीकरणाला एक मिनिट लागतो, आणि नवीन प्लॅन त्याच दिवसापासून सुरू होतो.`,
        gymPhone ? `काही प्रश्न? आम्हाला ${gymPhone} वर कॉल किंवा WhatsApp करा.` : ""
    ]
};

/** The message in the gym's language (English if unknown). endedOn is already formatted for people. */
export function buildLapsedMessage({ language = "en", name, plan, endedOn, gymName, gymPhone = "" }) {
    const build = MESSAGES[language] || MESSAGES.en;
    const first = String(name || "").trim().split(/\s+/)[0] || "there";
    return build({ name: first, plan: String(plan || "").trim() || "gym", endedOn, gymName: String(gymName || "").trim() || "the gym", gymPhone: String(gymPhone || "").trim() })
        .filter(Boolean).join("\n\n");
}
