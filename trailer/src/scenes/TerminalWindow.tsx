import { colors } from "../theme";

export const TerminalWindow: React.FC<{
  title: string;
  prompt: string;
  lines: [string, string];
  cursorOn: boolean;
  width: number;
  height: number;
}> = ({ title, prompt, lines, cursorOn, width, height }) => {
  return (
    <div
      style={{
        width,
        height,
        background: colors.terminal,
        border: `1px solid ${colors.border}`,
        borderRadius: 10,
        overflow: "hidden",
        boxShadow: "0 18px 50px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.35)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          height: 28,
          background: "#10151f",
          borderBottom: `1px solid ${colors.border}`,
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span style={{ width: 10, height: 10, borderRadius: 99, background: "#f87171" }} />
        <span style={{ width: 10, height: 10, borderRadius: 99, background: "#fbbf24" }} />
        <span style={{ width: 10, height: 10, borderRadius: 99, background: "#34d399" }} />
        <span
          style={{
            marginLeft: 8,
            fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
            fontSize: 13,
            color: colors.muted,
            letterSpacing: "0.02em",
          }}
        >
          {title}
        </span>
      </div>
      <div
        style={{
          padding: "18px 20px",
          fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
          fontSize: 22,
          lineHeight: 1.45,
          color: colors.text,
        }}
      >
        <div>
          {prompt}
          <span
            style={{
              display: "inline-block",
              width: 12,
              height: 22,
              marginLeft: 6,
              background: colors.blue,
              opacity: cursorOn ? 1 : 0.15,
              verticalAlign: "text-bottom",
            }}
          />
        </div>
        <div style={{ color: colors.muted, marginTop: 10 }}>{lines[0]}</div>
        <div style={{ color: colors.muted, marginTop: 4 }}>{lines[1]}</div>
      </div>
    </div>
  );
};
