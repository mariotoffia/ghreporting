// The `reports` feature shell (the lazy tab App mounts). No router (state/ui.ts), so this
// owns the one sub-navigation the feature needs: the Designer (list/edit) vs the read-only
// ReportView for one opened report. Opening a report is a local id, not a route.
import { useState } from "react";
import { Designer } from "./Designer";
import { ReportView } from "./ReportView";

export function Reports() {
  const [viewing, setViewing] = useState<string | null>(null);
  if (viewing !== null) {
    return <ReportView reportId={viewing} onBack={() => setViewing(null)} />;
  }
  return <Designer onOpen={setViewing} />;
}
