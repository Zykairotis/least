import { type ReactNode } from "react";
import {
  Activity, Wrench, Clock, GitBranch, PlugZap, Cpu, Terminal, Sliders, PanelRightClose, Bot,
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
  icon: ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { id: "overview", label: "Overview", icon: <Activity /> },
  { id: "tools", label: "Tools", icon: <Wrench /> },
  { id: "timeline", label: "Timeline", icon: <Clock /> },
  { id: "hooks", label: "Hooks", icon: <Terminal /> },
  { id: "connections", label: "Connections", icon: <PlugZap /> },
  { id: "git", label: "Git", icon: <GitBranch /> },
  { id: "runtime", label: "Runtime", icon: <Cpu /> },
  { id: "logs", label: "Logs", icon: <Terminal /> },
  { id: "sessions", label: "Sessions", icon: <PanelRightClose /> },
  { id: "agents", label: "Agents", icon: <Bot /> },
  { id: "settings", label: "Settings", icon: <Sliders /> },
];

interface ShellProps {
  section: Section;
  onSectionChange: (s: Section) => void;
  connected: boolean;
  children: ReactNode;
}

export function Shell({ section, onSectionChange, connected, children }: ShellProps) {
  return (
    <div className="app-layout">
      <nav className="sidebar">
        <div className="sidebar-header">
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
            Least
          </span>
        </div>
        <div className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${section === item.id ? "active" : ""}`}
              onClick={() => onSectionChange(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </nav>
      <main className="main-content">
        {children}
      </main>
    </div>
  );
}
