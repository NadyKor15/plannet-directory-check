// Markdown report of an audit result (also used by `audit-directories --render <json>` to re-render without network).
import type { AuditResult } from "./audit.ts";

export function headlineOf(result: AuditResult): string {
  const t = result.totals;
  return `${t.age_policy_published} of ${t.records} public directory records (PractitionerRole + Location) state what patient ages are seen`;
}

export function renderMarkdown(result: AuditResult, command: string): string {
  const zips = result.zips;
  const specialties = result.specialties;
  const day = result.startedAt.slice(0, 10);
  const t = result.totals;
  const errs = (e: Record<string, number>) => Object.entries(e).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(", ") || "0";
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "-");
  const headline = headlineOf(result);

  const md: string[] = [];
  md.push(`# Public provider directory audit — ${day}`);
  md.push("");
  md.push(`- Run: ${result.startedAt} → ${result.finishedAt} (UTC)`);
  md.push(`- Command: \`${command}\``);
  md.push(`- ZIPs: ${zips.join(", ")} · specialties: ${specialties.join(", ")}`);
  md.push(`- Must-light control (same metric code on synthetic records): record with "Ages 3 and up" in newpatients.characteristics counted = **${result.control.synthetic_age_record_counted}**; plain record counted = ${result.control.synthetic_plain_record_counted}`);
  md.push(`- Requests ${t.requests} · errors ${t.errors} (per directory below)`);
  md.push("");
  md.push(`**${headline}.**`);
  md.push("");
  md.push("| Directory | Strategy | Records (roles / locations) | Scene-specialty roles | Age stated | Hours present | Hours conflict | New-patients flag present | New-patients values | Roles with specialty / NPI | NPIs | Roles per NPI (mean / max) | Same NPI+location+network repeated | Requests | Errors |");
  md.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const d of result.directories) {
    md.push(`| ${d.label} | ${d.strategy} | ${d.records} (${d.roles} / ${d.locations}) | ${d.scene_roles} | ${d.age_policy_published} | ${d.hours_present} (${pct(d.hours_present, d.records)}) | ${d.hours_conflict} | ${d.newpatients_present} (${pct(d.newpatients_present, d.records)}) | ${Object.entries(d.newpatients_values).map(([k, v]) => `${k} ${v}`).join(", ") || "-"} | ${d.roles_with_specialty} / ${d.roles_with_npi} of ${d.roles} | ${d.npis} | ${d.roles_per_npi_mean ?? "-"} / ${d.roles_per_npi_max ?? "-"} | ${d.duplicate_role_triples} | ${d.requests} | ${errs({ ...d.errors, ...Object.fromEntries(Object.entries(d.http_status).map(([k, v]) => [`HTTP ${k}`, v])) })} |`);
  }
  md.push(`| **All** | | **${t.records}** (${t.roles} / ${t.locations}) | ${t.scene_roles} | **${t.age_policy_published}** | ${t.hours_present} (${pct(t.hours_present, t.records)}) | ${t.hours_conflict} | ${t.newpatients_present} (${pct(t.newpatients_present, t.records)}) | ${Object.entries(t.newpatients_values).map(([k, v]) => `${k} ${v}`).join(", ")} | | | | | ${t.requests} | ${t.errors} |`);
  md.push("");
  md.push("Per ZIP:");
  md.push("");
  md.push("| Directory | ZIP | Roles | Locations | Failed requests | Truncated | ms |");
  md.push("|---|---|---|---|---|---|---|");
  for (const d of result.directories) for (const z of d.zips) md.push(`| ${d.key} | ${z.zip} | ${z.roles} | ${z.locations} | ${z.failures} | ${z.truncated ? "yes" : "no"} | ${z.ms} |`);
  md.push("");
  if (t.age_examples.length) { md.push("Age wording found (first examples):"); md.push(""); for (const e of t.age_examples) md.push(`- "${e}"`); md.push(""); }
  md.push("Notes per directory:");
  md.push("");
  for (const d of result.directories) {
    const failed = d.records === 0 && d.requests > 0 ? `**not measured in this run: ${d.requests} of ${d.requests} requests failed (${Object.entries(d.http_status).map(([k, v]) => `HTTP ${k} ×${v}`).join(", ") || Object.entries(d.errors).filter(([, v]) => v).map(([k, v]) => `${k} ×${v}`).join(", ")})**; ` : "";
    md.push(`- **${d.key}**: ${failed}${d.notes.join("; ") || "-"}; base ${d.base}`);
  }
  for (const n of result.notOpen) md.push(`- **${n.key}** (not audited, needs registration): ${n.observed}`);
  md.push("");
  if (result.nppes) {
    md.push(`NPPES (individuals, \`postal_code=ZIP&taxonomy_description=…\`): how many results practice elsewhere (their LOCATION address is not in the ZIP) unless \`address_purpose=LOCATION\` is added. Requests ${result.nppes.requests} · errors ${errs(result.nppes.errors)}.`);
    md.push("");
    md.push("| ZIP | Specialty | Results (any address) | Practice elsewhere | Results with address_purpose=LOCATION |");
    md.push("|---|---|---|---|---|");
    for (const r of result.nppes.rows) md.push(`| ${r.zip} | ${r.specialty} | ${r.any_address} | ${r.location_elsewhere} | ${r.location_only} |`);
    const a = result.nppes.rows.reduce((s, r) => s + r.any_address, 0), e = result.nppes.rows.reduce((s, r) => s + r.location_elsewhere, 0);
    md.push(`| **All** | | ${a} | **${e}** (${pct(e, a)}) | ${result.nppes.rows.reduce((s, r) => s + r.location_only, 0)} |`);
    md.push("");
  }
  if (result.qhp) {
    md.push(`Marketplace (QHP) machine-readable indexes for Florida, PY2026 (CMS Machine-readable URL PUF, 26 rows). Requests ${result.qhp.requests} · errors ${errs(result.qhp.errors)}.`);
    md.push("");
    md.push("| Issuer ID | Index URL | Status | Provider files listed |");
    md.push("|---|---|---|---|");
    for (const r of result.qhp.rows) md.push(`| ${r.issuerId} | ${r.url} | ${r.status} | ${r.provider_files ?? "-"} |`);
    md.push("");
  }
  md.push("Definitions: *Age stated* — newpatients.characteristics, comment/description/eligibility/characteristic texts or string extensions match an age pattern (\"ages 3 and up\", \"under 18 years\", \"adults only\", …; see `src/plannet.ts` AGE_PATTERNS). *Hours present* — Location.hoursOfOperation, availableTime, or the Plan-Net contactpoint-availabletime extension. *Hours conflict* — one record carries both hoursOfOperation and available-time and they disagree on a day. A record is one PractitionerRole or one Location resource, counted once per run.");

  return `${md.join("\n")}\n`;
}
