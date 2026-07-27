// PrioritySelect: the one way a notification priority is picked, shared
// by the rules panel and the sidebar context menus so a rule reads the
// same wherever it's made. "default" (when offered) means the absence of
// an override -- picking it deletes the rule, reported as null.

import { PRIORITY_LABELS, isPriority, type Priority } from "../notify/rules";

interface Props {
  value: Priority | null;
  // Offer the "default" option. Omitted for rows that always have a
  // priority (the panel's per-event-type defaults).
  withDefault?: boolean;
  testid: string;
  onChange: (p: Priority | null) => void;
}

export function PrioritySelect(props: Props) {
  return (
    <select
      class="chalk-notify-priority-select"
      value={props.value === null ? "default" : String(props.value)}
      data-testid={props.testid}
      onChange={(e) => {
        const v = (e.target as HTMLSelectElement).value;
        if (v === "default") return props.onChange(null);
        const n = Number(v);
        if (isPriority(n)) props.onChange(n);
      }}
    >
      {props.withDefault && <option value="default">default</option>}
      {([0, 1, 2, 3, 4] as const).map((p) => (
        <option key={p} value={String(p)}>
          {PRIORITY_LABELS[p]}
        </option>
      ))}
    </select>
  );
}
