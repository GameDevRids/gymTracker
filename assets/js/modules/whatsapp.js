import { state, getMember, getPlan, memberBalance, persist } from "../state.js";
import { escapeHTML, formatINR, formatDate, formatPhone, localISODate, daysBetween, uid } from "../utils.js";
import { toast } from "../components/toast.js";
import { apiClient } from "../api/apiClient.js";

const defaultTemplates = [
    { id: "expiry", name: "Membership expiry", metaName: "membership_expiry_reminder", language: "en", body: "Hi {{1}}, your membership expires on {{2}}. Reply to ask us about renewal.", variables: ["first_name", "expiry_date"] },
    { id: "payment", name: "Payment reminder", metaName: "payment_reminder", language: "en", body: "Hi {{1}}, your outstanding balance is {{2}}. Please contact the gym if you have questions.", variables: ["first_name", "balance"] },
    { id: "inactive", name: "Inactive member follow-up", metaName: "inactive_member_followup", language: "en", body: "Hi {{1}}, we have missed seeing you at the gym. We hope you are doing well.", variables: ["first_name"] },
    { id: "payment-confirmation", name: "Payment confirmation", metaName: "payment_confirmation", language: "en", body: "Hi {{1}}, we recorded your payment of {{2}}. Thank you!", variables: ["first_name", "amount"] }
];
let mobileConversationOpen = false;

const seededInboundTexts = ["Thanks, see you at training!", "What are the gym hours this weekend?", "Could you share my membership details?"];

function isSeededDemoMessage(message) {
    if (message?.status !== "demo") return false;
    if (message.direction === "inbound") return seededInboundTexts.includes(message.text);
    return message.direction === "outbound" && /^Welcome to .*! Reply here if you need any help\.$/.test(String(message.text || ""));
}

function ensureWhatsAppState() {
    if (!state.whatsapp || typeof state.whatsapp !== "object") state.whatsapp = {};
    const data = state.whatsapp;
    if (!["demo", "live"].includes(data.mode)) data.mode = "demo";
    if (!Array.isArray(data.templates)) data.templates = structuredClone(defaultTemplates);
    if (!data.expiryReminderTemplate) {
        data.expiryReminderTemplate = "Hi {name}, your {plan} membership expires on {expiry_date}. We would love to see you again!";
    }
    if (!state.sampleDataLoaded && Array.isArray(data.conversations) && !data.seededConversationsRemoved) {
        // Older versions invented chats with real members. Remove those canned messages, keep real ones.
        data.conversations = data.conversations
            .map((conversation) => ({ ...conversation, messages: (conversation.messages || []).filter((message) => !isSeededDemoMessage(message)) }))
            .filter((conversation) => conversation.messages.length);
        if (!data.conversations.some((conversation) => conversation.memberId === data.activeMemberId)) data.activeMemberId = data.conversations[0]?.memberId || "";
        data.seededConversationsRemoved = true;
    }
    if (!Array.isArray(data.conversations)) {
        // Example chats are only created for explicitly loaded, fictional sample members.
        data.conversations = !state.sampleDataLoaded ? [] : state.members.slice(0, 5).map((member, index) => ({
            memberId: member.id,
            unread: index % 2,
            messages: [
                { id: uid("WAM"), direction: "outbound", text: `Welcome to ${state.gym.name}! Reply here if you need any help.`, timestamp: new Date(Date.now() - (index + 2) * 3600000).toISOString(), status: "demo" },
                { id: uid("WAM"), direction: "inbound", text: ["Thanks, see you at training!", "What are the gym hours this weekend?", "Could you share my membership details?"][index % 3], timestamp: new Date(Date.now() - (index + 1) * 3600000).toISOString(), status: "demo" }
            ]
        }));
        data.activeMemberId = data.conversations[0]?.memberId || "";
    }
    if (!data.apiBaseUrl) data.apiBaseUrl = window.location.origin === "http://localhost:3001" || window.location.origin === "http://127.0.0.1:3001" ? "" : "http://localhost:3001";
    return data;
}

function activeConversation(data) {
    return data.conversations.find((conversation) => conversation.memberId === data.activeMemberId) || data.conversations[0];
}

function persistWhatsApp() {
    try {
        persist();
        return true;
    } catch (error) {
        toast(error.message || "WhatsApp settings could not be saved.", "error");
        return false;
    }
}

function displayText(template, member) {
    const plan = getPlan(member.planId);
    return template.body.replace(/\{\{(\d+)\}\}/g, (_match, number) => {
        const key = template.variables[Number(number) - 1];
        if (key === "first_name") return member.name.split(/\s+/)[0];
        if (key === "expiry_date") return formatDate(member.expiryDate);
        if (key === "balance") return formatINR(memberBalance(member));
        if (key === "amount") {
            const payment = state.payments.find((entry) => entry.memberId === member.id);
            return formatINR(payment?.amount || 0);
        }
        if (key === "plan") return plan?.name || "membership";
        return "";
    });
}

function messageTime(timestamp) {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function messageStatus(message, demo) {
    if (demo || message.status === "demo" || message.status === "simulated") return `<span class="wa-demo-label">DEMO · simulated, not delivered</span>`;
    const status = String(message.status || "unknown");
    const labels = { accepted: "Accepted by Meta · awaiting status", sent: "Sent", delivered: "Delivered", read: "Read", failed: "Failed", received: "Received", unknown: "Status unavailable" };
    const detail = status === "failed" && message.error ? ` · ${message.error}` : "";
    return `<span class="wa-message-status wa-status-${escapeHTML(status)}">${escapeHTML(`${labels[status] || status}${detail}`)}</span>`;
}

function renderMessage(message, demo) {
    const mine = message.direction === "outbound";
    const isCard = Boolean(message.card);
    return `<div class="wa-message ${mine ? "wa-outgoing" : "wa-incoming"}">${isCard ? `<div class="wa-id-card"><strong>GYMPULSE MEMBER</strong><span>${escapeHTML(message.card.name)}</span><small>${escapeHTML(message.card.id)} · ${escapeHTML(message.card.plan)}</small><small>Valid through ${escapeHTML(message.card.expiry)}</small></div>` : `<p>${escapeHTML(message.text || (message.direction === "outbound" ? "WhatsApp message" : "Incoming message"))}</p>`}<div class="wa-message-meta"><time>${escapeHTML(messageTime(message.timestamp))}</time>${messageStatus(message, demo)}</div></div>`;
}

function renderConversationList(data) {
    return data.conversations.map((conversation) => {
        const member = getMember(conversation.memberId);
        if (!member) return "";
        const last = conversation.messages[conversation.messages.length - 1];
        return `<button class="wa-contact ${conversation.memberId === data.activeMemberId ? "selected" : ""}" data-action="whatsapp-select" data-id="${escapeHTML(member.id)}"><span class="wa-avatar">${escapeHTML(member.name.slice(0, 1))}</span><span class="wa-contact-copy"><strong>${escapeHTML(member.name)}</strong><small>${escapeHTML(last?.text || "Membership ID card")}</small></span><span class="wa-contact-time">${escapeHTML(messageTime(last?.timestamp || ""))}${conversation.unread ? `<i>${conversation.unread}</i>` : ""}</span></button>`;
    }).join("") || `<div class="empty-state">No conversations yet. Select a member below to start.</div>`;
}

export function renderWhatsAppPage() {
    const data = ensureWhatsAppState();
    document.body.classList.toggle("whatsapp-fullscreen", mobileConversationOpen && window.matchMedia("(max-width: 560px)").matches);
    const conversation = activeConversation(data);
    const member = conversation ? getMember(conversation.memberId) : null;
    const baseUrl = data.apiBaseUrl || window.location.origin;
    const templates = data.templates;
    const messages = conversation?.messages || [];
    const activeMembers = state.members;
    return `<div class="page-heading"><div><h1>WhatsApp inbox</h1><p>Manage member conversations, approved templates and delivery events.</p></div><div class="heading-actions"><span class="wa-mode-badge ${data.mode === "demo" ? "wa-mode-demo" : "wa-mode-live"}">${data.mode === "demo" ? "DEMO MODE" : "LIVE MODE"}</span><button class="button button-secondary" data-action="whatsapp-followups">Run inactive follow-ups</button><button class="button button-secondary" data-action="whatsapp-refresh">↻ Refresh statuses</button></div></div>
        <div class="wa-mode-settings card"><div><strong>Messaging mode</strong><p>${data.mode === "demo" ? "Fictional conversations only. No WhatsApp messages are sent." : "Meta Cloud API only. API acceptance is not delivery; delivery requires a webhook status."}</p></div><div class="wa-mode-controls"><label for="whatsapp-mode">Mode</label><select class="field-control" id="whatsapp-mode" data-whatsapp-change="mode"><option value="demo" ${data.mode === "demo" ? "selected" : ""}>Demo · simulated</option><option value="live" ${data.mode === "live" ? "selected" : ""}>Live · Meta Cloud API</option></select><label class="wa-api-url-label" for="whatsapp-api-url">Backend</label><input id="whatsapp-api-url" class="field-control" type="url" value="${escapeHTML(baseUrl)}" placeholder="http://localhost:3001" aria-label="WhatsApp backend URL"></div></div>
        <div class="note-box wa-mode-note">${data.mode === "demo" ? "Every message in demo mode is marked DEMO and is never represented as delivered. Switch modes deliberately; Live mode requires a configured backend, Meta credentials and a verified webhook. Sample member records are fictional; replace them with consented member data before enabling live sends." : "Live mode will never fall back to simulation. Messages show accepted/sent/delivered/read/failed only from the actual API response and Meta webhook. Use only opted-in recipients and Meta-approved templates for messages outside the customer-service window. Sample member records are fictional; do not mark them opted in or send to them."}</div>
        <section class="wa-inbox card ${mobileConversationOpen ? "show-thread" : ""}"><aside class="wa-sidebar"><div class="wa-sidebar-heading"><div><h2>Conversations</h2><p>${data.conversations.length} member chats</p></div><div class="wa-list-actions"><button class="text-button wa-close-inbox" data-action="whatsapp-close">← Close inbox</button><button class="text-button" data-action="whatsapp-add-chat">＋ New</button></div></div><div class="wa-contact-list">${renderConversationList(data)}</div><div class="wa-start-chat"><label for="whatsapp-member">Start a conversation</label><select class="field-control" id="whatsapp-member"><option value="">Choose member…</option>${activeMembers.map((item) => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name)}</option>`).join("")}</select></div></aside>
        <div class="wa-thread">${member ? `<header class="wa-thread-header"><button class="wa-back" type="button" data-action="whatsapp-back" aria-label="Back to conversations">←</button><span class="wa-avatar">${escapeHTML(member.name.slice(0, 1))}</span><span><strong>${escapeHTML(member.name)}</strong><small>${escapeHTML(formatPhone(member.phone))} · Member ID ${escapeHTML(member.id)}</small></span><button class="button button-secondary button-small" data-action="whatsapp-send-card" data-id="${escapeHTML(member.id)}">Send ID card</button></header><div class="wa-thread-messages" id="wa-thread-messages" role="log" aria-label="Conversation messages" aria-live="polite">${messages.map((message) => renderMessage(message, data.mode === "demo")).join("") || `<div class="empty-state">No messages in this conversation yet.</div>`}</div><form id="whatsapp-compose" class="wa-compose" data-member-id="${escapeHTML(member.id)}"><div class="wa-compose-options"><label for="whatsapp-template">Message type</label><select id="whatsapp-template" name="templateId" class="field-control"><option value="">Text message</option>${templates.map((template) => `<option value="${escapeHTML(template.id)}">${escapeHTML(template.name)}${data.mode === "live" ? ` · ${escapeHTML(template.metaName)}` : ""}</option>`).join("")}</select></div><textarea name="message" rows="2" placeholder="${data.mode === "live" ? "Type a message (within the 24-hour service window)..." : "Write a simulated demo message..."}" aria-label="Message to ${escapeHTML(member.name)}" maxlength="4096"></textarea><div class="wa-compose-footer"><span>${data.mode === "demo" ? "DEMO · not sent" : "Live send · recipient consent required"}</span><button class="button button-primary" type="submit">Send message</button></div></form>` : `<div class="empty-state">Choose a member to view a conversation.</div>`}</div></section>
        <section class="card wa-templates"><div class="wa-sidebar-heading"><div><h2>WhatsApp click-to-chat reminder</h2><p>Used by membership expiry reminders; no Meta API is involved.</p></div></div><form id="whatsapp-click-template-form" class="wa-template-form"><textarea name="body" aria-label="Expiry reminder message" required maxlength="1000">${escapeHTML(data.expiryReminderTemplate)}</textarea><p class="helper-text">Placeholders: {name}, {plan}, {expiry_date}</p><button class="button button-secondary" type="submit">Save reminder message</button></form></section>
        <section class="card wa-templates"><div class="wa-sidebar-heading"><div><h2>Message templates</h2><p>In live mode, names must match approved Meta templates.</p></div></div><div class="wa-template-list">${templates.map((template) => `<article class="wa-template"><div><strong>${escapeHTML(template.name)}</strong><small>${escapeHTML(template.metaName)} · ${escapeHTML(template.language)}</small><p>${escapeHTML(template.body)}</p></div><button class="text-button" data-action="whatsapp-delete-template" data-id="${escapeHTML(template.id)}" aria-label="Delete ${escapeHTML(template.name)} template">Remove</button></article>`).join("")}</div><form id="whatsapp-template-form" class="wa-template-form"><input name="name" class="field-control" placeholder="Template label" aria-label="Template label" required maxlength="60"><input name="metaName" class="field-control" placeholder="approved_meta_template_name" aria-label="Meta template name" required pattern="[a-z0-9_]+" maxlength="100"><input name="language" class="field-control" placeholder="en" aria-label="Template language" value="en" required maxlength="10"><input name="variables" class="field-control" placeholder="first_name, expiry_date" aria-label="Template variables, comma separated"><textarea name="body" placeholder="Hi {{1}}, your membership expires on {{2}}..." aria-label="Template body" required maxlength="1024"></textarea><button class="button button-secondary" type="submit">＋ Add template</button></form></section>
        <div class="helper-text wa-footer-note">Live messages and webhook events are held in backend memory in this prototype and clear when the server restarts. Add owner authentication, per-gym access control, durable storage, consent/opt-out tracking and an audit trail before production use.</div>`;
}

function conversationFor(data, member) {
    let conversation = data.conversations.find((item) => item.memberId === member.id);
    if (!conversation) {
        conversation = { memberId: member.id, unread: 0, messages: [] };
        data.conversations.unshift(conversation);
    }
    data.activeMemberId = member.id;
    return conversation;
}

function addMessage(conversation, message) {
    conversation.messages.push(message);
    if (conversation.messages.length > 200) conversation.messages.splice(0, conversation.messages.length - 200);
}

function apiUrl(data, path) {
    const base = (data.apiBaseUrl || window.location.origin).replace(/\/+$/, "");
    return `${base}/api/whatsapp${path}`;
}

async function request(data, path, options = {}) {
    try {
        return await apiClient.request(apiUrl(data, path), {
            method: options.method || "GET",
            body: options.body,
            headers: options.headers || {}
        });
    } catch (error) {
        if (error instanceof TypeError) {
            throw new Error("Could not reach the WhatsApp backend. Check the backend URL and that server is running.");
        }
        throw error;
    }
}

export async function handleWhatsAppChange(target, render) {
    if (target.dataset.whatsappChange !== "mode") return;
    const data = ensureWhatsAppState();
    if (target.value === "live") {
        try {
            const status = await request(data, "/status");
            if (!status.configured) throw new Error(status.message || "Meta Cloud API credentials are not configured.");
            if (!status.webhookConfigured) throw new Error("Webhook verification is not configured. Set WHATSAPP_APP_SECRET and WHATSAPP_WEBHOOK_VERIFY_TOKEN before enabling Live mode.");
            data.mode = "live";
            if (!persistWhatsApp()) {
                data.mode = "demo";
                target.value = "demo";
                return;
            }
            render();
            toast("Live mode enabled. Messages will use Meta Cloud API.");
        } catch (error) {
            target.value = "demo";
            toast(error.message || "Live mode could not be enabled.", "error");
        }
    } else {
        data.mode = "demo";
        if (!persistWhatsApp()) return;
        render();
        toast("Demo mode enabled. No real messages will be sent.");
    }
}

export async function handleWhatsAppAction(action, element, render) {
    const data = ensureWhatsAppState();
    if (action === "whatsapp-select") {
        data.activeMemberId = element.dataset.id;
        mobileConversationOpen = true;
        const conversation = data.conversations.find((item) => item.memberId === data.activeMemberId);
        if (conversation) conversation.unread = 0;
        if (persistWhatsApp()) render();
        return;
    }
    if (action === "whatsapp-back") {
        mobileConversationOpen = false;
        render();
        document.querySelector(".wa-contact.selected")?.focus();
        return;
    }
    if (action === "whatsapp-close") {
        mobileConversationOpen = false;
        document.body.classList.remove("whatsapp-fullscreen");
        const overviewLink = document.querySelector('.nav-link[data-view="overview"]');
        overviewLink?.click();
        return;
    }
    if (action === "whatsapp-add-chat") {
        const memberId = document.querySelector("#whatsapp-member")?.value;
        const member = getMember(memberId);
        if (!member) return toast("Choose a member first.", "error");
        conversationFor(data, member);
        mobileConversationOpen = true;
        if (persistWhatsApp()) render();
        return;
    }
    if (action === "whatsapp-save-settings") {
        const input = document.querySelector("#whatsapp-api-url");
        try {
            const parsed = new URL(input.value);
            if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Use an http or https backend URL.");
            if (persistWhatsApp()) { render(); toast("WhatsApp backend URL saved."); }
        } catch (error) {
            toast(error.message || "Enter a valid backend URL.", "error");
        }
        return;
    }
    if (action === "whatsapp-delete-template") {
        if (data.templates.length <= 1) return toast("Keep at least one message template.", "error");
        data.templates = data.templates.filter((template) => template.id !== element.dataset.id);
        if (persistWhatsApp()) { render(); toast("Template removed."); }
        return;
    }
    if (action === "whatsapp-send-card") {
        const member = getMember(element.dataset.id);
        if (!member) return toast("Member was not found.", "error");
        if (data.mode === "live" && !member.whatsappOptIn) return toast("This member has not been marked as opted in. Record consent before sending a live message.", "error");
        const conversation = conversationFor(data, member);
        const plan = getPlan(member.planId);
        const card = { name: member.name, id: member.id, plan: plan?.name || "Membership", expiry: formatDate(member.expiryDate) };
        if (data.mode === "demo") {
            addMessage(conversation, { id: uid("WAM"), direction: "outbound", text: "Membership ID card", card, timestamp: new Date().toISOString(), status: "simulated" });
            if (persistWhatsApp()) { render(); toast("Demo card simulated. It was not sent or delivered."); }
            return;
        }
        try {
            const blob = await createIdCardImage(member, card);
            const result = await request(data, "/send-card", { method: "POST", body: blob, headers: { "Content-Type": "image/png", "X-WhatsApp-To": member.phone, "X-WhatsApp-Caption": `GymPulse membership ID · ${member.id}` } });
            addMessage(conversation, { id: result.id, direction: "outbound", text: "Membership ID card", card, timestamp: result.timestamp || new Date().toISOString(), status: "accepted" });
            try {
                persist(); render(); toast("Meta accepted the ID card request; delivery is not yet confirmed.");
            } catch (error) {
                toast(`Meta accepted the ID card, but browser history could not be saved: ${error.message}`, "error");
            }
        } catch (error) {
            toast(error.message || "WhatsApp ID card send failed.", "error");
        }
        return;
    }
    if (action === "whatsapp-followups") {
        const inactiveMembers = state.members.filter((item) => {
            const visits = state.attendance.filter((record) => record.memberId === item.id).sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt));
            return !visits[0] || daysBetween(visits[0].checkedInAt.slice(0, 10)) >= 14;
        });
        const recipients = data.mode === "live" ? inactiveMembers.filter((item) => item.whatsappOptIn) : inactiveMembers;
        if (!recipients.length) return toast(data.mode === "live" ? "No inactive members with recorded WhatsApp consent are eligible." : "No inactive members need a follow-up.");
        const actionLabel = data.mode === "demo" ? `simulate DEMO follow-ups for ${recipients.length} fictional members` : `send approved-template follow-ups to ${recipients.length} opted-in members`;
        if (!window.confirm(`Proceed to ${actionLabel}? ${data.mode === "demo" ? "No messages will be sent." : "Meta API errors will be shown; acceptance does not mean delivery."}`)) return;
        const template = data.templates.find((item) => item.id === "inactive" || item.metaName.includes("inactive"));
        if (!template) return toast("Add an inactive-member template before running follow-ups.", "error");
        let accepted = 0;
        let failed = 0;
        const errors = [];
        for (const recipient of recipients) {
            const conversationForData = conversationFor(data, recipient);
            if (data.mode === "demo") {
                addMessage(conversationForData, { id: uid("WAM"), direction: "outbound", text: displayText(template, recipient), timestamp: new Date().toISOString(), status: "simulated" });
                accepted += 1;
                continue;
            }
            try {
                const result = await request(data, "/send", { method: "POST", body: JSON.stringify({ to: recipient.phone, type: "template", template: { name: template.metaName, language: { code: template.language }, components: template.variables.length ? [{ type: "body", parameters: templateValues(template, recipient).map((text) => ({ type: "text", text })) }] : [] } }) });
                addMessage(conversationForData, { id: result.id, direction: "outbound", text: displayText(template, recipient), timestamp: result.timestamp || new Date().toISOString(), status: result.status || "accepted" });
                accepted += 1;
                try { persist(); } catch (error) {
                    errors.push(`Meta accepted a follow-up, but browser history could not be saved: ${error.message}`);
                    failed += recipients.length - accepted;
                    break;
                }
            } catch (error) {
                failed += 1;
                errors.push(error.message || "WhatsApp follow-up failed.");
            }
        }
        if (data.mode === "demo") {
            try { persist(); } catch (error) { errors.push(error.message || "Could not save demo follow-ups."); failed += 1; }
        }
        render();
        const summary = data.mode === "demo" ? `${accepted} follow-up messages simulated (DEMO); none were sent.` : `${accepted} accepted by Meta; ${failed} failed. Check webhook statuses for delivery.`;
        toast(`${summary}${errors.length ? ` ${errors[0]}` : ""}`, failed ? "error" : "success");
        return;
    }
    if (action === "whatsapp-refresh") {
        if (data.mode !== "live") return toast("Demo messages are simulated and have no delivery status.");
        try {
            const result = await request(data, "/messages");
            mergeLiveMessages(data, result.messages || []);
            if (persistWhatsApp()) { render(); toast("Live statuses refreshed from backend webhook events."); }
        } catch (error) {
            toast(error.message || "Could not refresh statuses.", "error");
        }
    }
}

function createIdCardImage(member, card) {
    const canvas = document.createElement("canvas");
    canvas.width = 1000;
    canvas.height = 600;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot create a membership ID card image.");
    context.fillStyle = "#12372a";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#b8f36b";
    context.fillRect(45, 45, 910, 510);
    context.fillStyle = "#12372a";
    context.fillRect(60, 60, 880, 480);
    context.fillStyle = "#b8f36b";
    context.font = "700 36px Arial";
    context.fillText("GYMPULSE · MEMBER ID", 100, 145);
    context.fillStyle = "#ffffff";
    context.font = "700 54px Arial";
    context.fillText(member.name.slice(0, 25), 100, 260);
    context.font = "28px Arial";
    context.fillText(`ID: ${member.id}`, 100, 330);
    context.fillText(`Plan: ${String(card.plan).slice(0, 32)}`, 100, 385);
    context.fillText(`Valid through: ${card.expiry}`, 100, 440);
    context.fillStyle = "#b8f36b";
    context.font = "22px Arial";
    context.fillText(String(state.gym.name).slice(0, 38), 100, 500);
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not generate the membership ID card image.")), "image/png"));
}

function templateValues(template, member) {
    return template.variables.map((key) => {
        if (key === "first_name") return member.name.split(/\s+/)[0];
        if (key === "expiry_date") return formatDate(member.expiryDate);
        if (key === "balance") return formatINR(memberBalance(member));
        if (key === "amount") return formatINR(state.payments.find((payment) => payment.memberId === member.id)?.amount || 0);
        if (key === "plan") return getPlan(member.planId)?.name || "membership";
        return key;
    });
}

export async function handleWhatsAppSubmit(form, render) {
    const data = ensureWhatsAppState();
    if (form.id === "whatsapp-click-template-form") {
        const body = String(new FormData(form).get("body") || "").trim();
        if (!body) return toast("Enter a reminder message.", "error");
        const unknownPlaceholder = [...body.matchAll(/\{([^}]+)\}/g)]
            .map((match) => match[1])
            .find((placeholder) => !["name", "plan", "expiry_date"].includes(placeholder));
        if (unknownPlaceholder) return toast(`Unsupported reminder placeholder: {${unknownPlaceholder}}.`, "error");
        data.expiryReminderTemplate = body;
        if (persistWhatsApp()) {
            render();
            toast("WhatsApp expiry reminder message saved.");
        }
        return;
    }
    if (form.id === "whatsapp-template-form") {
        const values = new FormData(form);
        const name = String(values.get("name") || "").trim();
        const metaName = String(values.get("metaName") || "").trim();
        const language = String(values.get("language") || "en").trim();
        const body = String(values.get("body") || "").trim();
        const variables = String(values.get("variables") || "").split(",").map((value) => value.trim()).filter(Boolean);
        if (!/^[a-z0-9_]{1,100}$/.test(metaName)) return toast("Meta template names must use lowercase letters, numbers and underscores.", "error");
        if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) return toast("Use a valid template language code, such as en or en_US.", "error");
        if (data.templates.some((template) => template.metaName === metaName)) return toast("That Meta template name is already in your list.", "error");
        const placeholders = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
        const uniquePlaceholders = [...new Set(placeholders)].sort((first, second) => first - second);
        if (placeholders.some((number) => number < 1 || number > variables.length) || uniquePlaceholders.some((number, index) => number !== index + 1) || uniquePlaceholders.length !== variables.length) {
            return toast("Provide one variable for each numbered placeholder, in order ({{1}}, {{2}}, ...).", "error");
        }
        data.templates.push({ id: uid("TPL"), name, metaName, language, body, variables });
        if (persistWhatsApp()) { render(); toast("Template added. Live sends require the matching template to be approved by Meta."); } return;
    }
    const member = getMember(form.dataset.memberId);
    if (!member) return toast("Choose a member to message.", "error");
    const values = new FormData(form);
    const message = String(values.get("message") || "").trim();
    const template = data.templates.find((item) => item.id === values.get("templateId"));
    if (data.mode === "live" && !member.whatsappOptIn) return toast("This member has not been marked as opted in. Record consent before sending a live message.", "error");
    const conversation = conversationFor(data, member);
    if (!message && !template) return toast("Enter a message before sending.", "error");
    if (data.mode === "demo") {
        const rendered = template ? displayText(template, member) : message;
        addMessage(conversation, { id: uid("WAM"), direction: "outbound", text: rendered, timestamp: new Date().toISOString(), status: "simulated" });
        if (persistWhatsApp()) { render(); toast("Demo message simulated. It was not sent or delivered."); } return;
    }
    try {
        let payload;
        if (template) {
            if (!/^[a-z0-9_]+$/.test(template.metaName)) throw new Error("The Meta template name must use lowercase letters, numbers and underscores.");
            payload = { to: member.phone, type: "template", template: { name: template.metaName, language: { code: template.language }, components: template.variables.length ? [{ type: "body", parameters: templateValues(template, member).map((text) => ({ type: "text", text })) }] : [] } };
        } else {
            payload = { to: member.phone, type: "text", text: { body: message, preview_url: false } };
        }
        const result = await request(data, "/send", { method: "POST", body: JSON.stringify(payload) });
        addMessage(conversation, { id: result.id, direction: "outbound", text: template ? displayText(template, member) : message, timestamp: result.timestamp || new Date().toISOString(), status: result.status || "accepted" });
        try {
            persist(); render(); toast("Meta accepted the message request; delivery is not yet confirmed.");
        } catch (error) {
            toast(`Meta accepted the message, but browser history could not be saved: ${error.message}`, "error");
        }
    } catch (error) {
        toast(error.message || "WhatsApp message failed.", "error");
    }
}

function mergeLiveMessages(data, messages) {
    const activeMemberId = data.activeMemberId;
    messages.forEach((remote) => {
        const phone = remote.direction === "inbound" ? remote.from : remote.recipient;
        const member = state.members.find((item) => normalizePhone(item.phone) === normalizePhone(phone));
        if (!member) return;
        let conversation = data.conversations.find((item) => item.memberId === member.id);
        if (!conversation) {
            conversation = { memberId: member.id, unread: 0, messages: [] };
            data.conversations.unshift(conversation);
        }
        const existing = conversation.messages.find((item) => item.id === remote.id);
        if (existing) Object.assign(existing, remote);
        else {
            addMessage(conversation, { ...remote, timestamp: remote.timestamp || new Date().toISOString() });
            if (remote.direction === "inbound" && member.id !== activeMemberId) conversation.unread += 1;
        }
    });
    data.activeMemberId = activeMemberId;
}

function normalizePhone(phone) {
    return String(phone || "").replace(/\D/g, "").replace(/^0+/, "");
}
