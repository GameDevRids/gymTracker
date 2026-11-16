// The "Send welcome back message" after a plan hold ends, opened in WhatsApp (wa.me) with the text
// filled in. Says the plan is running again and when it now ends. No DOM imports, so the server and
// tests can build the same text.

const MESSAGES = {
    en: ({ name, plan, endDate, graceDate, gymName, gymPhone }) => [
        `Hi ${name}, welcome back to ${gymName}!`,
        `Your ${plan} plan is running again and now ends on ${endDate}${graceDate ? ` (grace till ${graceDate})` : ""}.`,
        gymPhone ? `Questions? Call or WhatsApp us on ${gymPhone}.` : "See you soon!"
    ],
    hi: ({ name, plan, endDate, graceDate, gymName, gymPhone }) => [
        `नमस्ते ${name}, ${gymName} में आपका फिर से स्वागत है!`,
        `आपका ${plan} प्लान फिर से चालू है और अब ${endDate} को समाप्त होगा${graceDate ? ` (ग्रेस ${graceDate} तक)` : ""}।`,
        gymPhone ? `कोई सवाल? हमें ${gymPhone} पर कॉल या WhatsApp करें।` : "जल्द मिलते हैं!"
    ],
    mr: ({ name, plan, endDate, graceDate, gymName, gymPhone }) => [
        `नमस्कार ${name}, ${gymName} मध्ये तुमचे पुन्हा स्वागत आहे!`,
        `तुमचा ${plan} प्लॅन पुन्हा सुरू झाला आहे आणि आता ${endDate} रोजी संपेल${graceDate ? ` (ग्रेस ${graceDate} पर्यंत)` : ""}.`,
        gymPhone ? `काही प्रश्न? आम्हाला ${gymPhone} वर कॉल किंवा WhatsApp करा.` : "लवकरच भेटू!"
    ]
};

/** The message in the gym's language (English if unknown). endDate and graceDate are already formatted for people. */
export function buildHoldReturnMessage({ language = "en", name, plan, endDate, graceDate = "", gymName, gymPhone = "" }) {
    const build = MESSAGES[language] || MESSAGES.en;
    const first = String(name || "").trim().split(/\s+/)[0] || "there";
    return build({
        name: first,
        plan: String(plan || "").trim() || "gym",
        endDate,
        graceDate: String(graceDate || "").trim(),
        gymName: String(gymName || "").trim() || "the gym",
        gymPhone: String(gymPhone || "").trim()
    }).filter(Boolean).join("\n\n");
}
