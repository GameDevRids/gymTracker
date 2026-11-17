-- Read-only. Run in the Supabase SQL Editor after migration 025. Changes no data.
-- Lists plans whose payments add up to more than their fee (like two ₹1,000 payments on a ₹1,000
-- plan), with every payment on that plan and when it was saved: seconds apart usually means the
-- same payment was saved twice. Void the extra ones from the app (Payments > Void, owner only).
-- Hold fees and voided payments are not counted.

SELECT
    g.name AS gym,
    m.full_name AS member,
    m.member_code,
    mm.plan_name,
    mm.start_date,
    mm.end_date,
    coalesce(mm.total_fees, mm.price) AS fee,
    sum(p.amount) AS paid,
    sum(p.amount) - coalesce(mm.total_fees, mm.price) AS paid_too_much,
    string_agg(
        p.receipt_number || '  ₹' || p.amount || '  ' || p.method
            || '  paid ' || to_char(p.paid_on, 'DD Mon YYYY')
            || '  saved ' || to_char(p.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI:SS'),
        E'\n' ORDER BY p.receipt_number) AS payments
FROM public.payments p
JOIN public.member_memberships mm ON mm.id = p.membership_id AND mm.gym_id = p.gym_id
JOIN public.members m ON m.id = p.member_id AND m.gym_id = p.gym_id
JOIN public.gyms g ON g.id = p.gym_id
WHERE p.kind = 'plan' AND p.status = 'paid'
GROUP BY g.name, m.full_name, m.member_code, mm.id
HAVING sum(p.amount) > coalesce(mm.total_fees, mm.price)
ORDER BY g.name, m.full_name, mm.start_date;

-- Plan payments saved without a plan (possible before migration 025). They can't be checked
-- against a fee; look at them by hand.
SELECT
    g.name AS gym,
    m.full_name AS member,
    m.member_code,
    p.receipt_number,
    p.amount,
    p.method,
    p.paid_on,
    to_char(p.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI:SS') AS saved_at
FROM public.payments p
JOIN public.members m ON m.id = p.member_id AND m.gym_id = p.gym_id
JOIN public.gyms g ON g.id = p.gym_id
WHERE p.kind = 'plan' AND p.status = 'paid' AND p.membership_id IS NULL
ORDER BY g.name, m.full_name, p.receipt_number;
