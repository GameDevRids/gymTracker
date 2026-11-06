const dictionaries = {
    en: {
        home: "Home", expiring: "Expiring soon", overview: "Overview", members: "Members", plans: "Plans", attendance: "Visits",
        payments: "Payments", renewals: "Renewals", retention: "Retention", analytics: "Analytics",
        reports: "Reports", notifications: "Notifications", whatsapp: "WhatsApp inbox", integrations: "Integrations", settings: "Settings",
        more: "More", quickAdd: "Quick add member", recordPayment: "Record payment", save: "Save",
        cancel: "Cancel", addAssign: "Add member & assign plan", name: "Name", phone: "Phone", plan: "Plan", expiry: "Expiry date",
        daysLeft: "Days left", remindWhatsApp: "Remind on WhatsApp", expired: "Expired",
        expiryDescription: "Memberships already expired or ending soon. Past-due members are always included.",
        windowLabel: "Show memberships ending within", expiresToday: "Expires today", expiredDays: "days expired", days: "days",
        quickAddSubtitle: "Add a member and assign their plan in one step.", paymentSubtitle: "Manual entry only. No payment gateway is connected.",
        member: "Member", selectMember: "Select a member", amountCollected: "Amount collected (₹)", phoneHelp: "Enter a valid Indian mobile number: 10 digits starting with 6–9, optionally with +91.",
        noExpiring: "No memberships match this expiry window.", loading: "Loading memberships…",
        paymentMethod: "Payment method", paidOn: "Payment date", note: "Note",
        language: "Language", english: "English", hindi: "Hindi", marathi: "Marathi"
    },
    hi: {
        home: "होम", expiring: "जल्द समाप्त", overview: "डैशबोर्ड", members: "सदस्य", plans: "योजनाएँ", attendance: "उपस्थिति",
        payments: "भुगतान", renewals: "नवीनीकरण", retention: "सदस्य बनाए रखना", analytics: "विश्लेषण",
        reports: "रिपोर्ट", notifications: "सूचनाएँ", whatsapp: "WhatsApp संदेश", integrations: "एकीकरण", settings: "सेटिंग्स",
        more: "और", quickAdd: "सदस्य जोड़ें", recordPayment: "भुगतान दर्ज करें", save: "सहेजें",
        cancel: "रद्द करें", addAssign: "सदस्य जोड़ें और योजना दें", name: "नाम", phone: "फ़ोन", plan: "योजना", expiry: "समाप्ति तिथि",
        daysLeft: "शेष दिन", remindWhatsApp: "WhatsApp पर याद दिलाएँ", expired: "समाप्त",
        expiryDescription: "समाप्त हो चुकी या जल्द समाप्त होने वाली सदस्यताएँ। पहले से समाप्त सदस्य हमेशा दिखेंगे।",
        windowLabel: "इन दिनों में समाप्त होने वाली सदस्यताएँ", expiresToday: "आज समाप्त", expiredDays: "दिन पहले समाप्त", days: "दिन",
        quickAddSubtitle: "सदस्य जोड़ें और एक ही चरण में उनकी योजना निर्धारित करें।", paymentSubtitle: "केवल मैन्युअल प्रविष्टि। कोई भुगतान गेटवे जुड़ा नहीं है।",
        member: "सदस्य", selectMember: "सदस्य चुनें", amountCollected: "प्राप्त राशि (₹)", phoneHelp: "मान्य भारतीय मोबाइल नंबर डालें: 6–9 से शुरू होने वाले 10 अंक, वैकल्पिक +91 के साथ।",
        noExpiring: "इस अवधि में कोई सदस्यता समाप्त नहीं हो रही है।", loading: "सदस्यताएँ लोड हो रही हैं…",
        paymentMethod: "भुगतान का तरीका", paidOn: "भुगतान की तारीख", note: "नोट",
        language: "भाषा", english: "अंग्रेज़ी", hindi: "हिन्दी", marathi: "मराठी"
    },
    mr: {
        home: "मुख्यपृष्ठ", expiring: "लवकरच संपणाऱ्या", overview: "आढावा", members: "सदस्य", plans: "योजना", attendance: "उपस्थिती",
        payments: "पेमेंट", renewals: "नूतनीकरण", retention: "सदस्य टिकवणे", analytics: "विश्लेषण",
        reports: "अहवाल", notifications: "सूचना", whatsapp: "WhatsApp संदेश", integrations: "एकत्रीकरण", settings: "सेटिंग्ज",
        more: "अधिक", quickAdd: "सदस्य जोडा", recordPayment: "पेमेंट नोंदवा", save: "जतन करा",
        cancel: "रद्द करा", addAssign: "सदस्य जोडा आणि योजना द्या", name: "नाव", phone: "फोन", plan: "योजना", expiry: "समाप्ती तारीख",
        daysLeft: "उरलेले दिवस", remindWhatsApp: "WhatsApp वर आठवण", expired: "संपले",
        expiryDescription: "संपलेल्या किंवा लवकरच संपणाऱ्या सदस्यता. आधीच संपलेले सदस्य नेहमी दिसतील.",
        windowLabel: "या दिवसांत संपणाऱ्या सदस्यता", expiresToday: "आज संपते", expiredDays: "दिवसांपूर्वी संपले", days: "दिवस",
        quickAddSubtitle: "सदस्य जोडा आणि एकाच टप्प्यात त्याची योजना नियुक्त करा.", paymentSubtitle: "फक्त मॅन्युअल नोंद. पेमेंट गेटवे जोडलेले नाही.",
        member: "सदस्य", selectMember: "सदस्य निवडा", amountCollected: "मिळालेली रक्कम (₹)", phoneHelp: "वैध भारतीय मोबाईल क्रमांक द्या: 6–9 ने सुरू होणारे 10 अंक, ऐच्छिक +91 सह.",
        noExpiring: "या कालावधीत कोणतीही सदस्यता संपत नाही.", loading: "सदस्यता लोड होत आहेत…",
        paymentMethod: "पेमेंट पद्धत", paidOn: "पेमेंट तारीख", note: "नोंद",
        language: "भाषा", english: "इंग्रजी", hindi: "हिंदी", marathi: "मराठी"
    }
};

const storageKey = "gympulse.language";
let selectedLanguage = "en";

export function getLanguage() {
    const saved = localStorage.getItem(storageKey);
    selectedLanguage = Object.hasOwn(dictionaries, saved) ? saved : selectedLanguage;
    return selectedLanguage;
}

export function setLanguage(language) {
    if (!Object.hasOwn(dictionaries, language)) throw new Error("Choose English, Hindi, or Marathi.");
    try {
        localStorage.setItem(storageKey, language);
    } catch (error) {
        throw new Error(`Language preference could not be saved: ${error.message}`);
    }
    selectedLanguage = language;
}

export function t(key) {
    const language = getLanguage();
    return dictionaries[language][key] || dictionaries.en[key] || key;
}

export function applyNavigationTranslations() {
    const labels = {
        overview: t("overview"),
        expiring: t("expiring"),
        members: t("members"),
        plans: t("plans"),
        attendance: t("attendance"),
        payments: t("payments"),
        renewals: t("renewals"),
        retention: t("retention"),
        analytics: t("analytics"),
        reports: t("reports"),
        notifications: t("notifications"),
        whatsapp: t("whatsapp"),
        integrations: t("integrations"),
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
    const more = document.querySelector('[data-action="mobile-more"] .nav-label');
    if (more) more.textContent = t("more");
}
