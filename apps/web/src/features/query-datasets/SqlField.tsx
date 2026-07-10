// CodeMirror 6 SQL editor for authoring query datasets (ADR 0016). `sql({ dialect: SQLite,
// schema })` gives schema-aware autocomplete: `usage_facts.` offers that table's columns, plus
// SQL keyword completion. `schema` is the table→columns map from GET /api/data/schema. Kept in
// its own module and lazy-loaded by the editor so the DOM-free SSR tests never load CodeMirror.
import { SQLite, sql } from "@codemirror/lang-sql";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";

export function SqlField({
  value,
  onChange,
  schema,
}: {
  value: string;
  onChange: (v: string) => void;
  schema?: Record<string, string[]>;
}) {
  const extensions = useMemo(
    () => [sql({ dialect: SQLite, schema: schema ?? {}, upperCaseKeywords: true })],
    [schema],
  );
  return (
    <CodeMirror
      className="sql-editor"
      value={value}
      height="200px"
      extensions={extensions}
      onChange={onChange}
      basicSetup={{ lineNumbers: true, autocompletion: true, highlightActiveLine: true }}
    />
  );
}
