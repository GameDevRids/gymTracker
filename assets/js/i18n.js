const dictionaries = {
    en: {
        home: "Home", expiring: "Expiring soon", overview: "Overview", members: "Members", plans: "Plans", attendance: "Visits",
        payments: "Payments", enquiries: "Enquiries", today: "Today", checkin: "Check-in", renewals: "Renewals", retention: "Retention", analytics: "Analytics",
        reports: "Reports", notifications: "Notifications", whatsapp: "WhatsApp inbox", integrations: "Integrations", settings: "Settings",
        more: "More", quickAdd: "Quick add member", recordPayment: "Record payment", renew: "Renew", inGrace: "In grace", graceDaysLeft: "grace days left", graceDayLeft: "grace day left", graceLastDay: "last day of grace", ended: "Ended", graceTill: "Grace till", seeLapsed: "See lapsed members →", save: "Save",
        cancel: "Cancel", addAssign: "Add member & assign plan", name: "Name", phone: "Phone", plan: "Plan", expiry: "Expiry date",
        daysLeft: "Days left", remindWhatsApp: "Send reminder", noWhatsAppConsent: "No WhatsApp consent", reminded: "Reminder sent ✓", toRemind: "to remind", remindedSoFar: "reminded", remindersProgress: "Reminders sent", expired: "Expired",
        expiryDescription: "Plans ending within 7 days, and members in grace. Reminders open from 3 days before the end.",
        windowLabel: "Show memberships ending within", expiresToday: "Expires today", expiredDays: "days expired", days: "days",
        quickAddSubtitle: "Add a member and assign their plan in one step.", paymentSubtitle: "Manual entry only. No payment gateway is connected.",
        member: "Member", selectMember: "Select a member", amountCollected: "Amount collected (₹)", phoneHelp: "Enter a valid Indian mobile number: 10 digits starting with 6–9, optionally with +91.",
        noExpiring: "No plans are ending soon. Members appear here when their plan has 7 days or less left, or while it is in grace.", loading: "Loading memberships…",
        paymentMethod: "Payment method", paidOn: "Payment date", note: "Note",
        language: "Language", english: "English", hindi: "Hindi", marathi: "Marathi"
    },
    hi: {
        home: "होम", expiring: "जल्द समाप्त", overview: "डैशबोर्ड", members: "सदस्य", plans: "योजनाएँ", attendance: "उपस्थिति",
        payments: "भुगतान", enquiries: "पूछताछ", today: "आज", checkin: "चेक-इन", renewals: "नवीनीकरण", retention: "सदस्य बनाए रखना", analytics: "विश्लेषण",
        reports: "रिपोर्ट", notifications: "सूचनाएँ", whatsapp: "WhatsApp संदेश", integrations: "एकीकरण", settings: "सेटिंग्स",
        more: "और", quickAdd: "सदस्य जोड़ें", recordPayment: "भुगतान दर्ज करें", renew: "नवीनीकरण करें", inGrace: "ग्रेस अवधि में", graceDaysLeft: "ग्रेस दिन बाकी", graceDayLeft: "ग्रेस दिन बाकी", graceLastDay: "ग्रेस का आखिरी दिन", ended: "समाप्त", graceTill: "ग्रेस तक", seeLapsed: "लैप्स सदस्य देखें →", save: "सहेजें",
        cancel: "रद्द करें", addAssign: "सदस्य जोड़ें और योजना दें", name: "नाम", phone: "फ़ोन", plan: "योजना", expiry: "समाप्ति तिथि",
        daysLeft: "शेष दिन", remindWhatsApp: "WhatsApp पर याद दिलाएँ", noWhatsAppConsent: "WhatsApp सहमति नहीं", reminded: "याद दिलाया ✓", toRemind: "को याद दिलाना है", remindedSoFar: "को याद दिलाया", remindersProgress: "भेजे गए रिमाइंडर", expired: "समाप्त",
        expiryDescription: "7 दिनों में समाप्त होने वाली सदस्यताएँ, और ग्रेस अवधि वाले सदस्य। समाप्ति से 3 दिन पहले से याद दिला सकते हैं।",
        windowLabel: "इन दिनों में समाप्त होने वाली सदस्यताएँ", expiresToday: "आज समाप्त", expiredDays: "दिन पहले समाप्त", days: "दिन",
        quickAddSubtitle: "सदस्य जोड़ें और एक ही चरण में उनकी योजना निर्धारित करें।", paymentSubtitle: "केवल मैन्युअल प्रविष्टि। कोई भुगतान गेटवे जुड़ा नहीं है।",
        member: "सदस्य", selectMember: "सदस्य चुनें", amountCollected: "प्राप्त राशि (₹)", phoneHelp: "मान्य भारतीय मोबाइल नंबर डालें: 6–9 से शुरू होने वाले 10 अंक, वैकल्पिक +91 के साथ।",
        noExpiring: "अभी कोई प्लान समाप्त नहीं हो रहा। प्लान में 7 दिन या कम बचने पर, या ग्रेस अवधि में, सदस्य यहाँ दिखते हैं।", loading: "सदस्यताएँ लोड हो रही हैं…",
        paymentMethod: "भुगतान का तरीका", paidOn: "भुगतान की तारीख", note: "नोट",
        language: "भाषा", english: "अंग्रेज़ी", hindi: "हिन्दी", marathi: "मराठी"
    },
    mr: {
        home: "मुख्यपृष्ठ", expiring: "लवकरच संपणाऱ्या", overview: "आढावा", members: "सदस्य", plans: "योजना", attendance: "उपस्थिती",
        payments: "पेमेंट", enquiries: "चौकशी", today: "आज", checkin: "चेक-इन", renewals: "नूतनीकरण", retention: "सदस्य टिकवणे", analytics: "विश्लेषण",
        reports: "अहवाल", notifications: "सूचना", whatsapp: "WhatsApp संदेश", integrations: "एकत्रीकरण", settings: "सेटिंग्ज",
        more: "अधिक", quickAdd: "सदस्य जोडा", recordPayment: "पेमेंट नोंदवा", renew: "नूतनीकरण करा", inGrace: "ग्रेस कालावधीत", graceDaysLeft: "ग्रेस दिवस बाकी", graceDayLeft: "ग्रेस दिवस बाकी", graceLastDay: "ग्रेसचा शेवटचा दिवस", ended: "संपले", graceTill: "ग्रेस पर्यंत", seeLapsed: "लॅप्स सदस्य पहा →", save: "जतन करा",
        cancel: "रद्द करा", addAssign: "सदस्य जोडा आणि योजना द्या", name: "नाव", phone: "फोन", plan: "योजना", expiry: "समाप्ती तारीख",
        daysLeft: "उरलेले दिवस", remindWhatsApp: "WhatsApp वर आठवण", noWhatsAppConsent: "WhatsApp संमती नाही", reminded: "आठवण दिली ✓", toRemind: "जणांना आठवण द्यायची", remindedSoFar: "जणांना आठवण दिली", remindersProgress: "पाठवलेल्या आठवणी", expired: "संपले",
        expiryDescription: "7 दिवसांत संपणाऱ्या सदस्यता, आणि ग्रेस कालावधीतील सदस्य. संपण्याच्या 3 दिवस आधीपासून आठवण करून देता येते.",
        windowLabel: "या दिवसांत संपणाऱ्या सदस्यता", expiresToday: "आज संपते", expiredDays: "दिवसांपूर्वी संपले", days: "दिवस",
        quickAddSubtitle: "सदस्य जोडा आणि एकाच टप्प्यात त्याची योजना नियुक्त करा.", paymentSubtitle: "फक्त मॅन्युअल नोंद. पेमेंट गेटवे जोडलेले नाही.",
        member: "सदस्य", selectMember: "सदस्य निवडा", amountCollected: "मिळालेली रक्कम (₹)", phoneHelp: "वैध भारतीय मोबाईल क्रमांक द्या: 6–9 ने सुरू होणारे 10 अंक, ऐच्छिक +91 सह.",
        noExpiring: "सध्या कोणताही प्लॅन संपत नाही. प्लॅनमध्ये 7 दिवस किंवा कमी उरल्यावर, किंवा ग्रेस कालावधीत, सदस्य येथे दिसतात.", loading: "सदस्यता लोड होत आहेत…",
        paymentMethod: "पेमेंट पद्धत", paidOn: "पेमेंट तारीख", note: "नोंद",
        language: "भाषा", english: "इंग्रजी", hindi: "हिंदी", marathi: "मराठी"
    }
};

// One language per gym, saved in the database (Settings) and applied after sign-in. It is used
// for the screens and for WhatsApp messages; nothing is kept in browser storage.
let selectedLanguage = "en";

export function getLanguage() {
    return selectedLanguage;
}

export function isSupportedLanguage(language) {
    return Object.hasOwn(dictionaries, language);
}

export function setLanguage(language) {
    if (!isSupportedLanguage(language)) throw new Error("Choose English, Hindi, or Marathi.");
    selectedLanguage = language;
}

export function t(key) {
    const language = getLanguage();
    return dictionaries[language][key] || dictionaries.en[key] || key;
}

export function applyNavigationTranslations() {
    const labels = {
        overview: t("today"),
        members: t("members"),
        enquiries: t("enquiries"),
        scan: t("checkin"),
        payments: t("payments"),
        renewals: t("renewals"),
        plans: t("plans"),
        reports: t("reports"),
        settings: t("settings")
    };
    document.querySelectorAll(".mobile-nav-link[data-view]").forEach((link) => {
        const label = link.querySelector(".nav-label");
        if (label && labels[link.dataset.view]) label.textContent = labels[link.dataset.view];
    });
    document.querySelectorAll(".nav-link[data-view]").forEach((link) => {
        const label = link.querySelector(".nav-label");
        if (label && labels[link.dataset.view]) label.textContent = labels[link.dataset.view];
    });
    document.querySelectorAll('[data-action="mobile-more"] .nav-label').forEach((label) => { label.textContent = t("more"); });
}
