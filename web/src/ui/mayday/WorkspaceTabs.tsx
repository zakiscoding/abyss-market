import { useRef, type ReactNode } from "react";

export const workspaceTabs = ["inbox", "crew", "evidence", "ledger"] as const;
export type WorkspaceTab = typeof workspaceTabs[number];
const labels: Record<WorkspaceTab, string> = { inbox: "Inbox", crew: "Crew", evidence: "Evidence", ledger: "Ledger" };

export function WorkspaceTabs({ active, onChange, attention, children }: {
  active: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
  attention: boolean;
  children: Record<WorkspaceTab, ReactNode>;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <aside className="command-workspace" aria-label="Incident workspace">
      <div className="workspace-heading"><span>COMMAND CENTER</span><small>Investigation workspace</small></div>
      <div className="workspace-tabs" role="tablist" aria-label="Command center panels">
        {workspaceTabs.map((tab, index) => (
          <button key={tab} ref={(node) => { buttons.current[index] = node; }}
            type="button" role="tab" id={`tab-${tab}`} aria-controls={`panel-${tab}`}
            aria-selected={active === tab} tabIndex={active === tab ? 0 : -1}
            onClick={() => onChange(tab)}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowRight") next = (index + 1) % workspaceTabs.length;
              else if (event.key === "ArrowLeft") next = (index + workspaceTabs.length - 1) % workspaceTabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = workspaceTabs.length - 1;
              else return;
              event.preventDefault();
              onChange(workspaceTabs[next]);
              buttons.current[next]?.focus();
            }}>
            {labels[tab]}{tab === "crew" && attention && <span className="tab-attention" aria-label="Approval needed" />}
          </button>
        ))}
      </div>
      {workspaceTabs.map((tab) => (
        <div key={tab} id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}
          tabIndex={0} hidden={active !== tab} className="workspace-content">
          {children[tab]}
        </div>
      ))}
    </aside>
  );
}
