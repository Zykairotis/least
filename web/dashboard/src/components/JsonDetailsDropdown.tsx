import { useState, useCallback } from "react";

interface JsonDetailsDropdownProps {
  label: string;
  data: unknown;
  defaultOpen?: boolean;
  maxPreviewChars?: number;
}

export function JsonDetailsDropdown({ label, data, defaultOpen = false, maxPreviewChars = 200 }: JsonDetailsDropdownProps) {
  const [open, setOpen] = useState(defaultOpen);

  if (data == null) return null;

  const raw = JSON.stringify(data, null, 2);
  const truncated = raw.length > maxPreviewChars
    ? raw.slice(0, maxPreviewChars) + "\n  … (truncated, click to expand)"
    : raw;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(raw).catch(() => {});
  }, [raw]);

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          onClick={() => setOpen(!open)}
          className="btn-filter"
          style={{ fontSize: 10, padding: "1px 6px", fontFamily: "var(--mono)" }}
        >
          {open ? "▼" : "▶"} {label}
        </button>
        <button
          onClick={handleCopy}
          className="btn-filter"
          style={{ fontSize: 10, padding: "1px 6px", marginLeft: "auto" }}
          title="Copy JSON"
        >
          📋
        </button>
      </div>
      {open && (
        <pre style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          lineHeight: 1.4,
          color: "var(--text-muted)",
          background: "var(--bg-3)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          padding: 8,
          marginTop: 4,
          overflow: "auto",
          maxHeight: 300,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}>
          {raw.length > maxPreviewChars && !open ? truncated : raw}
        </pre>
      )}
    </div>
  );
}
