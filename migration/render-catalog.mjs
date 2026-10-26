import fs from "node:fs";
export function markdown(c, title) {
  let out = `# ${title}\n\nCatalog of locally executed schema-only DDL. No production records.\n`;
  const tables =
    c.tables ||
    [...new Set(c.columns.map((x) => x.table_schema + "." + x.table_name))].map(
      (x) => ({ schemaname: x.split(".")[0], tablename: x.split(".")[1] }),
    );
  for (const t of tables) {
    const schema = t.schemaname,
      table = t.tablename;
    out += `\n## ${schema}.${table}\n\n| Column | Type | Nullable | Default |\n|---|---|---|---|\n`;
    for (const x of c.columns.filter(
      (x) => x.table_schema === schema && x.table_name === table,
    ))
      out += `| ${x.column_name} | ${x.data_type} | ${x.is_nullable} | ${x.column_default ?? ""} |\n`;
    out += "\nConstraints:\n\n";
    for (const x of c.constraints.filter(
      (x) => x.schema === schema && x.table_name === table,
    ))
      out += `- \`${x.conname}\`: \`${x.definition}\`\n`;
    out += "\nIndexes:\n\n";
    for (const x of c.indexes.filter(
      (x) => x.schemaname === schema && x.tablename === table,
    ))
      out += `- \`${x.indexdef}\`\n`;
  }
  out += "\n## Views\n\n";
  for (const v of c.views || [])
    out += `### ${v.schemaname}.${v.viewname}\n\nOptions: ${JSON.stringify(v.reloptions)}\n\n\`\`\`sql\n${v.definition}\n\`\`\`\n`;
  out += "\n## Functions\n\n";
  for (const f of c.functions || [])
    out += `- \`${f.schema}.${f.proname}(${f.arguments})\`: ${f.result}; SECURITY DEFINER=${f.prosecdef}; volatility=${f.provolatile}; config=${JSON.stringify(f.proconfig)}. Exact body in companion catalog JSON.\n`;
  out += "\n## Triggers and event triggers\n\n";
  for (const t of c.triggers || []) out += `- \`${t.definition}\`\n`;
  for (const t of c.event_triggers || [])
    out += `- \`${t.evtname}\`: ${t.evtevent}; tags=${JSON.stringify(t.evttags)}; function=${t.function}; enabled=${t.evtenabled}.\n`;
  out += "\n## Policies\n\n";
  for (const p of c.policies || [])
    out += `- \`${p.schemaname}.${p.tablename}.${p.policyname}\`: ${p.cmd}; roles ${p.roles}; USING \`${p.qual ?? ""}\`; CHECK \`${p.with_check ?? ""}\`.\n`;
  return out.trimEnd() + "\n";
}
if (process.argv[1]?.endsWith("render-catalog.mjs")) {
  const live = JSON.parse(
    fs.readFileSync(new URL("reference/live-catalog.json", import.meta.url)),
  );
  const men = JSON.parse(
    fs.readFileSync(new URL("proposed-schema-catalog.json", import.meta.url)),
  );
  fs.writeFileSync(
    new URL("reference/LIVE_SCHEMA.md", import.meta.url),
    markdown(live, "Authoritative live Sisters application schema"),
  );
  fs.writeFileSync(
    new URL("PROPOSED_SCHEMA.md", import.meta.url),
    markdown(men, "Proposed Men schema — live Sisters foundation"),
  );
  const changed = [];
  for (const s of live.columns) {
    const m = men.columns.find(
      (m) =>
        m.table_schema === s.table_schema &&
        m.table_name === s.table_name &&
        m.column_name === s.column_name,
    );
    if (!m)
      changed.push({
        table: s.table_name,
        column: s.column_name,
        missing: true,
      });
    else if (m.data_type !== s.data_type || m.is_nullable !== s.is_nullable)
      changed.push({
        table: s.table_name,
        column: s.column_name,
        sisters: [s.data_type, s.is_nullable],
        men: [m.data_type, m.is_nullable],
      });
  }
  fs.writeFileSync(
    new URL("schema-diff.json", import.meta.url),
    JSON.stringify(
      {
        reference: "authoritative live dump",
        changed,
        added: men.columns.filter(
          (m) =>
            !live.columns.some(
              (s) =>
                s.table_schema === m.table_schema &&
                s.table_name === m.table_name &&
                s.column_name === m.column_name,
            ),
        ),
      },
      null,
      2,
    ),
  );
}
