import fs from "node:fs";
import crypto from "node:crypto";
export function parseDump(text) {
  const re =
    /^-- Name: (.*); Type: (.*); Schema: (.*); Owner: (.*)\r?\n--\r?\n/gm;
  const matches = [...text.matchAll(re)];
  const objects = matches.map((m, i) => ({
    name: m[1],
    type: m[2],
    schema: m[3],
    owner: m[4],
    line: text.slice(0, m.index).split("\n").length,
    sql: text
      .slice(m.index + m[0].length, matches[i + 1]?.index ?? text.length)
      .replace(/^\\.*$/gm, "")
      .replace(/-- PostgreSQL database dump complete/g, "")
      .trim(),
  }));
  if (
    objects.some((x) => /DATA|SEQUENCE SET/.test(x.type)) ||
    /^COPY\s|^INSERT INTO\s|^SELECT pg_catalog.setval/m.test(text)
  )
    throw Error("Dump includes data; refusing to copy or execute.");
  return objects;
}
export const appSchemas = ["public", "private", "app_private"];
export const isApp = (o) =>
  appSchemas.includes(o.schema) ||
  (o.type === "SCHEMA" && appSchemas.includes(o.name)) ||
  (o.type === "EVENT TRIGGER" && o.sql.includes("public.rls_auto_enable()"));
export function sha(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}
