---
name: sql-style
description: House SQL formatting style (lowercase, 4-space indent, one clause/column per line). Read before writing or editing any SQL.
---

# SQL style

- All lowercase — keywords, functions, aliases, types (`select`, `count`, `coalesce`, `integer`)
- 4-space indentation
- Clause keywords (`select`, `from`, `where`, `group by`, `order by`, `having`, `limit`) on their own line at base indent; their contents indented one level below
- Joins at the same indent level as the first table inside the `from` block
- One column/expression per line in `select`, `order by`, `group by`
- One condition per line in `where` (with `and`/`or` at line start, indented)
- Trailing commas
- Quoted aliases in lowercase (`"bad fit"`, not `"Bad fit"`)
- `distinct on` indented under `select`, not on the keyword line
- CTEs: `with name as (` then body indented, closing `)` at CTE indent level

```sql
with team_sizes as (
    select
        distinct on (c.organisation_id)
        c.organisation_id,
        te.teamsize
    from
        trial_enquiry te
        join contact c on c.rt_id = te.rt_id
    where
        te.teamsize is not null
    order by
        c.organisation_id,
        te.created_at asc
)
select
    to_char(md.initial_contact_date, 'yyyy-mm') as date_created_month,
    count(*) filter (where o.lead_status = 'bad_fit') as "bad fit",
    count(*) as "grand total"
from
    merged_deal md
    join organisation o on o.id = md.organisation_id
    left join team_sizes ts on ts.organisation_id = md.organisation_id
group by
    grouping sets (
        (to_char(md.initial_contact_date, 'yyyy-mm')),
        ()
    )
order by
    date_created_month nulls first
```
