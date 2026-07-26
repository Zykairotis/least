import { type ReactNode } from "react";
import {
  Activity, Wrench, Clock, GitBranch, PlugZap, Cpu, ScrollText, Sliders,
  PanelRightClose, Bot, Shield, type LucideIcon,
} from "lucide-react";

export type Section =
  | "overview"
  | "tools"
  | "timeline"
  | "hooks"
  | "connections"
  | "git"
  | "runtime"
  | "logs"
  | "sessions"
  | "agents"
  | "settings";

interface NavItem {
  id: Section;
  label: string;
  icon: LucideIcon;
  group?: string;
  badge?: number | string;
  badgeTone?: "hot" | "danger" | "default";
}

interface ShellProps {
  section: Section;
  onSectionChange: (s: Section) => void;
  connected: boolean;
  streaming?: boolean;
  error?: string | null;
  eventRate?: number;
  serverLabel?: string;
  badges?: Partial<Record<Section, { value: number | string; tone?: "hot" | "danger" | "default" }>>;
  children: ReactNode;
}

const NAV: Array<{ group: string; items: Array<Omit<NavItem, "group">> }> = [
  {
    group: "Observe",
    items: [
      { id: "overview", label: "Overview", icon: Activity },
      { id: "timeline", label: "Timeline", icon: Clock },
      { id: "tools", label: "Tools", icon: Wrench },
      { id: "hooks", label: "Hooks", icon: Shield },
      { id: "logs", label: "Logs", icon: ScrollText },
    ],
  },
  {
    group: "Workspace",
    items: [
      { id: "git", label: "Git", icon: GitBranch },
      { id: "connections", label: "Connections", icon: PlugZap },
      { id: "agents", label: "Agents", icon: Bot },
      { id: "sessions", label: "Sessions", icon: PanelRightClose },
    ],
  },
  {
    group: "System",
    items: [
      { id: "runtime", label: "Runtime", icon: Cpu },
      { id: "settings", label: "Settings", icon: Sliders },
    ],
  },
];

export function Shell({
  section,
  onSectionChange,
  connected,
  streaming,
  error,
  eventRate = 0,
  serverLabel,
  badges = {},
  children,
}: ShellProps) {
  const liveClass = connected ? "ok" : error ? "warn" : "err";
  const liveLabel = connected
    ? streaming
      ? "LIVE"
      : "CONNECTED"
    : error?.startsWith("Reconnecting")
      ? "RECONNECT"
      : "OFFLINE";

  return (
    <div className="app-layout">
      <nav className="sidebar">
        <div className="sidebar-header">
          <div className="brand-row">
            <div className="brand-mark">L</div>
            <div>
              <div className="brand-text">Least</div>
              <div className="brand-sub">Live dashboard</div>
            </div>
          </div>
          <div className={`live-chip ${liveClass}`}>
            <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
            {liveLabel}
            {eventRate > 0 && connected ? ` · ${eventRate}/min` : ""}
          </div>
        </div>

        <div className="sidebar-nav">
          {NAV.map((group) => (
            <div key={group.group}>
              <div className="nav-group-label">{group.group}</div>
              {group.items.map((item) => {
                const Icon = item.icon;
                const badge = badges[item.id];
                return (
                  <button
                    key={item.id}
                    className={`nav-item ${section === item.id ? "active" : ""}`}
                    onClick={() => onSectionChange(item.id)}
                    title={item.label}
                  >
                    <Icon size={16} />
                    <span className="nav-label">{item.label}</span>
                    {badge != null && Number(badge.value) !== 0 && (
                      <span className={`nav-badge ${badge.tone === "danger" ? "danger" : badge.tone === "hot" ? "hot" : ""}`}>
                        {badge.value}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          {serverLabel ? <div className="truncate">{serverLabel}</div> : <div>Waiting for server…</div>}
          <div style={{ marginTop: 4, opacity: 0.75 }}>
            {connected ? "SSE streaming" : "SSE disconnected"}
          </div>
        </div>
      </nav>
      <main className="main-content">{children}</main>
    </div>
  );
}
