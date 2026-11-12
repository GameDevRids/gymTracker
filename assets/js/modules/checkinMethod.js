// Which check-in method the gym uses (Settings > Attendance), loaded from the database.
// No DOM access: the welcome card imports it too. Until the settings arrive, neither
// method's extras (member QR card, poster) are shown.
export const checkinSettings = { status: "idle", data: null, message: "" };

export function checkinMethod() {
    return checkinSettings.data?.checkin_method || null;
}

export function usesMemberQr() {
    return checkinMethod() === "member_qr";
}

export function usesPoster() {
    return checkinMethod() === "entrance_poster";
}

export function canEditCheckinSettings() {
    return checkinSettings.data?.can_edit === true;
}
