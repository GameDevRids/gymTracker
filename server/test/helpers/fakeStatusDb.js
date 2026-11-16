// A fake database for the member-status service (services/memberStatusService.js): gyms (for the
// gym's rules), members, member_memberships and whatsapp_messages. Filters by eq/is/in, pages with
// range, and records every query so tests can check it stayed inside one gym.

export const statusGym = "00000000-0000-4000-8000-0000000000a1";
export const otherGym = "00000000-0000-4000-8000-0000000000b1";

export function fakeStatusDb({ gyms = { [statusGym]: { expiry_grace_days: 3, lapsed_list_days: 60 } }, members = [], memberships = [], messages = [] } = {}) {
    const tables = {
        gyms: Object.entries(gyms).map(([id, row]) => ({ id, ...row })),
        members: members.map((row) => ({ gym_id: statusGym, archived_at: null, ...row })),
        member_memberships: memberships.map((row) => ({ gym_id: statusGym, status: "assigned", ...row })),
        whatsapp_messages: messages.map((row) => ({ gym_id: statusGym, ...row }))
    };
    const queries = [];
    return {
        tables,
        queries,
        from(table) {
            const query = { table, filters: [] };
            queries.push(query);
            const rows = () => (tables[table] || []).filter((row) => query.filters.every(([kind, column, value]) => (kind === "in" ? value.includes(row[column]) : kind === "is" ? row[column] === value : row[column] === value)));
            const builder = {
                select() { return builder; },
                eq(column, value) { query.filters.push(["eq", column, value]); return builder; },
                is(column, value) { query.filters.push(["is", column, value]); return builder; },
                in(column, values) { query.filters.push(["in", column, values]); return builder; },
                order() { return builder; },
                range(from, to) { return Promise.resolve({ data: rows().slice(from, to + 1), error: null }); },
                maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
                then(resolve, reject) { return Promise.resolve({ data: rows(), error: null }).then(resolve, reject); }
            };
            return builder;
        }
    };
}
