import { useState, useEffect, useRef } from "react";
import { FONT, T } from "./tokens";

/**
 * Private notepad — lives entirely in localStorage, never sent to Firebase.
 * Keyed by gameCode + playerId so notes are scoped to each game session.
 */
export function Notepad({
  storageKey,
  open,
  onClose,
  side = "right",
}: {
  storageKey: string;
  open: boolean;
  onClose: () => void;
  side?: "left" | "right";
}) {
  const [text, setText] = useState(() => {
    try { return localStorage.getItem(`notepad:${storageKey}`) ?? ""; }
    catch { return ""; }
  });
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Persist on every change
  useEffect(() => {
    try { localStorage.setItem(`notepad:${storageKey}`, text); }
    catch { /* storage unavailable */ }
  }, [text, storageKey]);

  // Focus textarea when opened
  useEffect(() => {
    if (open) setTimeout(() => taRef.current?.focus(), 60);
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* Panel */}
      <div style={{
        position: "fixed", bottom: 82, [side === "right" ? "right" : "left"]: 20,
        width: 320, zIndex: 201,
        background: "#080808",
        border: "1px solid #333333",
        borderRadius: 14,
        overflow: "hidden",
        boxShadow:
          "0 0 0 1px #333, 0 24px 64px rgba(0,0,0,0.8)",
        display: "flex", flexDirection: "column",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: `1px solid ${T.border}`,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14 }}>📝</span>
            <span style={{
              fontSize: 12, fontWeight: 700, color: T.textPrimary,
              letterSpacing: "0.06em", fontFamily: FONT,
              textTransform: "uppercase",
            }}>My Notepad</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{
              fontSize: 10, color: T.textMuted, fontFamily: FONT,
            }}>
              Only you can see this
            </span>
            <button
              onClick={onClose}
              style={{
                background: "none", border: "none", cursor: "pointer",
                color: T.textMuted, fontSize: 16, lineHeight: 1,
                padding: "2px 4px", borderRadius: 4,
                fontFamily: FONT,
              }}
            >✕</button>
          </div>
        </div>

        {/* Textarea */}
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Jot down clues, guesses, anything...\n\ne.g. Actor? ✓  American? ✓  Alive? ✓"}
          style={{
            width: "100%", boxSizing: "border-box",
            height: 260,
            background: "transparent",
            border: "none", outline: "none",
            resize: "none",
            padding: "14px 16px",
            color: T.textPrimary,
            fontSize: 13, fontFamily: FONT, lineHeight: 1.75,
            letterSpacing: "-0.01em",
          }}
        />

        {/* Footer */}
        <div style={{
          padding: "8px 16px",
          borderTop: `1px solid ${T.border}`,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT }}>
            {text.length} chars
          </span>
          <button
            onClick={() => setText("")}
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: T.textMuted, fontSize: 11, fontFamily: FONT,
              padding: "3px 8px", borderRadius: 5,
              letterSpacing: "0.04em",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = T.red)}
            onMouseLeave={(e) => (e.currentTarget.style.color = T.textMuted)}
          >
            Clear
          </button>
        </div>
      </div>
    </>
  );
}
